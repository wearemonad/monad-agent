import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentStreamEvent, ChatItem } from "../shared/ipc";
import type {
  activeThread as ActiveThread,
  useStore as UseStore,
} from "./store";

/** Per-Thread store (PARALLEL-THREADS-PR4-STORE.html §4b/§4c): every Thread
 *  lives in `threads[id]`, the visible one is just `activeThreadId`. */

let useStore: typeof UseStore;
let activeThread: typeof ActiveThread;

beforeAll(async () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  ({ useStore, activeThread } = await import("./store"));
});

/** Start from one fresh Thread (other test files share the module). */
function resetThreads() {
  useStore.setState({ threads: {}, runThreads: {}, runningSessions: {} });
  useStore.getState().newChat();
}
beforeEach(resetThreads);

const st = () => useStore.getState();
const threadFor = (sessionId: string) =>
  Object.values(st().threads).find((t) => t.resumeSessionId === sessionId);

/** A Turn's worth of events for run r / session s. */
function turn(r: string, s: string, n: number): AgentStreamEvent[] {
  const out: AgentStreamEvent[] = [
    { kind: "run-started", runId: r, sessionId: s },
  ];
  for (let i = 0; i < n; i++) {
    out.push({ kind: "thinking-delta", runId: r, text: `t${i}` });
    out.push({ kind: "text-delta", runId: r, text: `d${i}` });
    if (i % 3 === 0) out.push({ kind: "text", runId: r, text: `block ${i}` });
    if (i % 4 === 0) {
      out.push({
        kind: "tool-call",
        runId: r,
        toolUseId: `${r}-tool-${i}`,
        name: "Read",
        inputSummary: "x",
      });
      out.push({
        kind: "tool-result",
        runId: r,
        toolUseId: `${r}-tool-${i}`,
        output: "ok",
        isError: false,
      });
    }
  }
  out.push({ kind: "usage", runId: r, contextTokens: 10 });
  out.push({ kind: "run-finished", runId: r, sessionId: s, numTurns: 1 });
  return out;
}

/** Open 10 new Threads, each with a run registered (thread 0 on screen). */
function tenRunning(): void {
  for (let i = 9; i >= 0; i--) {
    st().newChat();
    st().registerRun(`run-${i}`);
    st().setRun("running", `run-${i}`);
  }
}

/** Each Thread's observable state, by session, minus random ids. */
function bySession() {
  const out: Record<string, unknown> = {};
  for (const t of Object.values(st().threads)) {
    if (t.resumeSessionId)
      out[t.resumeSessionId] = {
        items: t.items,
        streamingText: t.streamingText,
        streamingThinking: t.streamingThinking,
        runState: t.runState,
        contextUsage: t.contextUsage,
        statusLine: t.statusLine,
      };
  }
  return out;
}

describe("per-Thread reducer", () => {
  test("interleaved batches for 10 Threads end where one-by-one ends", () => {
    const perThread = Array.from({ length: 10 }, (_, i) =>
      turn(`run-${i}`, `s-${i}`, 12),
    );
    const mixed: AgentStreamEvent[] = [];
    for (let n = 0; perThread.some((l) => l[n]); n++)
      for (const l of perThread) if (l[n]) mixed.push(l[n]);

    tenRunning();
    for (const e of mixed) st().applyEvent(e);
    const oneByOne = bySession();

    resetThreads();
    tenRunning();
    for (let i = 0; i < mixed.length; i += 37)
      st().applyEvents(mixed.slice(i, i + 37));
    expect(bySession()).toEqual(oneByOne);
    expect(Object.keys(oneByOne)).toHaveLength(10);
    // one-by-one and batched alike: a background Thread's Turn really ran
    const t3 = oneByOne["s-3"] as { items: ChatItem[]; runState: string };
    expect(t3.runState).toBe("idle");
    expect(t3.items.filter((i) => i.type === "assistant")).toHaveLength(4);
  });

  test("streaming deltas leave the Thread's items reference-equal", () => {
    st().registerRun("r");
    st().applyEvent({ kind: "run-started", runId: "r", sessionId: "s" });
    const items = activeThread(st()).items;
    st().applyEvent({ kind: "text-delta", runId: "r", text: "hi" });
    expect(activeThread(st()).items).toBe(items);
    expect(activeThread(st()).streamingText).toBe("hi");
  });
});

describe("switching Threads", () => {
  test("switching to a loaded Thread changes only activeThreadId", () => {
    tenRunning();
    st().applyEvents(turn("run-3", "s-3", 4).slice(0, 5));
    st().applyEvents(turn("run-5", "s-5", 4).slice(0, 5));
    const before = st().threads;
    expect(st().switchToThread("s-3")).toBe(true);
    const after = st();
    expect(activeThread(after).resumeSessionId).toBe("s-3");
    for (const id of Object.keys(before)) {
      expect(after.threads[id]).toBe(before[id]);
    }
  });

  test("a Thread not in memory reports false (the caller loads it)", () => {
    expect(st().switchToThread("never-opened")).toBe(false);
  });

  test("a Thread being loaded shows unloaded at once, then its history", () => {
    st().startThreadLoad("s-x");
    expect(activeThread(st()).resumeSessionId).toBe("s-x");
    expect(activeThread(st()).loaded).toBe(false);
    const history: ChatItem[] = [{ type: "user", text: "old" }];
    st().openHistory("s-x", history, 42);
    const t = activeThread(st());
    expect(t.loaded).toBe(true);
    expect(t.items).toEqual(history);
    expect(t.contextUsage.tokens).toBe(42);
  });
});

describe("history load race", () => {
  test("events that arrive during the load are neither lost nor duplicated", () => {
    st().startThreadLoad("s-load");
    // the user sends before the history is in: their bubble and the run's
    // first events land on the unloaded Thread
    st().push({ type: "user", text: "new question" });
    st().registerRun("r-load");
    st().setRun("running", "r-load");
    st().applyEvents([
      { kind: "run-started", runId: "r-load", sessionId: "s-load" },
      { kind: "text-delta", runId: "r-load", text: "par" },
      { kind: "text", runId: "r-load", text: "partial" },
    ]);
    st().openHistory(
      "s-load",
      [
        { type: "user", text: "old question" },
        { type: "assistant", text: "old answer" },
      ],
      undefined,
    );
    st().applyEvent({ kind: "text", runId: "r-load", text: "after" });
    expect(activeThread(st()).items).toEqual([
      { type: "user", text: "old question" },
      { type: "assistant", text: "old answer" },
      { type: "user", text: "new question" },
      { type: "assistant", text: "partial" },
      { type: "assistant", text: "after" },
    ]);
    expect(activeThread(st()).runState).toBe("running");
  });

  test("a history that lands after the user moved on is stored, not shown", () => {
    st().startThreadLoad("s-late");
    st().newChat();
    const active = st().activeThreadId;
    st().openHistory("s-late", [{ type: "user", text: "q" }], undefined);
    expect(st().activeThreadId).toBe(active);
    expect(threadFor("s-late")?.loaded).toBe(true);
    expect(threadFor("s-late")?.items).toHaveLength(1);
  });
});

describe("memory bound", () => {
  test("at most 20 idle loaded Threads stay; running and active never go", () => {
    st().registerRun("keep-run");
    st().setRun("running", "keep-run");
    st().applyEvent({
      kind: "run-started",
      runId: "keep-run",
      sessionId: "running",
    });
    for (let i = 0; i < 30; i++) {
      st().openHistory(
        `idle-${i}`,
        [{ type: "user", text: `${i}` }],
        undefined,
      );
    }
    const sessions = Object.values(st().threads).map((t) => t.resumeSessionId);
    expect(sessions).toContain("running");
    expect(sessions).toContain("idle-29"); // the active one
    const idle = Object.values(st().threads).filter(
      (t) => t.runState === "idle" && t !== activeThread(st()),
    );
    expect(idle).toHaveLength(20);
    // least recently used went first
    expect(sessions).not.toContain("idle-0");
    expect(sessions).toContain("idle-28");
  });

  test("a fresh Thread nobody sent anything in is not kept after leaving", () => {
    const fresh = st().activeThreadId;
    st().newChat();
    expect(st().threads[fresh]).toBeUndefined();
  });
});

describe("dropped batches", () => {
  test("a stale Thread asks for a resync when its run ends", () => {
    st().registerRun("r-s");
    st().setRun("running", "r-s");
    st().applyEvent({ kind: "run-started", runId: "r-s", sessionId: "s-s" });
    st().markStreamsStale();
    const resync = st().applyEvents([
      { kind: "run-finished", runId: "r-s", sessionId: "s-s", numTurns: 1 },
    ]);
    expect(resync).toEqual(["s-s"]);
  });
});
