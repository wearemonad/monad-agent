import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentStreamEvent, SessionSummary } from "../shared/ipc";
import type { createMessageHandlers as Create } from "./messageHandlers";
import type { useStore as UseStore } from "./store";

let useStore: typeof UseStore;
let createMessageHandlers: typeof Create;

beforeAll(async () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  ({ useStore } = await import("./store"));
  ({ createMessageHandlers } = await import("./messageHandlers"));
});

/** Handlers wired to spies; `listRequests` counts every list/snapshot RPC
 *  the webview would send. Frames never run on their own — `frame()` does. */
function harness() {
  let listRequests = 0;
  let frame: (() => void) | null = null;
  const { handlers } = createMessageHandlers({
    refreshSidebar: async () => {
      listRequests++;
    },
    getSettings: () => {},
    refreshOllama: () => {},
    zoom: () => {},
    scheduler: {
      requestFrame: (cb) => {
        frame = cb;
        return 1;
      },
      cancelFrame: () => {
        frame = null;
      },
      setTimer: () => 2,
      clearTimer: () => {},
    },
  });
  return {
    handlers,
    listRequests: () => listRequests,
    frame: () => frame?.(),
  };
}

const row = (id: string, updatedAt: string): SessionSummary => ({
  sessionId: id,
  title: id,
  updatedAt,
});

describe("webview message handlers", () => {
  test("a finished Turn produces no list RPCs — only targeted pushes", () => {
    const h = harness();
    const store = useStore.getState();
    store.newChat();
    store.registerRun("turn-1");
    store.setRun("running", "turn-1");
    const events: AgentStreamEvent[] = [
      { kind: "run-started", runId: "turn-1", sessionId: "s-1" },
      { kind: "text", runId: "turn-1", text: "done" },
      {
        kind: "run-finished",
        runId: "turn-1",
        sessionId: "s-1",
        numTurns: 1,
      } as AgentStreamEvent,
    ];
    for (const e of events) h.handlers.streamEvent(e);
    h.handlers.sessionsChanged({
      changes: [{ workspaceId: "ws", upsert: [row("s-1", "2")], remove: [] }],
    });
    expect(h.listRequests()).toBe(0);
    // run-finished flushed the buffer itself: the Turn is over in the store
    expect(useStore.getState().runState).toBe("idle");
    expect(useStore.getState().allSessions.ws).toEqual([row("s-1", "2")]);
  });

  test("stream events wait for the frame and land as one update", () => {
    const h = harness();
    const store = useStore.getState();
    store.newChat();
    store.registerRun("turn-2");
    store.setRun("running", "turn-2");
    let updates = 0;
    const unsub = useStore.subscribe(() => updates++);
    h.handlers.streamEvent({ kind: "text-delta", runId: "turn-2", text: "a" });
    h.handlers.streamEvent({ kind: "text-delta", runId: "turn-2", text: "b" });
    expect(updates).toBe(0);
    h.frame();
    unsub();
    expect(updates).toBe(1);
    expect(useStore.getState().streamingText).toBe("ab");
  });

  test("a permission request applies the stream events before it first", () => {
    const h = harness();
    const store = useStore.getState();
    store.newChat();
    store.registerRun("turn-3");
    store.setRun("running", "turn-3");
    h.handlers.streamEvent({
      kind: "tool-call",
      runId: "turn-3",
      toolUseId: "t1",
      name: "Write",
      inputSummary: "x",
    } as AgentStreamEvent);
    h.handlers.permissionRequest({
      requestId: "p1",
      runId: "turn-3",
    } as any);
    const s = useStore.getState();
    expect(s.items.some((i) => i.type === "tool")).toBe(true);
    expect(s.permissionQueue.some((r) => r.requestId === "p1")).toBe(true);
  });
});
