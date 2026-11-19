import { dequal } from "dequal";

/** `prev` when `next` is deep-equal to it, else `next`. Server pushes rebuild
 *  every object from JSON, so without this each push hands every subscriber a
 *  new reference and re-renders it, even when nothing changed. */
export function keepIfEqual<T>(prev: T, next: T): T {
  return dequal(prev, next) ? prev : next;
}

/** keepIfEqual for lists of rows, applied per row as well: a row (matched by
 *  `key`) that hasn't changed keeps its old object, so one changed row
 *  re-renders only that row. An entirely unchanged list returns `prev`. */
export function keepListIfEqual<T>(
  prev: readonly T[],
  next: readonly T[],
  key: (row: T) => string,
): T[] {
  const old = new Map<string, T>();
  for (const row of prev) old.set(key(row), row);
  let same = prev.length === next.length;
  const out = next.map((row, i) => {
    const before = old.get(key(row));
    const kept = before !== undefined && dequal(before, row) ? before : row;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? (prev as T[]) : out;
}

/** For a record of values (e.g. Thread lists by workspace id): each entry goes
 *  through `keepValue` (so its own reuse rules apply), and an entirely
 *  unchanged record — same keys, every entry kept — returns `prev`. */
export function keepRecordIfEqual<V>(
  prev: Record<string, V>,
  next: Record<string, V>,
  keepValue: (prev: V, next: V) => V,
): Record<string, V> {
  let same = Object.keys(prev).length === Object.keys(next).length;
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(next)) {
    out[key] = key in prev ? keepValue(prev[key], value) : value;
    if (out[key] !== prev[key]) same = false;
  }
  return same ? prev : out;
}
