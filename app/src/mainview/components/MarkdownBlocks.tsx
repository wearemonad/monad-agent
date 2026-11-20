import {
  Children,
  type ComponentProps,
  createContext,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store";
import { cachedMarkdown, isMarkdownCached } from "../lib/markdownCache";
import {
  type BlockSplit,
  splitMarkdownBlocks,
  splitStreaming,
} from "../lib/markdownBlocks";
import { rehypeSearchHighlight } from "../lib/searchHighlight";
import { safeMarkdownComponents } from "./safeMarkdown";

/** Lower-cased search needles to mark in the transcript, or empty. Context,
 *  not a prop: list items read it wherever they render. */
export const SearchHighlight = createContext<readonly string[]>([]);

/** knowledgePaths as a Set, built once per list (the selector below runs on
 *  every store update, for every citation on screen). */
const knowledgeSets = new WeakMap<string[], Set<string>>();
function knowledgeSet(paths: string[]): Set<string> {
  let set = knowledgeSets.get(paths);
  if (!set) {
    set = new Set(paths);
    knowledgeSets.set(paths, set);
  }
  return set;
}

/** The text inside rendered children — a search highlight may have split
 *  a code span's text into runs and `<mark>`s. */
function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("");
}

/** Inline code in assistant markdown. A `path.md` that matches a known
 *  knowledge doc becomes a clickable citation. It subscribes to the knowledge
 *  list itself with a boolean selector, so a knowledge-list change re-renders
 *  only the affected citations — and a cached block (which holds this as an
 *  element, not its output) stays valid. */
function KnowledgeCode({
  node,
  className,
  children,
  ...props
}: ComponentProps<"code"> & { node?: unknown }) {
  void node;
  // v9+ has no `inline` flag: fenced blocks carry a language-* class.
  const isBlock = /\blanguage-/.test(className ?? "");
  const rel = isBlock
    ? null
    : textOf(children)
        .trim()
        .replace(/^knowledge\//, "")
        .replace(/^\.\//, "");
  const isDoc = useStore((s) =>
    rel === null ? false : knowledgeSet(s.knowledgePaths).has(rel),
  );
  if (rel !== null && isDoc) {
    return (
      <button
        type="button"
        className="citation text-brand underline decoration-dotted underline-offset-2 hover:text-brand"
        title={`Open knowledge/${rel}`}
        onClick={() => useStore.getState().openKnowledgeAt(rel)}
      >
        {children}
      </button>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

const components = { ...safeMarkdownComponents, code: KnowledgeCode };
const remarkPlugins = [remarkGfm];

/** One block parsed to React elements. `Markdown` is synchronous, so calling
 *  it directly yields its output tree — which is what makes caching skip the
 *  parse, not just the component. With needles, hits are marked. */
function renderBlock(
  text: string,
  needles: readonly string[] = [],
): ReactElement {
  return Markdown({
    children: text,
    remarkPlugins,
    rehypePlugins:
      needles.length > 0 ? [[rehypeSearchHighlight, { needles }]] : [],
    components,
  });
}

const renderPlain = (text: string) => renderBlock(text);

/** Parse work per slice of prewarming; the rest waits for the next task,
 *  so input and paint never queue behind it. */
const PREWARM_SLICE_MS = 4;
/** A runaway backlog (many Threads streaming long answers) keeps its
 *  newest blocks: those are what a revisit shows. */
const PREWARM_MAX_QUEUED = 2_000;
const prewarmQueue: string[] = [];
let prewarming: Promise<void> | null = null;

/** Parse `blocks` into the render cache in small slices, off the caller's
 *  turn (see lib/backgroundWarmup.ts). Settles once the queue is empty. */
export function prewarmBlocks(blocks: string[]): Promise<void> {
  for (const block of blocks)
    if (!isMarkdownCached(block)) prewarmQueue.push(block);
  if (prewarmQueue.length > PREWARM_MAX_QUEUED)
    prewarmQueue.splice(0, prewarmQueue.length - PREWARM_MAX_QUEUED);
  if (!prewarming && prewarmQueue.length > 0) {
    prewarming = new Promise((resolve) => {
      const slice = () => {
        const end = performance.now() + PREWARM_SLICE_MS;
        while (prewarmQueue.length > 0 && performance.now() < end) {
          const block = prewarmQueue.shift() as string;
          cachedMarkdown(block, renderPlain);
        }
        if (prewarmQueue.length > 0) setTimeout(slice, 0);
        else {
          prewarming = null;
          resolve();
        }
      };
      setTimeout(slice, 0);
    });
  }
  return prewarming ?? Promise.resolve();
}

/** One top-level block, memoised on its text and highlight. */
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  cache,
  needles,
}: {
  text: string;
  /** False for a streaming tail: every partial would evict real entries. */
  cache: boolean;
  needles: readonly string[];
}) {
  // While a search term is set the block renders fresh: highlights aren't a
  // pure function of the text.
  if (needles.length > 0) return renderBlock(text, needles);
  return cache ? cachedMarkdown(text, renderPlain) : renderPlain(text);
});

/** Assistant markdown, split into top-level blocks (§5b). Finished blocks
 *  are memoised and cached; while `streaming`, only the last, still-open
 *  block is re-split and re-parsed on each update. */
export const MarkdownBlocks = memo(function MarkdownBlocks({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const needles = useContext(SearchHighlight);
  // Streaming text only ever grows, so the split resumes from its last open
  // block instead of rescanning the whole answer on every reveal tick.
  const lastSplit = useRef<BlockSplit | undefined>(undefined);
  const blocks = useMemo(() => {
    if (!streaming) return splitMarkdownBlocks(text);
    lastSplit.current = splitStreaming(text, lastSplit.current);
    return lastSplit.current.blocks;
  }, [text, streaming]);
  return (
    <>
      {blocks.map((block, i) => (
        <MarkdownBlock
          // Index keys: a block only ever grows at the end, so earlier
          // indices keep their text and their memo.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          key={i}
          text={block}
          cache={!streaming || i < blocks.length - 1}
          needles={needles}
        />
      ))}
    </>
  );
});
