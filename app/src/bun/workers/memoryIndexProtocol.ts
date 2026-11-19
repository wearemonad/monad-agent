import type { MemoryHit, MemorySourceType } from "../../shared/memory";
import type { DocFacts } from "../services/knowledgeGraph";
import type { CapturedExchange } from "../services/memoryCapture";
import type { Chunk, SessionSource } from "../services/MemoryIndexService";
import type { EmbedderStatus } from "../services/OnnxEmbedder";

/** The messages between the MemoryIndex façade (main thread) and
 *  memoryIndex.worker.ts. Every request gets exactly one response with its
 *  id. Plain data only — it crosses the thread boundary by structured clone. */
export type MemoryIndexOps = {
  /** First message: which embedder the worker runs ("none" = keyword-only). */
  init: { args: { embedder: "onnx" | "none" }; result: null };
  /** syncKnowledge, then syncSessions when `sessions` is given, then a
   *  detached embedding backfill. */
  sync: {
    args: { wsPath: string; sessions?: SessionSource[]; skip?: string[] };
    result: { graphChanged: boolean };
  };
  search: {
    args: {
      wsPath: string;
      query: string;
      opts: { limit?: number; scope?: MemorySourceType };
    };
    result: MemoryHit[];
  };
  sessionChunks: {
    args: { wsPath: string; sessionId: string };
    result: Chunk[];
  };
  graphDocs: {
    args: { wsPath: string };
    result: { path: string; facts: DocFacts }[];
  };
  /** Read a Session JSONL and condense its final exchange (memoryCapture). */
  condense: {
    args: { jsonlPath: string; date: string };
    result: CapturedExchange | null;
  };
  status: {
    args: Record<string, never>;
    result: { embedder: EmbedderStatus; lastError: string };
  };
  /** Close every database; the façade terminates the worker after. */
  dispose: { args: Record<string, never>; result: null };
};

export type MemoryIndexOp = keyof MemoryIndexOps;

export type MemoryIndexRequest = {
  [K in MemoryIndexOp]: { id: number; op: K; args: MemoryIndexOps[K]["args"] };
}[MemoryIndexOp];

export type MemoryIndexResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
