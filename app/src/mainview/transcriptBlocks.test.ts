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
});
