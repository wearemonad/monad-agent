import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/ipc";
import { SessionChangeTracker } from "./sessionChanges";

const row = (id: string, updatedAt: string, title = id): SessionSummary => ({
  sessionId: id,
  title,
  updatedAt,
});

describe("SessionChangeTracker", () => {
  test("the first look at a workspace reports every row", () => {
    const t = new SessionChangeTracker();
    const change = t.diff("ws", [row("a", "1"), row("b", "2")]);
    expect(change).toEqual({
      workspaceId: "ws",
      upsert: [row("a", "1"), row("b", "2")],
      remove: [],
    });
  });

  test("a Turn ending reports only the one Thread row that changed", () => {
    const t = new SessionChangeTracker();
    t.diff("ws", [row("a", "1"), row("b", "2"), row("c", "3")]);
    const change = t.diff("ws", [row("b", "9"), row("a", "1"), row("c", "3")]);
    expect(change).toEqual({
      workspaceId: "ws",
      upsert: [row("b", "9")],
      remove: [],
    });
  });

  test("reports deleted Threads by id", () => {
    const t = new SessionChangeTracker();
    t.diff("ws", [row("a", "1"), row("b", "2")]);
    expect(t.diff("ws", [row("a", "1")])).toEqual({
      workspaceId: "ws",
      upsert: [],
      remove: ["b"],
    });
  });

  test("nothing changed → null (nothing to send)", () => {
    const t = new SessionChangeTracker();
    t.diff("ws", [row("a", "1")]);
    expect(t.diff("ws", [row("a", "1")])).toBeNull();
  });

  test("workspaces are tracked independently", () => {
    const t = new SessionChangeTracker();
    t.diff("one", [row("a", "1")]);
    expect(t.diff("two", [row("a", "1")])?.upsert).toEqual([row("a", "1")]);
    expect(t.diff("one", [row("a", "1")])).toBeNull();
  });
});
