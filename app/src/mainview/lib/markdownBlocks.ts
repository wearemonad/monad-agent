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

export function splitMarkdownBlocks(text: string): string[] {
  if (DEFINITION.test(text)) return text.trim() === "" ? [] : [text];
  const blocks: string[] = [];
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
  for (const line of text.split("\n")) {
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
      continue;
    }
    if (line.trim() === "") {
      blanks++;
      continue;
    }
    if (blanks > 0) {
      const continuesList =
        inList && (/^\s/.test(line) || LIST_ITEM.test(line));
      if (continuesList) for (; blanks > 0; blanks--) current.push("");
      else flush();
      blanks = 0;
    }
    if (marker) fence = marker;
    if (LIST_ITEM.test(line)) inList = true;
    current.push(line);
  }
  flush();
  return blocks;
}
