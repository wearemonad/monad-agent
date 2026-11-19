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

/** The transcript as blocks, reusing `prev`'s block objects wherever a block's
 *  items are unchanged (same item references), so TranscriptBlock's memo bails
 *  for everything but the block that's growing. An unchanged transcript
 *  returns `prev` itself. One forward pass. */
export function toBlocks(
  items: ChatItem[],
  prev: MessageBlock[] = [],
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let lastUserText: string | undefined;
  items.forEach((item, i) => {
    if (item.type === "tool" || item.type === "thinking") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "activity") last.entries.push(item);
      else
        blocks.push({
          kind: "activity",
          key: `activity-${i}`,
          entries: [item],
        });
      return;
    }
    if (item.type === "user") lastUserText = item.text;
    blocks.push(
      item.type === "login-needed" && lastUserText !== undefined
        ? { kind: "item", key: `item-${i}`, item, retryPrompt: lastUserText }
        : { kind: "item", key: `item-${i}`, item },
    );
  });

  let same = blocks.length === prev.length;
  const out = blocks.map((block, b) => {
    const old = prev[b];
    const kept = old && sameBlock(old, block) ? old : block;
    if (kept !== old) same = false;
    return kept;
  });
  return same ? prev : out;
}

function sameBlock(a: MessageBlock, b: MessageBlock): boolean {
  if (a.key !== b.key) return false;
  if (a.kind === "activity" && b.kind === "activity") {
    return (
      a.entries.length === b.entries.length &&
      a.entries.every((e, i) => e === b.entries[i])
    );
  }
  return (
    a.kind === "item" &&
    b.kind === "item" &&
    a.item === b.item &&
    a.retryPrompt === b.retryPrompt
  );
}
