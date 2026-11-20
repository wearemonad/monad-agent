import {
  type ComponentProps,
  createContext,
  memo,
  type ReactElement,
  useContext,
  useMemo,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store";
import { cachedMarkdown } from "../lib/markdownCache";
import { splitMarkdownBlocks } from "../lib/markdownBlocks";
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
    : String(children)
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
 *  parse, not just the component. */
function renderBlock(text: string): ReactElement {
  return Markdown({ children: text, remarkPlugins, components });
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
  if (needles.length > 0)
    return Markdown({
      children: text,
      remarkPlugins,
      rehypePlugins: [[rehypeSearchHighlight, { needles }]],
      components,
    });
  return cache ? cachedMarkdown(text, renderBlock) : renderBlock(text);
});

/** Assistant markdown, split into top-level blocks (§5b). Finished blocks
 *  are memoised and cached; while `streaming`, only the last, still-open
 *  block re-parses on each update. */
export const MarkdownBlocks = memo(function MarkdownBlocks({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const needles = useContext(SearchHighlight);
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
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
