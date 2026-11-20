import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../shared/ipc";
import { BackgroundWarmup, type WarmupThread } from "./backgroundWarmup";

/** Pre-parsing background Threads' markdown (PARALLEL-THREADS-PR5-RENDERING
 *  .html §5c): what a revisit would otherwise parse on the click. */

const thread = (items: ChatItem[], streamingText = ""): WarmupThread => ({
  items,
  streamingText,
});

const user = (text: string): ChatItem => ({ type: "user", text });
const answer = (text: string): ChatItem => ({ type: "assistant", text });

describe("BackgroundWarmup", () => {
  test("warms a background Thread's new answer, block by block", () => {
    const w = new BackgroundWarmup();
    const before = [user("q"), answer("Old.")];
    w.update({ activeThreadId: "a", threads: { b: thread(before) } });
    expect(
      w.update({
        activeThreadId: "a",
        threads: { b: thread([...before, answer("# New\n\nBody.")]) },
      }),
    ).toEqual(["# New", "Body."]);
  });

  test("never warms the open Thread", () => {
    const w = new BackgroundWarmup();
    w.update({ activeThreadId: "a", threads: { a: thread([]) } });
    expect(
      w.update({
        activeThreadId: "a",
        threads: { a: thread([answer("Shown anyway.")]) },
      }),
    ).toEqual([]);
  });

  test("warms a stream's finished blocks once, not its open tail", () => {
    const w = new BackgroundWarmup();
    const at = (text: string) =>
      w.update({ activeThreadId: "a", threads: { b: thread([], text) } });
    // A block is final once the line after it is complete.
    expect(at("First block.\n\nSec")).toEqual([]);
    expect(at("First block.\n\nSecond.\n\nThi")).toEqual(["First block."]);
    expect(at("First block.\n\nSecond.\n\nThird.\nmore")).toEqual(["Second."]);
    expect(at("First block.\n\nSecond.\n\nThird.\nmore and more")).toEqual([]);
  });

  test("a Thread seen for the first time warms only its last two answers", () => {
    const w = new BackgroundWarmup();
    const items = [answer("One."), answer("Two."), user("q"), answer("Three.")];
    expect(
      w.update({ activeThreadId: "a", threads: { b: thread(items) } }),
    ).toEqual(["Two.", "Three."]);
  });
});
