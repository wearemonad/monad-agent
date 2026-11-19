import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../shared/ipc";
import { toBlocks } from "./transcriptBlocks";

// Block reuse while a transcript streams: store.perf.test.ts (PR 3e).
describe("toBlocks", () => {
  test("an unchanged transcript returns the previous block list itself", () => {
    const items: ChatItem[] = [
      { type: "user", text: "hi" },
      { type: "assistant", text: "hello" },
    ];
    const blocks = toBlocks(items);
    expect(toBlocks(items, blocks)).toBe(blocks);
  });

  test("a changed tool result rebuilds only its activity block", () => {
    const user: ChatItem = { type: "user", text: "go" };
    const tool: ChatItem = {
      type: "tool",
      toolUseId: "t1",
      name: "Read",
      inputSummary: "a.md",
      pending: true,
    };
    const before = toBlocks([user, tool]);
    const after = toBlocks([user, { ...tool, pending: false }], before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  test("a login-needed card retries the user message before it", () => {
    const blocks = toBlocks([
      { type: "user", text: "first" },
      { type: "assistant", text: "a" },
      { type: "user", text: "second" },
      { type: "login-needed", text: "sign in" },
    ]);
    const card = blocks[3];
    expect(card.kind === "item" && card.retryPrompt).toBe("second");
  });

  const tool = (
    id: string,
    pending = false,
  ): Extract<ChatItem, { type: "tool" }> => ({
    type: "tool",
    toolUseId: id,
    name: "Read",
    inputSummary: id,
    pending,
  });

  test("a tool call appended to the growing activity block extends it", () => {
    const user: ChatItem = { type: "user", text: "go" };
    const t1 = tool("t1");
    const t2 = tool("t2");
    const before = toBlocks([user, t1]);
    const after = toBlocks([user, t1, t2], before);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toEqual({
      kind: "activity",
      key: "activity-1",
      entries: [t1, t2],
    });
  });

  test("an answer after an activity block closes it and starts a new block", () => {
    const user: ChatItem = { type: "user", text: "go" };
    const t1 = tool("t1");
    const answer: ChatItem = { type: "assistant", text: "done" };
    const before = toBlocks([user, t1]);
    const after = toBlocks([user, t1, answer], before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toEqual({ kind: "item", key: "item-2", item: answer });
  });

  test("a shorter or different transcript (Thread switch) builds afresh", () => {
    const a: ChatItem = { type: "user", text: "a" };
    const b: ChatItem = { type: "assistant", text: "b" };
    const c: ChatItem = { type: "user", text: "c" };
    const before = toBlocks([a, b]);
    expect(toBlocks([c], before)).toEqual([
      { kind: "item", key: "item-0", item: c },
    ]);
    expect(toBlocks([a], before)).toEqual([before[0]]);
    expect(toBlocks([], before)).toEqual([]);
  });

  test("a login-needed card after a reused prefix still finds its prompt", () => {
    const items: ChatItem[] = [
      { type: "user", text: "please" },
      { type: "assistant", text: "a" },
    ];
    const before = toBlocks(items);
    const after = toBlocks(
      [...items, { type: "login-needed", text: "sign in" }],
      before,
    );
    const card = after[2];
    expect(card.kind === "item" && card.retryPrompt).toBe("please");
  });

  test("a tool result in an earlier group leaves the blocks after it untouched", () => {
    const t1 = tool("t1", true);
    const items: ChatItem[] = [
      { type: "user", text: "go" },
      t1,
      { type: "assistant", text: "meanwhile" },
      tool("t2"),
      { type: "assistant", text: "end" },
    ];
    const before = toBlocks(items);
    const edited = [...items];
    edited[1] = { ...t1, pending: false };
    const after = toBlocks(edited, before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after.slice(2)).toEqual(before.slice(2));
    for (let b = 2; b < after.length; b++) expect(after[b]).toBe(before[b]);
  });
});
