import { beforeAll, describe, expect, test } from "bun:test";
import { FakeAgentSession } from "../bun/dev/FakeAgentSession";
import type { AgentStreamEvent } from "../shared/ipc";
import type {
  activeThread as ActiveThread,
  ThreadState,
  useStore as UseStore,
} from "./store";

/** Store cost per update (PARALLEL-THREADS-PR1-MEASURE.html §5): replay
 *  10 000 stream events spread over 10 Threads into applyEvent. Later PRs add
 *  their own guarantees here (PR 3: toBlocks keeps block identity; PR 4: a
 *  switch to an in-memory Thread makes no RPC — store.threads.test.ts). */

const THREADS = 10;
const EVENTS = 10_000;
/** Generous: a clean run takes ~30 ms on an M-series Mac, so this catches a
 *  10×+ regression while leaving room for a slower CI runner. */
const BUDGET_MS = 400;

/** Every field of a Thread the visible chat reads. */
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
  loaded: true,
  pending: true,
  stale: true,
  scrollOffset: true,
} satisfies Record<keyof ThreadState, true>;
const sliceKeys = Object.keys(VISIBLE_SLICES) as (keyof ThreadState)[];

let useStore: typeof UseStore;
let activeThread: typeof ActiveThread;
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
  ({ useStore, activeThread } = await import("./store"));

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
  // Other test files share this store module: start from no other threads.
  useStore.setState({ threads: {}, runThreads: {}, runningSessions: {} });
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
    const { threads } = useStore.getState();
    expect(activeThread(useStore.getState()).items.length).toBeGreaterThan(0);
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
      const before = activeThread(useStore.getState());
      useStore.getState().applyEvent(e);
      const after = activeThread(useStore.getState());
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

describe("one store update per stream batch (PR 3g / 4b)", () => {
  /** The store's observable result, minus the per-setup random thread keys. */
  const freshSetup = setup;
  const outcome = () => {
    const s = useStore.getState();
    return {
      visible: sliceKeys.map((k) => activeThread(s)[k]),
      background: Object.entries(s.threads)
        .filter(([k]) => k !== s.activeThreadId)
        .map(([, t]) => t.items.length),
      runningSessions: s.runningSessions,
      unread: s.unreadSessions,
    };
  };

  test("applyEvents(batch) ends where applying each event in turn ends", () => {
    const events = freshSetup().slice(0, 2_000);
    for (const e of events) useStore.getState().applyEvent(e);
    const oneByOne = outcome();
    freshSetup();
    useStore.getState().applyEvents(events);
    expect(outcome()).toEqual(oneByOne);
  });

  test("a whole batch notifies subscribers once", () => {
    const events = setup().slice(0, 500);
    let updates = 0;
    const unsub = useStore.subscribe(() => updates++);
    useStore.getState().applyEvents(events);
    unsub();
    expect(updates).toBe(1);
  });
});

describe("no history re-fetch for Threads in memory (PR 3d)", () => {
  test("switchToThread restores a background Thread's live snapshot", () => {
    const events = setup();
    useStore.getState().applyEvents(events);
    const target = Object.values(useStore.getState().threads).find(
      (t) => t.resumeSessionId === "session-3",
    );
    expect(target).toBeDefined();
    expect(useStore.getState().switchToThread("session-3")).toBe(true);
    const s = activeThread(useStore.getState());
    expect(s.resumeSessionId).toBe("session-3");
    expect(s.items).toBe(target!.items);
  });

  test("a Thread not in memory reports false (the caller fetches history)", () => {
    expect(useStore.getState().switchToThread("never-opened")).toBe(false);
  });
});

describe("stable transcript blocks (PR 3e)", () => {
  let toBlocks: typeof import("./transcriptBlocks").toBlocks;
  beforeAll(async () => {
    ({ toBlocks } = await import("./transcriptBlocks"));
  });

  test("appending an item keeps every earlier block reference-equal", () => {
    const events = setup();
    let prevItems = activeThread(useStore.getState()).items;
    let prev = toBlocks(prevItems);
    let appends = 0;
    for (const e of events) {
      useStore.getState().applyEvent(e);
      const items = activeThread(useStore.getState()).items;
      if (items === prevItems) continue;
      const blocks = toBlocks(items, prev);
      // An append can grow the last block or add one; a tool result
      // replaces one item in place. Everything before is untouched.
      const changedAt = items.findIndex((it, i) => it !== prevItems[i]);
      for (let b = 0; b < prev.length - 1; b++) {
        const block = prev[b];
        const lastIdx =
          block.kind === "activity"
            ? items.indexOf(block.entries[block.entries.length - 1])
            : items.indexOf(block.item);
        if (lastIdx !== -1 && lastIdx < changedAt)
          expect(blocks[b]).toBe(block);
      }
      if (changedAt === prevItems.length) appends++;
      prevItems = items;
      prev = blocks;
    }
    expect(appends).toBeGreaterThan(10);
  });
});
