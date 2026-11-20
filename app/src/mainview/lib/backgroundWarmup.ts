import type { ChatItem } from "../../shared/ipc";
import {
  type BlockSplit,
  splitMarkdownBlocks,
  splitStreaming,
} from "./markdownBlocks";

/** Which markdown blocks to pre-parse for Threads that aren't on screen
 *  (PARALLEL-THREADS-PR5-RENDERING.html §5c). A background Thread keeps
 *  streaming, and nothing renders its new answers until it is opened — so
 *  the click would pay for parsing them. Warming them into the render cache
 *  as they arrive moves that cost off the click.
 *
 *  Only what a revisit shows first is warmed: Threads open at their end, so
 *  that is the newest answers and the stream's finished blocks. The open
 *  Thread is never warmed — it renders (and caches) its own. */

/** The slice of a Thread (ThreadState) the warm-up reads. */
export type WarmupThread = { items: ChatItem[]; streamingText: string };

export type WarmupState = {
  activeThreadId: string;
  threads: Record<string, WarmupThread>;
};

/** Answers warmed for a Thread seen for the first time or replaced. */
const LAST_ANSWERS = 2;

const answerTexts = (items: ChatItem[]): string[] =>
  items.flatMap((i) => (i.type === "assistant" ? [i.text] : []));

export class BackgroundWarmup {
  private items = new Map<string, ChatItem[]>();
  private splits = new Map<string, BlockSplit>();

  /** Blocks to warm since the last update (some may already be cached). */
  update(state: WarmupState): string[] {
    const out: string[] = [];
    for (const [id, t] of Object.entries(state.threads)) {
      const background = id !== state.activeThreadId;
      const prevItems = this.items.get(id);
      if (t.items !== prevItems) {
        this.items.set(id, t.items);
        if (background) {
          // Appended: the new answers. Anything else (first sight, a history
          // load): the last few, which is what opens on screen.
          const appended =
            prevItems !== undefined &&
            prevItems.length <= t.items.length &&
            prevItems.every((item, i) => t.items[i] === item);
          const texts = appended
            ? answerTexts(t.items.slice(prevItems.length))
            : answerTexts(t.items);
          for (const text of texts.slice(-LAST_ANSWERS))
            out.push(...splitMarkdownBlocks(text));
        }
      }
      const prev = this.splits.get(id);
      if (t.streamingText !== (prev?.text ?? "")) {
        const next = splitStreaming(t.streamingText, prev);
        this.splits.set(id, next);
        // Blocks that just became final; the open tail still changes.
        const from = prev && next.text.startsWith(prev.text) ? prev.stable : 0;
        if (background) out.push(...next.blocks.slice(from, next.stable));
      }
    }
    for (const id of this.items.keys()) {
      if (!(id in state.threads)) {
        this.items.delete(id);
        this.splits.delete(id);
      }
    }
    return out;
  }
}
