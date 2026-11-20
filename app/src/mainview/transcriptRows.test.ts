import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../shared/ipc";
import { toBlocks } from "./transcriptBlocks";
import { type Row, toRows } from "./transcriptRows";

/** List rows for the virtualised transcript (PARALLEL-THREADS-PR5-RENDERING
 *  .html §5a/§5b): one row per markdown block of an answer, so a long answer
 *  is virtualised too, and a streamed answer's rows survive its completion. */

const user = (text: string): ChatItem => ({ type: "user", text });
const answer = (text: string): ChatItem => ({ type: "assistant", text });
const tool: ChatItem = {
  type: "tool",
  toolUseId: "t1",
  name: "Grep",
  inputSummary: "x",
  pending: false,
};

const rowsFor = (
  items: ChatItem[],
  streamed: string[] = [],
  prev: Row[] = [],
) => toRows("T", toBlocks(items), streamed, `item-${items.length}`, prev);

const summary = (rows: Row[]) =>
  rows.map((r) =>
    r.kind === "markdown"
      ? `${r.key} md gap=${r.gap}${r.continues ? " cont" : ""}${r.remember ? " remember" : ""}`
      : `${r.key} ${r.block.kind} gap=${r.gap}`,
  );

describe("toRows", () => {
  test("an answer becomes one row per markdown block, Remember on its last", () => {
    expect(summary(rowsFor([user("q"), answer("# A\n\nB.\n\nC.")]))).toEqual([
      "T:item-0 item gap=0",
      "T:item-1:0 md gap=12",
      "T:item-1:1 md gap=0 cont",
      "T:item-1:2 md gap=0 cont remember",
    ]);
  });

  test("narration before a tool group gets no Remember", () => {
    const rows = rowsFor([user("q"), answer("Let me look."), tool]);
    expect(summary(rows)).toEqual([
      "T:item-0 item gap=0",
      "T:item-1:0 md gap=12",
      "T:activity-2 activity gap=16",
    ]);
  });

  test("a streamed answer's rows keep key and identity when it completes", () => {
    const items = [user("q")];
    const streaming = rowsFor(items, ["# A", "B."]);
    expect(summary(streaming)).toEqual([
      "T:item-0 item gap=0",
      "T:item-1:0 md gap=12",
      "T:item-1:1 md gap=0 cont",
    ]);
    const done = rowsFor([...items, answer("# A\n\nB.\n\nC.")], [], streaming);
    // The finished blocks are the very same rows; only the tail is new.
    expect(done[1]).toBe(streaming[1]);
    expect(summary(done).slice(2)).toEqual([
      "T:item-1:1 md gap=0 cont",
      "T:item-1:2 md gap=0 cont remember",
    ]);
  });

  test("unchanged rows are reused as-is", () => {
    const items = [user("q"), answer("A.\n\nB.")];
    const blocks = toBlocks(items);
    const first = toRows("T", blocks, [], "item-2", []);
    // As in the app, the previous blocks feed toBlocks (it reuses them).
    const more = [...items, user("next")];
    const again = toRows("T", toBlocks(more, blocks), [], "item-3", first);
    expect(again.slice(0, 3)).toEqual(first);
    for (const [i, row] of first.entries()) expect(again[i]).toBe(row);
  });
});
