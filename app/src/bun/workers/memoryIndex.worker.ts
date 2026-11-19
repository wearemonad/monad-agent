/// <reference lib="webworker" />
import * as fs from "node:fs";
import { condenseLastExchange } from "../services/memoryCapture";
import { MemoryIndexService } from "../services/MemoryIndexService";
import { OnnxEmbedder } from "../services/OnnxEmbedder";
import type {
  MemoryIndexOps,
  MemoryIndexRequest,
  MemoryIndexResponse,
} from "./memoryIndexProtocol";

/** The memory index, off bun's main thread: the knowledge/ walk, Session
 *  reading and chunking, SQLite writes, the ONNX embedder and the embedding
 *  backfill all run here (PARALLEL-THREADS-PR2, 2a). The main thread talks
 *  to it through MemoryIndex (services/MemoryIndex.ts). */

declare const self: Worker;

let embedder: OnnxEmbedder | null = null;
let index = new MemoryIndexService();

type Handlers = {
  [K in keyof MemoryIndexOps]: (
    args: MemoryIndexOps[K]["args"],
  ) => MemoryIndexOps[K]["result"] | Promise<MemoryIndexOps[K]["result"]>;
};

const handlers: Handlers = {
  init: ({ embedder: kind }) => {
    embedder = kind === "onnx" ? new OnnxEmbedder() : null;
    index = new MemoryIndexService(embedder ?? undefined);
    return null;
  },
  sync: ({ wsPath, sessions, skip }) => {
    const graphChanged = index.syncKnowledge(wsPath);
    if (sessions)
      index.syncSessions(wsPath, sessions, { skip: new Set(skip ?? []) });
    // Detached: search works keyword-only meanwhile, and the backfill skips
    // itself if one is already running for this workspace.
    void index.backfillEmbeddings(wsPath).catch((e) => {
      console.error(`[memory] embedding backfill failed: ${errorText(e)}`);
    });
    return { graphChanged };
  },
  search: ({ wsPath, query, opts }) => index.search(wsPath, query, opts),
  sessionChunks: ({ wsPath, sessionId }) =>
    index.sessionChunks(wsPath, sessionId),
  graphDocs: ({ wsPath }) => index.graphDocs(wsPath),
  condense: ({ jsonlPath, date }) =>
    condenseLastExchange(fs.readFileSync(jsonlPath, "utf8"), date),
  status: () => ({
    embedder: embedder?.status ?? "idle",
    lastError: embedder?.lastError ?? "",
  }),
  dispose: () => {
    index.close();
    return null;
  },
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

self.onmessage = async (event: MessageEvent<MemoryIndexRequest>) => {
  const { id, op, args } = event.data;
  let response: MemoryIndexResponse;
  try {
    const handler = handlers[op] as (a: typeof args) => unknown;
    response = { id, ok: true, value: await handler(args) };
  } catch (e) {
    response = { id, ok: false, error: errorText(e) };
  }
  self.postMessage(response);
};
