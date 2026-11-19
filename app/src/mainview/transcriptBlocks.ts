import type { ChatItem } from "../shared/ipc";

type ActivityItem = Extract<ChatItem, { type: "tool" | "thinking" }>;

/** Transcript blocks: consecutive tool calls + reasoning fold into one
 *  activity accordion (keyed by the run's first entry so its open/closed
 *  state survives streaming appends); everything else renders on its own. */
export type MessageBlock =
  | { kind: "activity"; key: string; entries: ActivityItem[] }
  | {
      kind: "item";
      key: string;
      item: Exclude<ChatItem, { type: "tool" | "thinking" }>;
      /** For a login-needed card: the user message whose run failed, so
       *  the card can offer to send it again once signed in. */
      retryPrompt?: string;
    };

const isActivity = (item: ChatItem | undefined): item is ActivityItem =>
  item?.type === "tool" || item?.type === "thinking";

/** The transcript as blocks. With `prev` (the last result), the unchanged
 *  prefix is reused as-is — each of those blocks is only checked by item
 *  reference, never rebuilt — and blocks are built only from the first one
 *  that changed (normally just the growing last block). Reused blocks keep
 *  TranscriptBlock's memo bailing; an unchanged transcript returns `prev`
 *  itself. */
export function toBlocks(
  items: ChatItem[],
  prev: MessageBlock[] = [],
): MessageBlock[] {
  // 1. Walk prev while each block still matches the items at its position.
  let reused = 0;
  let start = 0;
  let lastUserText: string | undefined;
  for (const block of prev) {
    const size = block.kind === "activity" ? block.entries.length : 1;
    if (!matches(block, items, start)) break;
    // An activity block followed by another activity item has grown.
    if (block.kind === "activity" && isActivity(items[start + size])) break;
    if (block.kind === "item" && block.item.type === "user")
      lastUserText = block.item.text;
    reused++;
    start += size;
  }
  if (reused === prev.length && start === items.length) return prev;

  // 2. Build the rest, one forward pass from where reuse stopped.
  const blocks = prev.slice(0, reused);
  for (let i = start; i < items.length; i++) {
    const item = items[i];
    if (isActivity(item)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "activity" && blocks.length > reused)
        last.entries.push(item);
      else
        blocks.push({
          kind: "activity",
          key: `activity-${i}`,
          entries: [item],
        });
      continue;
    }
    if (item.type === "user") lastUserText = item.text;
    blocks.push(
      item.type === "login-needed" && lastUserText !== undefined
        ? { kind: "item", key: `item-${i}`, item, retryPrompt: lastUserText }
        : { kind: "item", key: `item-${i}`, item },
    );
  }
  // 3. A rebuilt block that came out identical (blocks after a mid-list
  //    edit, e.g. a tool result landing in an earlier group) keeps its old
  //    object too.
  for (let b = reused; b < blocks.length; b++) {
    const old = prev[b];
    if (old && sameBlock(old, blocks[b])) blocks[b] = old;
  }
  return blocks;
}

/** Does `block` still describe the items at `start`? Reference checks only. */
function matches(block: MessageBlock, items: ChatItem[], start: number) {
  if (block.kind === "item") return items[start] === block.item;
  return block.entries.every((e, k) => items[start + k] === e);
}

function sameBlock(a: MessageBlock, b: MessageBlock): boolean {
  if (a.key !== b.key) return false;
  if (a.kind === "activity" && b.kind === "activity")
    return (
      a.entries.length === b.entries.length &&
      a.entries.every((e, k) => e === b.entries[k])
    );
  return (
    a.kind === "item" &&
    b.kind === "item" &&
    a.item === b.item &&
    a.retryPrompt === b.retryPrompt
  );
}
