import type { ChatItem } from "../shared/ipc";
import { splitMarkdownBlocks } from "./lib/markdownBlocks";
import type { MessageBlock } from "./transcriptBlocks";

/** The virtualised transcript's list rows (PARALLEL-THREADS-PR5-RENDERING
 *  .html §5a/§5b). An answer is one row per top-level markdown block, not
 *  one row per message:
 *
 *  - a long answer is virtualised too — opening a Thread lays out only the
 *    blocks on screen, not a whole 10 000-character message;
 *  - the answer still streaming shows its finished blocks as rows under the
 *    same keys its final item will have, so completion keeps those rows
 *    (and their DOM) instead of building the whole answer again. */

export type Row = {
  /** Unique across Threads: block keys are positions ("item-3"), and the
   *  one list shows every Thread — a shared key would carry one Thread's
   *  measured height and component state into another's row. */
  key: string;
  /** Space above, in px. List items are positioned one by one, so the old
   *  sibling margins (tight activity lines, air at the seams) are explicit. */
  gap: number;
} & (
  | {
      /** Anything but an answer: a user message, an activity group, a card. */
      kind: "block";
      block: MessageBlock;
    }
  | {
      /** One markdown block of an answer (finished, or still streaming). */
      kind: "markdown";
      text: string;
      /** Not the answer's first block: it keeps its top margin (see
       *  KeepTopMargin in ChatPane). */
      continues: boolean;
      /** On a finished answer's last block: the whole answer, for its
       *  Remember button. Null mid-answer, mid-stream, and for narration
       *  before a tool group (in-run, not an answer). */
      remember: string | null;
    }
);

type Answer = Extract<ChatItem, { type: "assistant" }>;

/** An answer's blocks, split once per item (items never change in place). */
const answerBlocks = new WeakMap<Answer, string[]>();
function blocksOf(item: Answer): string[] {
  let blocks = answerBlocks.get(item);
  if (!blocks) {
    blocks = splitMarkdownBlocks(item.text);
    answerBlocks.set(item, blocks);
  }
  return blocks;
}

function gapAbove(prev: MessageBlock | undefined, block: MessageBlock) {
  if (!prev) return 0;
  const lineAbove = prev.kind === "activity";
  const line = block.kind === "activity";
  if (line) return lineAbove ? 0 : 16;
  return 12;
}

/** Rows for `blocks`, then the streaming answer's finished blocks
 *  (`streamed`) under `nextKey` — the block key its item will get. Rows from
 *  `prev` are reused wherever nothing about them changed. */
export function toRows(
  threadId: string,
  blocks: MessageBlock[],
  streamed: string[],
  nextKey: string,
  prev: Row[],
): Row[] {
  const reuse = new Map(prev.map((row) => [row.key, row]));
  const rows: Row[] = [];
  const pushMarkdown = (
    key: string,
    text: string,
    gap: number,
    continues: boolean,
    remember: string | null,
  ) => {
    const old = reuse.get(key);
    rows.push(
      old?.kind === "markdown" &&
        old.text === text &&
        old.gap === gap &&
        old.continues === continues &&
        old.remember === remember
        ? old
        : { kind: "markdown", key, text, gap, continues, remember },
    );
  };

  blocks.forEach((block, i) => {
    const gap = gapAbove(blocks[i - 1], block);
    if (block.kind === "item" && block.item.type === "assistant") {
      const item = block.item;
      const parts = blocksOf(item);
      const narration = blocks[i + 1]?.kind === "activity";
      parts.forEach((text, j) => {
        const last = j === parts.length - 1;
        pushMarkdown(
          `${threadId}:${block.key}:${j}`,
          text,
          j === 0 ? gap : 0,
          j > 0,
          last && !narration ? item.text : null,
        );
      });
      return;
    }
    const key = `${threadId}:${block.key}`;
    const old = reuse.get(key);
    rows.push(
      old?.kind === "block" && old.block === block && old.gap === gap
        ? old
        : { kind: "block", key, block, gap },
    );
  });

  const before = blocks[blocks.length - 1];
  streamed.forEach((text, j) => {
    const gap = j > 0 || !before ? 0 : 12;
    pushMarkdown(`${threadId}:${nextKey}:${j}`, text, gap, j > 0, null);
  });
  return rows;
}
