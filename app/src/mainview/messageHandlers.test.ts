import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentStreamEvent, SessionSummary } from "../shared/ipc";
import type { createMessageHandlers as Create } from "./messageHandlers";
import type {
  activeThread as ActiveThread,
  useStore as UseStore,
} from "./store";

let useStore: typeof UseStore;
let activeThread: typeof ActiveThread;
let createMessageHandlers: typeof Create;

beforeAll(async () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  ({ useStore, activeThread } = await import("./store"));
  ({ createMessageHandlers } = await import("./messageHandlers"));
});

/** Handlers wired to spies; `listRequests` counts every list/snapshot RPC
 *  the webview would send, `resynced` every Thread reload asked for. */
function harness() {
  let listRequests = 0;
  const resynced: string[] = [];
  const { handlers } = createMessageHandlers({
    refreshSidebar: async () => {
      listRequests++;
    },
    resyncThread: (sessionId) => resynced.push(sessionId),
    getSettings: () => {},
    refreshOllama: () => {},
    zoom: () => {},
  });
  let seq = 0;
  return {
    handlers,
    listRequests: () => listRequests,
    resynced,
    /** Deliver events as bun would: one streamBatch, next seq. */
    batch: (events: AgentStreamEvent[], skip = 0) => {
      seq += 1 + skip;
      handlers.streamBatch({
        seq,
        runs: [{ runId: events[0].runId, events }],
      });
    },
  };
}

/** A fresh Thread on screen with run `runId` in flight. */
function running(runId: string) {
  const store = useStore.getState();
  store.newChat();
  store.registerRun(runId);
  store.setRun("running", runId);
}

const row = (id: string, updatedAt: string): SessionSummary => ({
  sessionId: id,
  title: id,
  updatedAt,
});

describe("webview message handlers", () => {
  test("a finished Turn produces no list RPCs — only targeted pushes", () => {
    const h = harness();
    running("turn-1");
    h.batch([
      { kind: "run-started", runId: "turn-1", sessionId: "s-1" },
      { kind: "text", runId: "turn-1", text: "done" },
    ]);
    h.batch([
      { kind: "run-finished", runId: "turn-1", sessionId: "s-1", numTurns: 1 },
    ]);
    h.handlers.sessionsChanged({
      changes: [{ workspaceId: "ws", upsert: [row("s-1", "2")], remove: [] }],
    });
    expect(h.listRequests()).toBe(0);
    expect(activeThread(useStore.getState()).runState).toBe("idle");
    expect(useStore.getState().allSessions.ws).toEqual([row("s-1", "2")]);
  });

  test("one streamBatch for several Threads is one store update", () => {
    const h = harness();
    running("bg");
    running("fg");
    let updates = 0;
    const unsub = useStore.subscribe(() => updates++);
    h.handlers.streamBatch({
      seq: 1,
      runs: [
        {
          runId: "fg",
          events: [{ kind: "text-delta", runId: "fg", text: "ab" }],
        },
        {
          runId: "bg",
          events: [{ kind: "text-delta", runId: "bg", text: "zz" }],
        },
      ],
    });
    unsub();
    expect(updates).toBe(1);
    expect(activeThread(useStore.getState()).streamingText).toBe("ab");
    const bg = Object.values(useStore.getState().threads).find(
      (t) => t.activeRunId === "bg",
    );
    expect(bg?.streamingText).toBe("zz");
  });

  test("a permission request lands after the stream events bun sent first", () => {
    const h = harness();
    running("turn-3");
    h.batch([
      {
        kind: "tool-call",
        runId: "turn-3",
        toolUseId: "t1",
        name: "Write",
        inputSummary: "x",
      },
    ]);
    h.handlers.permissionRequest({ requestId: "p1", runId: "turn-3" } as any);
    const s = useStore.getState();
    expect(activeThread(s).items.some((i) => i.type === "tool")).toBe(true);
    expect(s.permissionQueue.some((r) => r.requestId === "p1")).toBe(true);
  });

  test("a missing batch makes a streaming Thread resync when its run ends", () => {
    const h = harness();
    running("turn-4");
    h.batch([{ kind: "run-started", runId: "turn-4", sessionId: "s-4" }]);
    h.batch([{ kind: "text-delta", runId: "turn-4", text: "x" }], 1); // gap
    expect(h.resynced).toEqual([]);
    h.batch([
      { kind: "run-finished", runId: "turn-4", sessionId: "s-4", numTurns: 1 },
    ]);
    expect(h.resynced).toEqual(["s-4"]);
  });

  test("batches in sequence never resync", () => {
    const h = harness();
    running("turn-5");
    h.batch([{ kind: "run-started", runId: "turn-5", sessionId: "s-5" }]);
    h.batch([
      { kind: "run-finished", runId: "turn-5", sessionId: "s-5", numTurns: 1 },
    ]);
    expect(h.resynced).toEqual([]);
  });
});
