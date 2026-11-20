import { LRUCache } from "lru-cache";
import type { ReactElement } from "react";

/** Rendered markdown by block text (PARALLEL-THREADS-PR5-RENDERING.html §5c).
 *  Revisiting a Thread, or a list item scrolling back into view, then skips
 *  the parse entirely. Keyed by the text itself rather than a hash: no
 *  collisions to reason about, and the size bound already counts it.
 *
 *  Only pure renders belong here: the cached element must depend on nothing
 *  but its text. Anything live (citation state, search highlights) lives in
 *  child components that read the store themselves, or skips the cache. */
const cache = new LRUCache<string, ReactElement>({
  // Total characters of cached text, like T3 Code's markdownRenderer.
  maxSize: 500_000,
  sizeCalculation: (_element, text) => Math.max(1, text.length),
});

export function cachedMarkdown(
  text: string,
  render: (text: string) => ReactElement,
): ReactElement {
  let element = cache.get(text);
  if (!element) {
    element = render(text);
    // A single block larger than the whole budget is rendered, not kept.
    if (text.length <= 500_000) cache.set(text, element);
  }
  return element;
}
