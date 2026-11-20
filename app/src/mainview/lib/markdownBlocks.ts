/** Top-level markdown blocks, so a streaming answer re-parses only its last
 *  block and a finished one can be memoised (and cached) block by block.
 *
 *  Splits at blank lines that fall outside code fences and lists. A table
 *  has no blank lines, so it never splits. Each block renders on its own, so
 *  anything that needs the whole document stays unsplit: a text with
 *  reference-style link or footnote definitions comes back as one block. */

/** A fence opener or closer. Any indentation: fences inside list items are
 *  indented past the usual three spaces. */
const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/** A split, plus what a streaming caller needs to resume it. */
export type BlockSplit = {
  text: string;
  blocks: string[];
  /** Leading blocks no later text can change. */
  stable: number;
  /** Offset in `text` where the first non-stable block starts. */
  resumeAt: number;
};

export function splitMarkdownBlocks(text: string): string[] {
  if (DEFINITION.test(text)) return text.trim() === "" ? [] : [text];
  return scan(text).blocks;
}

/** Split `text`, a continuation of `prev.text` (a growing stream), by
 *  rescanning only from its first non-stable block — so each update costs
 *  the open tail, not the whole answer. Anything else is a full split. */
export function splitStreaming(text: string, prev?: BlockSplit): BlockSplit {
  if (
    !prev ||
    !text.startsWith(prev.text) ||
    DEFINITION.test(text.slice(prev.resumeAt))
  ) {
    if (DEFINITION.test(text))
      return {
        text,
        blocks: text.trim() === "" ? [] : [text],
        stable: 0,
        resumeAt: 0,
      };
    return { text, ...scan(text) };
  }
  const tail = scan(text.slice(prev.resumeAt));
  return {
    text,
    blocks: prev.blocks.slice(0, prev.stable).concat(tail.blocks),
    stable: prev.stable + tail.stable,
    resumeAt: prev.resumeAt + tail.resumeAt,
  };
}

/** The block scan, without the definitions rule. A block is stable once a
 *  COMPLETE line closed it: the last line may still be arriving, and a
 *  partial "1" can turn out to be the "1. " that continues a list. */
function scan(text: string): Omit<BlockSplit, "text"> {
  const blocks: string[] = [];
  let stable = 0;
  let resumeAt = 0;
  let current: string[] = [];
  /** The open fence's marker (e.g. "````"), or null outside a fence. */
  let fence: string | null = null;
  /** The current block holds a list, so indented text continues it. */
  let inList = false;
  /** Blank lines seen since the last text line, not yet placed. */
  let blanks = 0;
  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
    inList = false;
  };
  const lines = text.split("\n");
  let offset = 0;
  lines.forEach((line, n) => {
    const lineStart = offset;
    offset += line.length + 1;
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      current.push(line);
      // Closes on the same character, at least as long, with nothing after.
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = null;
      return;
    }
    if (line.trim() === "") {
      blanks++;
      return;
    }
    if (blanks > 0) {
      const continuesList =
        inList && (/^\s/.test(line) || LIST_ITEM.test(line));
      if (continuesList) for (; blanks > 0; blanks--) current.push("");
      else {
        flush();
        if (n < lines.length - 1) {
          stable = blocks.length;
          resumeAt = lineStart;
        }
      }
      blanks = 0;
    }
    if (marker) fence = marker;
    if (LIST_ITEM.test(line)) inList = true;
    current.push(line);
  });
  flush();
  return { blocks, stable, resumeAt };
}
