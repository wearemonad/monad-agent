import { beforeAll, describe, expect, test } from "bun:test";
import { FakeAgentSession } from "../bun/dev/FakeAgentSession";
import type { AgentStreamEvent } from "../shared/ipc";
import type { ThreadSnapshot, useStore as UseStore } from "./store";

/** Store cost per update (PARALLEL-THREADS-PR1-MEASURE.html §5): replay
 *  10 000 stream events spread over 10 Threads into applyEvent. Later PRs add
 *  their own guarantees here (PR 3: toBlocks keeps block identity; PR 4: a
 *  switch to an in-memory Thread makes no RPC). */

const THREADS = 10;
const EVENTS = 10_000;
/** Generous: a clean run takes ~30 ms on an M-series Mac, so this catches a
 *  10×+ regression while leaving room for a slower CI runner. */
const BUDGET_MS = 400;

/** Every field of a Thread the visible chat reads from the top level. */
const VISIBLE_SLICES = {
  items: true,
  streamingText: true,
  streamingThinking: true,
  runState: true,
  activeRunId: true,
  resumeSessionId: true,
  contextUsage: true,
  statusLine: true,
  runModel: true,
  composerDraft: true,
  artifacts: true,
  activeArtifact: true,
  artifactPanelOpen: true,
} satisfies Record<keyof ThreadSnapshot, true>;
const sliceKeys = Object.keys(VISIBLE_SLICES) as (keyof ThreadSnapshot)[];

let useStore: typeof UseStore;
/** One recorded fake run (runId "rec"), as the webview receives it. */
let recording: AgentStreamEvent[];

beforeAll(async () => {
  // The store reads its persisted UI prefs at import; bun has no localStorage.
  const mem = new Map<string, string>();
  (globalThis as any).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  ({ useStore } = await import("./store"));

  recording = [];
  const session = new FakeAgentSession({
    runId: "rec",
    sessionId: "rec-session",
    sink: {
      delta: (kind, text) =>
        recording.push({
          kind: kind === "text" ? "text-delta" : "thinking-delta",
          runId: "rec",
          text,
        }),
      emit: (event) => recording.push(event),
    },
    charsPerSecond: 40_000, // 40 characters per delta at a 1 ms tick
    tickMs: 1,
    toolEveryMs: 0,
    maxSteps: 40,
  });
  await session.done;
});

/** The recording, re-addressed to thread i's run and session. */
function eventsFor(i: number): AgentStreamEvent[] {
  return recording.map(
    (e) =>
      ({
        ...e,
        runId: `run-${i}`,
        ...("sessionId" in e ? { sessionId: `session-${i}` } : {}),
      }) as AgentStreamEvent,
  );
}

/** Fresh store with 10 Threads, each with a run registered; thread 0 is the
 *  one on screen. Returns the events round-robin across all threads. */
function setup(): AgentStreamEvent[] {
  const s = useStore.getState();
  for (let i = THREADS - 1; i >= 0; i--) {
    s.newChat();
    useStore.getState().registerRun(`run-${i}`);
    useStore.getState().setRun("running", `run-${i}`);
  }
  const perThread = Array.from({ length: THREADS }, (_, i) =>
    eventsFor(i).slice(0, EVENTS / THREADS),
  );
  const mixed: AgentStreamEvent[] = [];
  for (let n = 0; n < EVENTS / THREADS; n++) {
    for (const list of perThread) if (list[n]) mixed.push(list[n]);
  }
  return mixed;
}

describe("store cost per update", () => {
  test("the recording is long enough to fill 1 000 events per Thread", () => {
    expect(recording.length).toBeGreaterThanOrEqual(EVENTS / THREADS);
  });

  test(`10 000 events over 10 Threads apply within ${BUDGET_MS} ms`, () => {
    const events = setup();
    expect(events).toHaveLength(EVENTS);
    const { applyEvent } = useStore.getState();
    const t0 = performance.now();
    for (const e of events) applyEvent(e);
    const ms = performance.now() - t0;
    console.log(`[store.perf] ${EVENTS} events in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
    // the events really landed: every thread grew its transcript
    const { threads, items } = useStore.getState();
    expect(items.length).toBeGreaterThan(0);
    for (const t of Object.values(threads))
      expect(t.items.length).toBeGreaterThan(0);
  });

  test("events for a background Thread leave the visible Thread's slices untouched", () => {
    const events = setup();
    const visibleRun = "run-0";
    let checked = 0;
    for (const e of events) {
      if (!("runId" in e) || e.runId === visibleRun) {
        useStore.getState().applyEvent(e);
        continue;
      }
      const before = useStore.getState();
      before.applyEvent(e);
      const after = useStore.getState();
      for (const key of sliceKeys) {
        if (after[key] !== before[key]) {
          throw new Error(
            `${e.kind} for ${e.runId} replaced the visible Thread's "${key}"`,
          );
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(EVENTS * 0.8);
  });
});
