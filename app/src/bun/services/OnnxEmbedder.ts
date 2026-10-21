import * as os from "node:os";
import * as path from "node:path";
import type { Embedder } from "./MemoryIndexService";

/** In-process embeddings for the memory index: transformers.js running the
 *  quantized ONNX build of nomic-embed-text-v1.5 on the CPU. No external
 *  dependency — every install gets semantic search. The model (~130 MB) is
 *  downloaded once into Application Support on first use; until then (or when
 *  the download fails offline) embed() returns null and search runs
 *  keyword-only, self-healing on a later call.
 *
 *  Same model family and search_query:/search_document: prefixes as the
 *  earlier Ollama backend, re-verified after quantization: correct hits score
 *  ≥ ~0.54, off-topic query maxima ≤ ~0.50 — the index's 0.52 floor and 0.62
 *  strong line hold unchanged. */

/** HF repo the pipeline loads (has official ONNX weights). */
export const ONNX_EMBED_MODEL = "nomic-ai/nomic-embed-text-v1.5";

/** Stored-vector identity. Distinct from the old Ollama id on purpose: q8
 *  vectors aren't bit-comparable with f16 ones, so existing indexes re-embed
 *  once on first launch with this backend. */
const MODEL_ID = "nomic-embed-text-v1.5-onnx-q8";

const PREFIX = {
  query: "search_query: ",
  document: "search_document: ",
} as const;

/** After a failed model load (usually: offline first run), wait this long
 *  before trying again — sync runs often and must not hammer the network. */
const RETRY_AFTER_MS = 5 * 60_000;

export type EmbedderStatus = "idle" | "loading" | "ready" | "failed";

/** Split a flat [n, dims] tensor into per-text vectors. Returns null on any
 *  shape mismatch so callers degrade instead of storing garbage vectors. */
export function splitVectors(
  data: Float32Array,
  dims: number[] | readonly number[],
  expectedCount: number,
): Float32Array[] | null {
  if (dims.length !== 2 || dims[0] !== expectedCount || dims[1] <= 0)
    return null;
  if (data.length !== dims[0] * dims[1]) return null;
  const out: Float32Array[] = [];
  for (let i = 0; i < expectedCount; i++) {
    out.push(data.slice(i * dims[1], (i + 1) * dims[1]));
  }
  return out;
}

function home(): string {
  return process.env.HOME || os.homedir();
}

export class OnnxEmbedder implements Embedder {
  status: EmbedderStatus = "idle";
  lastError = "";
  private failedAt = 0;
  private pipe: Promise<any> | null = null;

  modelId(): string {
    return MODEL_ID;
  }

  /** Lazy singleton pipeline. The library import is dynamic so app startup
   *  never pays for it — the model loads on the first embed (first index
   *  backfill or search), then stays resident. */
  private load(): Promise<any> {
    if (this.pipe) return this.pipe;
    this.status = "loading";
    this.pipe = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      // Model weights live with the app's other state, not the HF default dir.
      env.cacheDir = path.join(
        home(),
        "Library/Application Support/Monad/models",
      );
      const p = await pipeline("feature-extraction", ONNX_EMBED_MODEL, {
        dtype: "q8",
      });
      this.status = "ready";
      return p;
    })();
    this.pipe.catch((e) => {
      this.status = "failed";
      this.lastError = String((e as Error).message ?? e);
      this.failedAt = Date.now();
      this.pipe = null; // a later call retries (after the backoff window)
      console.error(`[embed] model load failed: ${this.lastError}`);
    });
    return this.pipe;
  }

  /** Never throws: any failure returns null and the memory index runs
   *  keyword-only until the model is available. */
  async embed(
    texts: string[],
    kind: "query" | "document",
  ): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];
    if (this.status === "failed" && Date.now() - this.failedAt < RETRY_AFTER_MS)
      return null;
    try {
      const pipe = await this.load();
      const out = await pipe(
        texts.map((t) => PREFIX[kind] + t),
        { pooling: "mean", normalize: true },
      );
      return splitVectors(
        out.data as Float32Array,
        out.dims as number[],
        texts.length,
      );
    } catch (e) {
      this.lastError = String((e as Error).message ?? e);
      return null;
    }
  }
}
