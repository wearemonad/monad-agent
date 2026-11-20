import { describe, expect, test } from "bun:test";
import type { AgentStreamEvent, StreamBatch } from "../../shared/ipc";
import { StreamMultiplexer, type TickTimer } from "./StreamMultiplexer";

/** A multiplexer whose 50 ms tick only fires when the test says so. */
function harness() {
  const sent: StreamBatch[] = [];
  let tick: (() => void) | null = null;
  let armed = 0;
  const timer: TickTimer = {
    set: (cb) => {
      tick = cb;
      armed++;
      return armed;
    },
    clear: () => {
      tick = null;
    },
  };
  const mux = new StreamMultiplexer((b) => sent.push(b), timer);
  return {
    mux,
    sent,
    tick: () => {
      const cb = tick;
      tick = null;
      cb?.();
    },
    armed: () => tick !== null,
  };
}

const delta = (runId: string, text: string): AgentStreamEvent => ({
  kind: "text-delta",
  runId,
  text,
});
const think = (runId: string, text: string): AgentStreamEvent => ({
  kind: "thinking-delta",
  runId,
  text,
});

describe("StreamMultiplexer", () => {
  test("events from several runs go out as one batch per tick", () => {
    const h = harness();
    h.mux.push(delta("a", "1"));
    h.mux.push(delta("b", "x"));
    h.mux.push({ kind: "text", runId: "a", text: "1" });
    expect(h.sent).toHaveLength(0);
    h.tick();
    expect(h.sent).toEqual([
      {
        seq: 1,
        runs: [
          {
            runId: "a",
            events: [delta("a", "1"), { kind: "text", runId: "a", text: "1" }],
          },
          { runId: "b", events: [delta("b", "x")] },
        ],
      },
    ]);
  });

  test("consecutive deltas of one kind merge; order within a run is kept", () => {
    const h = harness();
    h.mux.push(think("a", "th"));
    h.mux.push(think("a", "ink"));
    h.mux.push(delta("a", "he"));
    h.mux.push(delta("a", "llo"));
    h.mux.push(think("a", "more"));
    h.tick();
    expect(h.sent[0].runs[0].events).toEqual([
      think("a", "think"),
      delta("a", "hello"),
      think("a", "more"),
    ]);
  });

  test("an idle tick sends nothing and no timer stays armed", () => {
    const h = harness();
    expect(h.armed()).toBe(false);
    h.mux.flush();
    expect(h.sent).toHaveLength(0);
  });

  test("lifecycle events flush immediately, with everything queued before them", () => {
    const h = harness();
    h.mux.push(delta("b", "other"));
    h.mux.push(delta("a", "tail"));
    h.mux.push({
      kind: "run-finished",
      runId: "a",
      sessionId: "s",
      numTurns: 1,
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].runs.map((r) => r.runId)).toEqual(["b", "a"]);
    expect(h.sent[0].runs[1].events.map((e) => e.kind)).toEqual([
      "text-delta",
      "run-finished",
    ]);
    expect(h.armed()).toBe(false);
  });

  test("seq increases by one per batch sent", () => {
    const h = harness();
    h.mux.push(delta("a", "1"));
    h.tick();
    h.tick(); // idle: no batch, no seq consumed
    h.mux.push(delta("a", "2"));
    h.mux.flush();
    expect(h.sent.map((b) => b.seq)).toEqual([1, 2]);
  });

  test("merging never mutates an event the caller handed in", () => {
    const h = harness();
    const first = { kind: "text-delta", runId: "a", text: "x" } as const;
    h.mux.push(first);
    h.mux.push(delta("a", "y"));
    h.tick();
    expect(first.text).toBe("x");
  });
});
