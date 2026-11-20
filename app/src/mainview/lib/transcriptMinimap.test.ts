import { describe, expect, test } from "bun:test";
import type { Row } from "../transcriptRows";
import {
  createVisibleRowsStore,
  currentTurn,
  minimapTurns,
  previewText,
  tickTopPercent,
  turnAtPointer,
  turnsInView,
} from "./transcriptMinimap";

const user = (key: string, text: string): Row => ({
  key,
  gap: 0,
  kind: "block",
  block: { kind: "item", key, item: { type: "user", text } },
});
const answer = (key: string, text: string, remember: string | null): Row => ({
  key,
  gap: 0,
  kind: "markdown",
  text,
  continues: false,
  remember,
});
const activity = (key: string): Row => ({
  key,
  gap: 0,
  kind: "block",
  block: { kind: "activity", key, entries: [] },
});

describe("minimapTurns", () => {
  test("one turn per user message, with its row and the answer that closed it", () => {
    const rows = [
      user("t:u0", "Draft the update"),
      activity("t:a0"),
      answer("t:m0", "Here it is.", "Here it is."),
      user("t:u1", "Shorter please"),
      answer("t:m1a", "Sure —", null),
      answer("t:m1b", "done.", "Sure — done."),
    ];
    expect(minimapTurns(rows)).toEqual([
      {
        key: "t:u0",
        rowIndex: 0,
        user: "Draft the update",
        answer: "Here it is.",
      },
      {
        key: "t:u1",
        rowIndex: 3,
        user: "Shorter please",
        answer: "Sure — done.",
      },
    ]);
  });

  test("a turn still running (or with only narration) has no answer yet", () => {
    const rows = [user("t:u0", "Go"), answer("t:m0", "Looking…", null)];
    expect(minimapTurns(rows)[0]?.answer).toBeNull();
  });
});

describe("rail geometry", () => {
  test("ticks spread evenly from the rail's top to its bottom", () => {
    expect([0, 1, 2, 3, 4].map((i) => tickTopPercent(i, 5))).toEqual([
      0, 25, 50, 75, 100,
    ]);
    expect(tickTopPercent(0, 1)).toBe(0);
  });

  test("the pointer picks the nearest tick, clamped to the rail", () => {
    const rail = { count: 5, top: 100, height: 40 };
    expect(turnAtPointer({ ...rail, y: 100 })).toBe(0);
    expect(turnAtPointer({ ...rail, y: 114 })).toBe(1); // 35% → nearest is 25%
    expect(turnAtPointer({ ...rail, y: 140 })).toBe(4);
    expect(turnAtPointer({ ...rail, y: 400 })).toBe(4);
    expect(turnAtPointer({ ...rail, y: 0 })).toBe(0);
    expect(turnAtPointer({ ...rail, count: 0, y: 120 })).toBeNull();
  });
});

describe("what's on screen", () => {
  // Turns start at rows 0, 4 and 9; the transcript has 12 rows.
  const starts = [0, 4, 9];

  test("a turn is in view when any of its rows is", () => {
    expect(turnsInView(starts, { start: 2, end: 5 })).toEqual([
      true,
      true,
      false,
    ]);
    expect(turnsInView(starts, { start: 10, end: 11 })).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("the current turn is the first user message on screen", () => {
    expect(currentTurn(starts, { start: 3, end: 10 })).toBe(1);
  });

  test("with no user message on screen it's the turn being read", () => {
    expect(currentTurn(starts, { start: 5, end: 7 })).toBe(1);
    expect(currentTurn(starts, { start: 10, end: 11 })).toBe(2);
  });

  test("an empty list has no current turn", () => {
    expect(currentTurn([], { start: 0, end: 0 })).toBeNull();
  });
});

describe("previewText", () => {
  test("markdown becomes one plain line, without markup or link targets", () => {
    expect(
      previewText(
        "# Plan\n\n**Ship** it by [Friday](https://x.y).\n\n- one\n- two",
      ),
    ).toBe("Plan Ship it by Friday. one two");
  });

  test("code keeps its text", () => {
    expect(previewText("Run `bun test`:\n\n```sh\nbun test src\n```")).toBe(
      "Run bun test: bun test src",
    );
  });

  test("a huge answer is only parsed as far as a preview needs", () => {
    const long = `${"word ".repeat(2_000)}TAIL`;
    const out = previewText(long);
    expect(out.length).toBeLessThanOrEqual(1_500);
    expect(out).not.toContain("TAIL");
  });

  test("blank markdown has no preview", () => {
    expect(previewText("  \n\n ")).toBe("");
  });
});

describe("createVisibleRowsStore", () => {
  test("notifies on a new range only", () => {
    const store = createVisibleRowsStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.set(0, 5);
    store.set(0, 5);
    store.set(1, 6);
    expect(calls).toBe(2);
    expect(store.get()).toEqual({ start: 1, end: 6 });
  });
});
