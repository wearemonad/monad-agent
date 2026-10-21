import { describe, expect, test } from "bun:test";
import { OnnxEmbedder, splitVectors } from "./OnnxEmbedder";

describe("splitVectors", () => {
  test("splits a flat [n, dims] tensor into per-text vectors", () => {
    const data = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const out = splitVectors(data, [2, 3], 2)!;
    expect(out).toHaveLength(2);
    expect([...out[0]]).toEqual([1, 2, 3]);
    expect([...out[1]]).toEqual([4, 5, 6]);
  });

  test("vectors are copies, not views into the shared tensor buffer", () => {
    const data = Float32Array.from([1, 2, 3, 4]);
    const out = splitVectors(data, [2, 2], 2)!;
    data[0] = 99;
    expect(out[0][0]).toBe(1);
  });

  test("rejects shape mismatches", () => {
    expect(splitVectors(Float32Array.from([1, 2]), [1, 2], 2)).toBeNull(); // count
    expect(splitVectors(Float32Array.from([1, 2, 3]), [2, 2], 2)).toBeNull(); // length
    expect(splitVectors(Float32Array.from([]), [1], 1)).toBeNull(); // rank
    expect(splitVectors(Float32Array.from([]), [1, 0], 1)).toBeNull(); // zero dims
  });
});

describe("OnnxEmbedder failure handling", () => {
  test("a failed model load reports status and degrades to null", async () => {
    const embedder = new OnnxEmbedder();
    // Point the lazy import at a pipeline that always fails to load.
    (embedder as any).load = () => Promise.reject(new Error("offline"));
    expect(await embedder.embed(["hi"], "query")).toBeNull();
  });

  test("empty input needs no model at all", async () => {
    const embedder = new OnnxEmbedder();
    expect(await embedder.embed([], "document")).toEqual([]);
    expect(embedder.status).toBe("idle");
  });

  test("modelId is the q8 identity, not the Ollama-era one", () => {
    // Existing DBs re-embed once: q8 vectors aren't comparable with f16.
    expect(new OnnxEmbedder().modelId()).toBe("nomic-embed-text-v1.5-onnx-q8");
    expect(new OnnxEmbedder().modelId()).not.toBe("nomic-embed-text");
  });
});
