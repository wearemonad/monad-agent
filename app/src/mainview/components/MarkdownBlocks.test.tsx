import { beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  MarkdownBlocks as MarkdownBlocksT,
  SearchHighlight as SearchHighlightT,
} from "./MarkdownBlocks";

/** Block-split markdown (PARALLEL-THREADS-PR5-RENDERING.html §5b, §5c). */

let MarkdownBlocks: typeof MarkdownBlocksT;
let SearchHighlight: typeof SearchHighlightT;

beforeAll(async () => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  // The real RPC module needs the Electrobun webview's `window`; rendering
  // never calls it (links only open on click).
  mock.module("../rpc", () => ({ api: {} }));
  ({ MarkdownBlocks, SearchHighlight } = await import("./MarkdownBlocks"));
  ({ useStore } = await import("../store"));
});

let useStore: typeof import("../store").useStore;

const ANSWER = [
  "## Plan",
  "",
  "Some **bold** text and a [link](https://example.com).",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "1. one",
  "",
  "   still one",
  "2. two",
  "",
  "```ts",
  "const x = 1;",
  "",
  "const y = 2;",
  "```",
].join("\n");

/** Whitespace between top-level elements differs (one parse vs several). */
const squash = (html: string) => html.replace(/>\s+</g, "><");

describe("MarkdownBlocks", () => {
  test("renders the same markup as one whole-text parse", () => {
    const split = renderToStaticMarkup(<MarkdownBlocks text={ANSWER} />);
    const whole = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{ANSWER}</ReactMarkdown>,
    );
    // Our link override adds a title and keeps the href — normalise both.
    const strip = (h: string) => squash(h).replace(/ title="[^"]*"/g, "");
    expect(strip(split)).toBe(strip(whole));
  });

  test("a streaming tail renders the same as a finished text", () => {
    const text = "First.\n\nSecond, still **streaming";
    expect(renderToStaticMarkup(<MarkdownBlocks text={text} streaming />)).toBe(
      renderToStaticMarkup(<MarkdownBlocks text={text} />),
    );
  });

  test("marks search hits case-insensitively, inside formatting too", () => {
    const html = renderToStaticMarkup(
      <SearchHighlight.Provider value={["budget"]}>
        <MarkdownBlocks text={"The Budget is set.\n\n**budget** review"} />
      </SearchHighlight.Provider>,
    );
    expect(html).toContain('<mark class="search-hit">Budget</mark> is set.');
    expect(html).toContain(
      '<strong><mark class="search-hit">budget</mark></strong> review',
    );
  });

  test("a cached block still renders highlights once a term is set", () => {
    const text = "Quarterly revenue grew.";
    renderToStaticMarkup(<MarkdownBlocks text={text} />);
    const html = renderToStaticMarkup(
      <SearchHighlight.Provider value={["revenue"]}>
        <MarkdownBlocks text={text} />
      </SearchHighlight.Provider>,
    );
    expect(html).toContain('<mark class="search-hit">revenue</mark>');
    expect(renderToStaticMarkup(<MarkdownBlocks text={text} />)).not.toContain(
      "<mark",
    );
  });

  test("a knowledge citation stays a link when a search hit is inside it", () => {
    // Static rendering reads zustand's initial state (its server snapshot),
    // so the known doc goes there.
    useStore.getInitialState().knowledgePaths = ["plan.md"];
    const html = renderToStaticMarkup(
      <SearchHighlight.Provider value={["plan"]}>
        <MarkdownBlocks text={"See `plan.md` for the plan."} />
      </SearchHighlight.Provider>,
    );
    expect(html).toContain('title="Open knowledge/plan.md"');
    expect(html).toContain('<mark class="search-hit">plan</mark>.md</button>');
  });
});
