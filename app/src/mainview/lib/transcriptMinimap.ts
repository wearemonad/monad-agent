import { toString as mdastText } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Row } from "../transcriptRows";

/** The transcript minimap's model, after T3 Code's TimelineMinimap: one tick
 *  per turn (a user message and what answered it), placed by turn order —
 *  not by pixel offset, which the virtualised list only estimates for rows
 *  it hasn't laid out. Pure, so it's tested without the list. */

export type MinimapTurn = {
  /** The user message's row key. */
  key: string;
  /** Its index in the list's rows — what the jump scrolls to. */
  rowIndex: number;
  user: string;
  /** The answer that closed the turn (markdown); null while it runs. */
  answer: string | null;
};

export function minimapTurns(rows: readonly Row[]): MinimapTurn[] {
  const turns: MinimapTurn[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (
      row.kind === "block" &&
      row.block.kind === "item" &&
      row.block.item.type === "user"
    ) {
      turns.push({
        key: row.key,
        rowIndex,
        user: row.block.item.text,
        answer: null,
      });
    } else if (row.kind === "markdown" && row.remember !== null) {
      // A finished answer's last block carries the whole answer.
      const turn = turns[turns.length - 1];
      if (turn) turn.answer = row.remember;
    }
  }
  return turns;
}

/** Rows the list has on screen, inclusive (LegendListState start/end). */
export type VisibleRows = { start: number; end: number };

/** A tick's offset down the rail, 0–100. */
export function tickTopPercent(index: number, count: number): number {
  if (count <= 1) return 0;
  return (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100;
}

/** The turn whose tick is nearest the pointer, clamped to the rail's ends. */
export function turnAtPointer(input: {
  count: number;
  top: number;
  height: number;
  y: number;
}): number | null {
  if (input.count <= 0) return null;
  if (input.count === 1 || input.height <= 0) return 0;
  const progress = Math.max(
    0,
    Math.min(1, (input.y - input.top) / input.height),
  );
  return Math.round(progress * (input.count - 1));
}

/** Per turn (by its first row), whether any of its rows is on screen. */
export function turnsInView(
  starts: readonly number[],
  visible: VisibleRows,
): boolean[] {
  return starts.map((start, i) => {
    const next = starts[i + 1];
    const last = next === undefined ? Number.POSITIVE_INFINITY : next - 1;
    return start <= visible.end && last >= visible.start;
  });
}

/** The turn being read: the first user message on screen, or else the turn
 *  whose rows fill the screen (the one starting above it). */
export function currentTurn(
  starts: readonly number[],
  visible: VisibleRows,
): number | null {
  let preceding: number | null = null;
  for (const [i, start] of starts.entries()) {
    if (start >= visible.start) return start <= visible.end ? i : preceding;
    preceding = i;
  }
  return preceding;
}

/** The card shows a few lines; parsing more of a long or streaming answer
 *  would only cost time on every hover. */
const PREVIEW_SOURCE_CHARS = 1_500;
const parser = unified().use(remarkParse).freeze();

/** A user message as one line. It's plain text (the transcript shows it
 *  pre-wrapped, not rendered), so "__init__.py" or "# 3 bugs" stay as typed. */
export function plainLine(text: string): string {
  return text.slice(0, PREVIEW_SOURCE_CHARS).replace(/\s+/g, " ").trim();
}

/** Markdown as one line of the text it renders: no markup, no link targets.
 *  Top-level blocks are joined with a space (mdast-util-to-string would run
 *  "Plan" and "Ship" together). */
export function previewText(markdown: string): string {
  const tree = parser.parse(markdown.slice(0, PREVIEW_SOURCE_CHARS));
  return tree.children
    .map((node) =>
      node.type === "list"
        ? node.children.map((item) => mdastText(item)).join(" ")
        : mdastText(node),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The list's on-screen rows as a tiny external store: the transcript
 *  writes it from its scroll handler, the rail reads it with
 *  useSyncExternalStore — so scrolling re-renders the rail, never the
 *  transcript. Unchanged ranges don't notify. */
export function createVisibleRowsStore() {
  let value: VisibleRows | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    /** A Thread switch: the old range means nothing in the new list. */
    reset() {
      if (value === null) return;
      value = null;
      for (const l of listeners) l();
    },
    set(start: number, end: number) {
      if (value?.start === start && value.end === end) return;
      value = { start, end };
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type VisibleRowsStore = ReturnType<typeof createVisibleRowsStore>;
