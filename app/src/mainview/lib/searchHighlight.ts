import type { ElementContent, Root } from "hast";
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
  /** Index (into the searched texts) of the first text with a match, or -1. */
  first: number;
};

const NONE: SearchMatches = { needles: [], count: 0, first: -1 };

function countIn(lower: string, needle: string): number {
  let n = 0;
  for (
    let i = lower.indexOf(needle);
    i !== -1;
    i = lower.indexOf(needle, i + needle.length)
  )
    n++;
  return n;
}

function matchAll(texts: string[], needles: string[]): SearchMatches {
  let count = 0;
  let first = -1;
  texts.forEach((text, i) => {
    const lower = text.toLowerCase();
    const n = needles.reduce((sum, needle) => sum + countIn(lower, needle), 0);
    if (n > 0 && first === -1) first = i;
    count += n;
  });
  return count > 0 ? { needles, count, first } : NONE;
}

/** Matches for a search term across texts. A term that matches nowhere as a
 *  phrase falls back to its words (three letters or more); a hybrid-search
 *  hit can also match only semantically, and then nothing is marked. */
export function findSearchMatches(
  texts: string[],
  term: string | null,
): SearchMatches {
  const phrase = term?.trim().toLowerCase() ?? "";
  if (phrase.length < 2) return NONE;
  const exact = matchAll(texts, [phrase]);
  if (exact.count > 0) return exact;
  const words = [...new Set(phrase.split(/\s+/).filter((w) => w.length >= 3))];
  return words.length > 1 ? matchAll(texts, words) : NONE;
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
