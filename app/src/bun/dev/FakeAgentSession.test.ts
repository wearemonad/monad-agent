import { describe, expect, test } from "bun:test";
import type { AgentStreamEvent } from "../../shared/ipc";
import { FakeAgentSession } from "./FakeAgentSession";

type Call =
  | { delta: "text" | "thinking"; text: string }
  | { event: AgentStreamEvent };

/** Play a fake run to the end at high speed and record what it sent. */
async function play(opts: { steps: number; charsPerSecond?: number }) {
  const calls: Call[] = [];
  const session = new FakeAgentSession({
    runId: "run-1",
    sessionId: "session-1",
    sink: {
      delta: (kind, text) => calls.push({ delta: kind, text }),
      emit: (event) => calls.push({ event }),
    },
    charsPerSecond: opts.charsPerSecond ?? 200_000,
    tickMs: 1,
    toolEveryMs: 0,
    maxSteps: opts.steps,
  });
  await session.done;
  return calls;
}

const events = (calls: Call[]) =>
  calls.flatMap((c) => ("event" in c ? [c.event] : []));

describe("FakeAgentSession", () => {
  test("announces the run on the thread's session and finishes it last", async () => {
    const evs = events(await play({ steps: 3 }));
    expect(evs[0]).toMatchObject({
      kind: "run-started",
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(evs[evs.length - 1]).toMatchObject({
      kind: "run-finished",
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(evs.filter((e) => e.kind === "run-started")).toHaveLength(1);
  });

  test("every complete block is exactly the deltas streamed before it", async () => {
    const calls = await play({ steps: 6 });
    const streamed = { text: "", thinking: "" };
    let blocks = 0;
    for (const c of calls) {
      if ("delta" in c) {
        streamed[c.delta] += c.text;
      } else if (c.event.kind === "text" || c.event.kind === "thinking") {
        expect(c.event.text).toBe(streamed[c.event.kind]);
        streamed[c.event.kind] = "";
        blocks++;
      }
    }
    expect(blocks).toBeGreaterThanOrEqual(6);
    expect(streamed).toEqual({ text: "", thinking: "" });
  });

  test("tool calls are answered by their own result", async () => {
    const evs = events(await play({ steps: 6 }));
    const calls = evs.filter((e) => e.kind === "tool-call");
    const results = evs.filter((e) => e.kind === "tool-result");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const at = evs.indexOf(call);
      const result = results.find((r) => r.toolUseId === call.toolUseId);
      expect(result).toBeDefined();
      expect(evs.indexOf(result!)).toBeGreaterThan(at);
    }
  });

  test("answers contain markdown that is expensive to render", async () => {
    const evs = events(await play({ steps: 6 }));
    const text = evs
      .flatMap((e) => (e.kind === "text" ? [e.text] : []))
      .join("\n");
    expect(text).toContain("```");
    expect(text).toMatch(/\|\s*-+\s*\|/); // a table divider row
  });

  test("deltas respect the characters-per-second rate", async () => {
    // 2 000 chars/s at a 1 ms tick: no tick may carry more than a few chars
    const calls = await play({ steps: 1, charsPerSecond: 2_000 });
    const sizes = calls.flatMap((c) => ("delta" in c ? [c.text.length] : []));
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(40);
  });

  test("stop() ends the stream without a finish event", async () => {
    const calls: Call[] = [];
    const session = new FakeAgentSession({
      runId: "run-1",
      sessionId: "session-1",
      sink: {
        delta: (kind, text) => calls.push({ delta: kind, text }),
        emit: (event) => calls.push({ event }),
      },
      charsPerSecond: 500,
      tickMs: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    session.stop();
    await session.done;
    const count = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(count);
    expect(events(calls).some((e) => e.kind === "run-finished")).toBe(false);
  });
});
