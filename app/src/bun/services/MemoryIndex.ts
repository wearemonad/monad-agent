import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { MemoryHit, MemorySourceType } from "../../shared/memory";
import type {
  MemoryIndexOp,
  MemoryIndexOps,
  MemoryIndexResponse,
} from "../workers/memoryIndexProtocol";
import { KnowledgeGraph } from "./knowledgeGraph";
import type { CapturedExchange } from "./memoryCapture";
import type { Chunk, SessionSource } from "./MemoryIndexService";
import type { EmbedderStatus } from "./OnnxEmbedder";

/** The memory index as the main thread sees it: an async façade over
 *  memoryIndex.worker.ts, which does the indexing, the SQLite writes and the
 *  embedding off bun's main thread (PARALLEL-THREADS-PR2, 2a).
 *
 *  The worker starts lazily on the first call. If it crashes, pending calls
 *  fail (callers already degrade: sync failures are logged, search falls
 *  back), and the next call after a short backoff starts a fresh worker —
 *  once. A second crash leaves the index down until the app restarts. */
export class MemoryIndex {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private crashes = 0;
  private backoff: Promise<void> | null = null;
  private down = false;
  private disposed = false;
  /** Graphs built here from the worker's facts, dropped when a sync says
   *  they changed (or the worker restarts). */
  private graphs = new Map<string, KnowledgeGraph>();

  constructor(
    private opts: {
      embedder: "onnx" | "none";
      /** Injectable for tests; defaults to the bundled worker file. */
      spawn?: () => Worker;
      restartDelayMs?: number;
    },
  ) {}

  /** Freshen knowledge/ and, when given, these Sessions (skipping the ones
   *  with a Turn in flight), then embed new chunks in the background. */
  async sync(
    wsPath: string,
    sessions?: SessionSource[],
    skip?: string[],
  ): Promise<void> {
    const { graphChanged } = await this.call("sync", {
      wsPath,
      sessions,
      skip,
    });
    if (graphChanged) this.graphs.delete(wsPath);
  }

  search(
    wsPath: string,
    query: string,
    opts: { limit?: number; scope?: MemorySourceType } = {},
  ): Promise<MemoryHit[]> {
    return this.call("search", { wsPath, query, opts });
  }

  sessionChunks(wsPath: string, sessionId: string): Promise<Chunk[]> {
    return this.call("sessionChunks", { wsPath, sessionId });
  }

  /** The knowledge graph as of the last sync. */
  async graph(wsPath: string): Promise<KnowledgeGraph> {
    const cached = this.graphs.get(wsPath);
    if (cached) return cached;
    const graph = KnowledgeGraph.build(
      await this.call("graphDocs", { wsPath }),
    );
    this.graphs.set(wsPath, graph);
    return graph;
  }

  /** Read a Session's JSONL and condense its last exchange, in the worker. */
  condenseLastExchange(
    jsonlPath: string,
    date: string,
  ): Promise<CapturedExchange | null> {
    return this.call("condense", { jsonlPath, date });
  }

  status(): Promise<{ embedder: EmbedderStatus; lastError: string }> {
    // No worker yet: nothing has loaded, nothing has failed.
    if (!this.worker)
      return Promise.resolve({ embedder: "idle", lastError: "" });
    return this.call("status", {});
  }

  /** On quit: let the worker close its databases (every write is one
   *  synchronous transaction, so none is left half-done), then let go of it.
   *  Not terminate(): once onnxruntime has loaded in the worker, terminating
   *  it panics Bun (1.3.14, "NAPI FATAL ERROR: napi_create_error", exit 133)
   *  — the process exit that follows quit takes the thread down cleanly. */
  async dispose(timeoutMs = 2_000): Promise<void> {
    if (this.disposed) return;
    const worker = this.worker;
    if (worker) {
      await Promise.race([
        this.call("dispose", {}).catch(() => {}),
        Bun.sleep(timeoutMs),
      ]);
    }
    this.disposed = true;
    this.worker = null;
    // Bun's Worker has unref(); the DOM lib's type (tsconfig) doesn't.
    (worker as (Worker & { unref(): void }) | null)?.unref();
    this.failPending(new Error("The memory index has shut down."));
  }

  private async call<K extends MemoryIndexOp>(
    op: K,
    args: MemoryIndexOps[K]["args"],
  ): Promise<MemoryIndexOps[K]["result"]> {
    if (this.disposed) throw new Error("The memory index has shut down.");
    if (this.backoff) await this.backoff;
    if (this.down) throw new Error("The memory index is unavailable.");
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      worker.postMessage({ id, op, args });
    });
  }

  private start(): Worker {
    const worker = (this.opts.spawn ?? spawnWorker)();
    worker.addEventListener(
      "message",
      (e: MessageEvent<MemoryIndexResponse>) => {
        const res = e.data;
        const waiter = this.pending.get(res.id);
        if (!waiter) return;
        this.pending.delete(res.id);
        if (res.ok) waiter.resolve(res.value);
        else waiter.reject(new Error(res.error));
      },
    );
    // An uncaught error that kills the worker is followed by "close"; that
    // is the crash signal. (Never terminate() it — see dispose.)
    worker.addEventListener("error", (e: ErrorEvent) =>
      console.error(`[memory] index worker error: ${e.message}`),
    );
    worker.addEventListener("close", () => this.crashed(worker, "exited"));
    // Messages are handled in order, so init lands before any request.
    worker.postMessage({
      id: 0,
      op: "init",
      args: { embedder: this.opts.embedder },
    });
    this.worker = worker;
    return worker;
  }

  private crashed(worker: Worker, reason: string): void {
    if (this.worker !== worker) return; // already replaced, or disposed
    this.worker = null;
    this.graphs.clear();
    this.failPending(new Error(`The memory index worker stopped: ${reason}`));
    this.crashes++;
    if (this.crashes > 1) {
      this.down = true;
      console.error(
        `[memory] index worker stopped again (${reason}) — memory search is off until the app restarts`,
      );
      return;
    }
    console.error(`[memory] index worker stopped (${reason}) — restarting`);
    this.backoff = Bun.sleep(this.opts.restartDelayMs ?? 2_000).then(() => {
      this.backoff = null;
    });
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

/** The worker file: built next to the bundled index.js in the app
 *  (scripts/build-workers.ts), the TypeScript source when run from src/. */
function spawnWorker(): Worker {
  const built = new URL("./memoryIndex.worker.js", import.meta.url);
  const url = fs.existsSync(fileURLToPath(built))
    ? built
    : new URL("../workers/memoryIndex.worker.ts", import.meta.url);
  return new Worker(url.href);
}
