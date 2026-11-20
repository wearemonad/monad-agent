import type { ElementContent, Root } from "hast";
import { LRUCache } from "lru-cache";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";

/** Search-hit highlighting for a virtualised transcript
 *  (PARALLEL-THREADS-PR5-RENDERING.html §5a). Off-screen blocks aren't in
 *  the DOM, so matches are found in the data and marked while rendering. */

/** Class on every hit's `<mark>` (styled in index.css). */
export const SEARCH_HIT_CLASS = "search-hit";

/** A run of text, flagged when it is a hit. */
export type HitRun = { text: string; hit: boolean };

export type SearchMatches = {
  /** Lower-cased strings to mark; empty when nothing matches. */
  needles: string[];
  count: number;
  /** Index (into the searched sources) of the first with a match, or -1. */
  first: number;
};

const NONE: SearchMatches = { needles: [], count: 0, first: -1 };

/** Something to search: a user's plain text, or assistant markdown. */
export type SearchSource = { text: string; markdown: boolean };

/** The text runs a markdown text renders as — the hast text nodes the
 *  highlight step visits, so a count here is exactly what gets marked: no
 *  link URLs, no `**` markers, a phrase split by formatting is not one hit.
 *  Cached: a search re-counts on every streamed item. */
const renderedRuns = new LRUCache<string, string[]>({
  maxSize: 2_000_000,
  sizeCalculation: (_runs, text) => Math.max(1, text.length),
});
const toHast = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

function runsOf(source: SearchSource): string[] {
  if (!source.markdown) return [source.text];
  let runs = renderedRuns.get(source.text);
  if (!runs) {
    const found: string[] = [];
    visit(toHast.runSync(toHast.parse(source.text)), "text", (node) => {
      found.push(node.value);
    });
    runs = found;
    renderedRuns.set(source.text, runs);
  }
  return runs;
}

const hitsIn = (run: string, needles: readonly string[]) =>
  splitHits(run, needles).filter((part) => part.hit).length;

function matchAll(sources: SearchSource[], needles: string[]): SearchMatches {
  let count = 0;
  let first = -1;
  sources.forEach((source, i) => {
    const n = runsOf(source).reduce(
      (sum, run) => sum + hitsIn(run, needles),
      0,
    );
    if (n > 0 && first === -1) first = i;
    count += n;
  });
  return count > 0 ? { needles, count, first } : NONE;
}

/** Matches for a search term across sources. A term that matches nowhere
 *  as a phrase falls back to its words (three letters or more); a
 *  hybrid-search hit can also match only semantically, and then nothing is
 *  marked. */
export function findSearchMatches(
  sources: SearchSource[],
  term: string | null,
): SearchMatches {
  const phrase = term?.trim().toLowerCase() ?? "";
  if (phrase.length < 2) return NONE;
  const exact = matchAll(sources, [phrase]);
  if (exact.count > 0) return exact;
  const words = [...new Set(phrase.split(/\s+/).filter((w) => w.length >= 3))];
  return words.length > 1 ? matchAll(sources, words) : NONE;
}

/** `text` cut into runs, each flagged as a hit or not. */
export function splitHits(text: string, needles: readonly string[]): HitRun[] {
  if (needles.length === 0) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const parts: HitRun[] = [];
  let at = 0;
  while (at < text.length) {
    // Earliest next occurrence of any needle (longest wins a tie).
    let best = -1;
    let len = 0;
    for (const needle of needles) {
      const i = lower.indexOf(needle, at);
      if (
        i !== -1 &&
        (best === -1 || i < best || (i === best && needle.length > len))
      ) {
        best = i;
        len = needle.length;
      }
    }
    if (best === -1) break;
    if (best > at) parts.push({ text: text.slice(at, best), hit: false });
    parts.push({ text: text.slice(best, best + len), hit: true });
    at = best + len;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** Rehype step: wraps every hit in `<mark class="search-hit">`. */
export function rehypeSearchHighlight(options: { needles: readonly string[] }) {
  return (tree: Root) => {
    visit(tree, "text", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const parts = splitHits(node.value, options.needles);
      if (!parts.some((p) => p.hit)) return;
      const replacement: ElementContent[] = parts.map((p) =>
        p.hit
          ? {
              type: "element",
              tagName: "mark",
              properties: { className: [SEARCH_HIT_CLASS] },
              children: [{ type: "text", value: p.text }],
            }
          : { type: "text", value: p.text },
      );
      parent.children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
}
