import { describe, expect, test } from "bun:test";
import {
  contextWindowFor,
  controlsFor,
  providerRuntime,
  resolveRunOptions,
  runOptionsLabel,
  threadBinding,
} from "./models";

describe("threadBinding", () => {
  const sessions = [
    { sessionId: "claude-1", title: "A" },
    {
      sessionId: "codex-1",
      title: "B",
      runtime: "codex" as const,
      provider: "openai-subscription" as const,
      model: "gpt-6-astra",
    },
  ];

  test("a new chat is unbound", () => {
    expect(threadBinding(null, sessions)).toBeNull();
  });

  test("a thread not listed yet is unbound rather than guessed", () => {
    expect(threadBinding("just-created", sessions)).toBeNull();
  });

  test("listed threads bind to their runtime", () => {
    expect(threadBinding("claude-1", sessions)).toEqual({ runtime: "claude" });
    expect(threadBinding("codex-1", sessions)).toEqual({
      runtime: "codex",
      provider: "openai-subscription",
      model: "gpt-6-astra",
    });
  });
});

describe("providerRuntime", () => {
  test("Ollama shares the Claude runtime; OpenAI providers run on Codex", () => {
    expect(providerRuntime("subscription-cli")).toBe("claude");
    expect(providerRuntime("local-ollama")).toBe("claude");
    expect(providerRuntime("openai-api-key")).toBe("codex");
  });
});

describe("run options", () => {
  const opus = controlsFor("subscription-cli", "claude-opus-5-5")!;
  const sonnet = controlsFor("api-key", "claude-sonnet-5-5")!;
  const luna = controlsFor("openai-api-key", "gpt-6-luna")!;

  test("each model offers its own sections", () => {
    expect(opus.speed?.title).toBe("Fast Mode");
    expect(sonnet.speed).toBeUndefined();
    expect(luna.context).toBeUndefined();
    expect(luna.speed?.title).toBe("Service Tier");
    expect(controlsFor("local-ollama", "qwen3.5:35b")).toBeNull();
  });

  test("unset picks fall back to the model's defaults", () => {
    expect(resolveRunOptions(opus, undefined)).toEqual({
      effort: "medium",
      context: "1m",
      speed: "standard",
    });
    expect(resolveRunOptions(sonnet, {})).toEqual({
      effort: "high",
      context: "1m",
    });
  });

  test("a level the model doesn't offer is replaced by its default", () => {
    // "ultra" exists on Astra, not on Luna.
    expect(resolveRunOptions(luna, { effort: "ultra" })?.effort).toBe("medium");
    expect(resolveRunOptions(opus, { effort: "max", context: "200k" })).toEqual(
      { effort: "max", context: "200k", speed: "standard" },
    );
  });

  test("trigger label names the picks", () => {
    expect(
      runOptionsLabel(opus, { effort: "high", context: "1m", speed: "fast" }),
    ).toBe("High · 1M · Fast");
    expect(runOptionsLabel(luna, { effort: "xhigh", speed: "standard" })).toBe(
      "Extra High",
    );
  });

  test("Terra is offered on both OpenAI providers", () => {
    expect(controlsFor("openai-subscription", "gpt-5.6-terra")).not.toBeNull();
    expect(controlsFor("openai-api-key", "gpt-5.6-terra")).not.toBeNull();
  });

  test("the 200k pick shrinks the known context window", () => {
    expect(contextWindowFor("api-key", "claude-opus-5-5")).toBe(1_000_000);
    expect(
      contextWindowFor("api-key", "claude-opus-5-5", { context: "200k" }),
    ).toBe(200_000);
  });
});
