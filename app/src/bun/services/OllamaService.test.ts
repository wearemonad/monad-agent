import { describe, expect, test } from "bun:test";
import {
  buildLocalModels,
  buildRecommended,
  bytesToGb,
  installedFit,
  pullProgress,
  recommendedFit,
} from "./OllamaService";
import { LocalOllamaAuth } from "../auth/AuthStrategy";

describe("fit heuristics", () => {
  test("small model on a big Mac runs well", () => {
    expect(installedFit(5.2, 64).fit).toBe("good");
  });

  test("mid model on a mid Mac is tight", () => {
    // 21 GB weights + headroom on 32 GB: past the 55% comfort line, inside 80%
    expect(installedFit(21, 32).fit).toBe("tight");
  });

  test("big model on a small Mac is flagged too big", () => {
    const { fit, fitHint } = installedFit(21, 16);
    expect(fit).toBe("too-big");
    expect(fitHint).toContain("GB Mac");
  });

  test("recommended fit uses the vendor RAM floor", () => {
    expect(recommendedFit(16, 32).fit).toBe("good"); // 2× headroom
    expect(recommendedFit(32, 32).fit).toBe("tight"); // exactly at floor
    const { fit, fitHint } = recommendedFit(32, 16);
    expect(fit).toBe("too-big");
    expect(fitHint).toBe("needs 32 GB RAM — this Mac has 16 GB");
  });
});

describe("status building", () => {
  test("installed models get sizes and fit verdicts", () => {
    const models = buildLocalModels(
      [
        {
          name: "qwen3:8b",
          size: 5.2 * 1024 ** 3,
          details: { parameter_size: "8.2B" },
        },
        { name: "qwen3.5:35b", size: 21 * 1024 ** 3 },
      ],
      16,
    );
    expect(models[0]).toMatchObject({
      id: "qwen3:8b",
      sizeGb: 5.2,
      paramSize: "8.2B",
      fit: "good",
    });
    expect(models[1].fit).toBe("too-big");
  });

  test("recommended list marks installed tags including variants", () => {
    const rec = buildRecommended(["qwen3:8b-q4_K_M", "gpt-oss:20b"], 32);
    const byId = Object.fromEntries(rec.map((r) => [r.id, r]));
    expect(byId["qwen3:8b"].installed).toBe(true);
    expect(byId["gpt-oss:20b"].installed).toBe(true);
    expect(byId["qwen3.5:35b"].installed).toBe(false);
  });

  test("bytesToGb rounds to one decimal", () => {
    expect(bytesToGb(5 * 1024 ** 3 + 55 * 1024 ** 2)).toBe(5.1);
  });
});

describe("pull progress parsing", () => {
  test("reports whole-percent steps only", () => {
    expect(
      pullProgress({ status: "pulling", total: 1000, completed: 500 }, -1),
    ).toEqual({
      status: "pulling",
      percent: 50,
    });
    expect(
      pullProgress({ status: "pulling", total: 1000, completed: 504 }, 50),
    ).toBeNull();
  });

  test("status-only lines pass through, blank ones don't", () => {
    expect(pullProgress({ status: "verifying sha256" }, 99)).toEqual({
      status: "verifying sha256",
    });
    expect(pullProgress({}, 10)).toBeNull();
  });

  test("server-reported errors throw", () => {
    expect(() =>
      pullProgress({ error: "pull model manifest: file does not exist" }, -1),
    ).toThrow("manifest");
  });
});

describe("LocalOllamaAuth", () => {
  const runtime = (installed: boolean) => ({
    isInstalled: () => installed,
    ensureRunning: async () => {},
  });

  test("validate demands an install and a chosen model", () => {
    expect(() =>
      new LocalOllamaAuth(
        () => "qwen3:8b",
        runtime(false),
        "http://x",
      ).validate(),
    ).toThrow(/Ollama isn't installed/);
    expect(() =>
      new LocalOllamaAuth(
        () => undefined,
        runtime(true),
        "http://x",
      ).validate(),
    ).toThrow(/No local model/);
    expect(() =>
      new LocalOllamaAuth(
        () => "qwen3:8b",
        runtime(true),
        "http://x",
      ).validate(),
    ).not.toThrow();
  });

  test("sdkOptions points every model slot at the local default", () => {
    const env = new LocalOllamaAuth(
      () => "qwen3:8b",
      runtime(true),
      "http://localhost:11434",
    ).sdkOptions().env!;
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(env.ANTHROPIC_MODEL).toBe("qwen3:8b");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("qwen3:8b");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
  });
});
