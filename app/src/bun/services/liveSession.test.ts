import { describe, expect, test } from "bun:test";
import { makeInputQueue } from "./AgentSession";
import {
  canReuseLiveSession,
  claudeRunConfig,
  jsonlHasMessages,
} from "./AgentService";

// The live-session building blocks: the push-driven input stream feeding a
// streaming-input query, and the reuse decision that keeps warm processes
// bound to the right thread.

describe("makeInputQueue", () => {
  const userMsg = (text: string) => ({
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
  });

  test("messages pushed before iteration starts are yielded in order", async () => {
    const q = makeInputQueue();
    q.push(userMsg("one"));
    q.push(userMsg("two"));
    q.end();
    const texts: unknown[] = [];
    for await (const m of q.stream) texts.push(m.message.content);
    expect(texts).toEqual(["one", "two"]);
  });

  test("a push wakes a waiting consumer", async () => {
    const q = makeInputQueue();
    const got: unknown[] = [];
    const consumer = (async () => {
      for await (const m of q.stream) got.push(m.message.content);
    })();
    await new Promise((r) => setTimeout(r, 10)); // consumer is now awaiting
    q.push(userMsg("late"));
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["late"]);
    q.end();
    await consumer;
  });

  test("end() while waiting terminates the stream", async () => {
    const q = makeInputQueue();
    const consumer = (async () => {
      const seen: unknown[] = [];
      for await (const m of q.stream) seen.push(m);
      return seen;
    })();
    await new Promise((r) => setTimeout(r, 10));
    q.end();
    expect(await consumer).toEqual([]);
  });

  test("a push after end() is refused, never silently dropped", async () => {
    const q = makeInputQueue();
    expect(q.push(userMsg("before"))).toBe(true);
    q.end();
    expect(q.push(userMsg("after"))).toBe(false);
    const texts: unknown[] = [];
    for await (const m of q.stream) texts.push(m.message.content);
    expect(texts).toEqual(["before"]);
  });

  test("end() drains already-queued messages before terminating", async () => {
    const q = makeInputQueue();
    q.push(userMsg("last words"));
    q.end();
    const texts: unknown[] = [];
    for await (const m of q.stream) texts.push(m.message.content);
    expect(texts).toEqual(["last words"]);
  });
});

describe("jsonlHasMessages", () => {
  test("a metadata-only file (the ghost-thread shape) has no messages", () => {
    // Verbatim shape of a real ghost: a prewarm's forked session file that
    // inherited its parent's ai-title and Monad tag but never got a message.
    const ghost = [
      '{"type":"ai-title","aiTitle":"Run morning briefing skill","sessionId":"s1"}',
      '{"type":"tag","tag":"monad:ws1","sessionId":"s1"}',
      '{"type":"mode","mode":"normal","sessionId":"s1"}',
      '{"type":"atis-latch","atis":"","sessionId":"s1"}',
      '{"type":"last-prompt","lastPrompt":"Run it","sessionId":"s1"}',
      '{"type":"queue-operation","operation":"enqueue","sessionId":"s1"}',
    ].join("\n");
    expect(jsonlHasMessages(ghost)).toBe(false);
  });

  test("a file with a persisted conversation has messages", () => {
    const real = [
      '{"type":"ai-title","aiTitle":"Hello","sessionId":"s1"}',
      '{"parentUuid":null,"type":"user","message":{"role":"user","content":"hi"}}',
      '{"parentUuid":"x","type":"assistant","message":{"role":"assistant","content":[]}}',
    ].join("\n");
    expect(jsonlHasMessages(real)).toBe(true);
    expect(jsonlHasMessages("")).toBe(false);
  });
});

describe("canReuseLiveSession", () => {
  const idle = {
    turnRunId: null,
    authId: "subscription-cli",
    sessionId: "",
    resumeOf: "",
  };

  test("fresh prewarmed session serves a fresh thread", () => {
    expect(canReuseLiveSession(idle, { authId: "subscription-cli" })).toBe(
      true,
    );
  });

  test("a session mid-turn is never reused", () => {
    expect(
      canReuseLiveSession(
        { ...idle, turnRunId: "run1" },
        { authId: "subscription-cli" },
      ),
    ).toBe(false);
  });

  test("a provider switch needs a new process", () => {
    expect(canReuseLiveSession(idle, { authId: "api-key" })).toBe(false);
  });

  test("a session that ran a turn serves only its own thread", () => {
    const s = { ...idle, sessionId: "sess-A" };
    expect(
      canReuseLiveSession(s, {
        authId: "subscription-cli",
        resumeSessionId: "sess-A",
      }),
    ).toBe(true);
    expect(
      canReuseLiveSession(s, {
        authId: "subscription-cli",
        resumeSessionId: "sess-B",
      }),
    ).toBe(false);
    // A fresh thread can't ride a session already bound to another thread.
    expect(canReuseLiveSession(s, { authId: "subscription-cli" })).toBe(false);
  });

  test("a session prewarmed for a resume serves that thread before init", () => {
    const s = { ...idle, resumeOf: "sess-A" };
    expect(
      canReuseLiveSession(s, {
        authId: "subscription-cli",
        resumeSessionId: "sess-A",
      }),
    ).toBe(true);
    expect(canReuseLiveSession(s, { authId: "subscription-cli" })).toBe(false);
  });
});

describe("claudeRunConfig", () => {
  test("plain levels pass through as effort", () => {
    expect(claudeRunConfig({ effort: "max" })).toEqual({
      effort: "max",
      fastMode: false,
      ultracode: false,
      ultrathink: false,
      contextKey: "1m",
    });
  });

  test("ultracode is xhigh plus the ultracode flag", () => {
    expect(claudeRunConfig({ effort: "ultracode" })).toMatchObject({
      effort: "xhigh",
      ultracode: true,
      ultrathink: false,
    });
  });

  test("ultrathink is high effort plus the per-turn keyword", () => {
    expect(claudeRunConfig({ effort: "ultrathink" })).toMatchObject({
      effort: "high",
      ultrathink: true,
    });
  });

  test("fast mode and the 200k context are read from the picks", () => {
    expect(
      claudeRunConfig({ effort: "low", speed: "fast", context: "200k" }),
    ).toMatchObject({ fastMode: true, contextKey: "200k" });
  });

  test("no picks (background runs) leave the CLI's defaults alone", () => {
    expect(claudeRunConfig(undefined)).toEqual({
      fastMode: false,
      ultracode: false,
      ultrathink: false,
      contextKey: "1m",
    });
  });
});

// ---- per-turn counts from cumulative num_turns ----

import { liveTurnsDelta } from "./AgentService";

describe("liveTurnsDelta", () => {
  test("cumulative counts become per-turn deltas", () => {
    expect(liveTurnsDelta(0, 3)).toEqual({ delta: 3, total: 3 });
    expect(liveTurnsDelta(3, 5)).toEqual({ delta: 2, total: 5 });
  });

  test("a reset (/clear, crash) falls back to the raw count", () => {
    expect(liveTurnsDelta(5, 2)).toEqual({ delta: 2, total: 2 });
  });

  test("empty queued-completion results (num_turns 0) don't reset the total", () => {
    const empty = liveTurnsDelta(5, 0);
    expect(empty).toEqual({ delta: 0, total: 5 });
    // the next real turn reports only its own turns, not all six
    expect(liveTurnsDelta(empty.total, 6)).toEqual({ delta: 1, total: 6 });
  });
});
