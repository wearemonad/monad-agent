/** Incremental layout for the knowledge-graph viewer. A refresh hands the
 *  force engine fresh node copies; without help each one starts from scratch
 *  and the whole graph reshuffles on every poll. These helpers carry the last
 *  drawn positions over, start new nodes beside a neighbor they link to, and
 *  time their entrance. */

export type Placed = { x?: number; y?: number; vx?: number; vy?: number };

type LinkEnds = { source: string; target: string };

/** How far from its neighbor a new node starts, in graph units — close
 *  enough to read as growing out of that cluster, far enough that the
 *  collide force doesn't fling it. */
const SEED_DISTANCE = 14;

/** Stable 0..1 from an id, so a node's starting angle is the same on every
 *  run (and in recordings) rather than random. */
function unitHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32;
}

/** Copy positions from `prev` (the previous layout's nodes, by id) onto
 *  `nodes` in place. Nodes `prev` doesn't know start next to an already-placed
 *  neighbor — resolved in passes, so a chain of new nodes grows outward from
 *  the old graph. A new node with no placed neighbor is left to the engine.
 *  Returns the new nodes' ids; empty on the first layout (nothing to grow
 *  from, so nothing counts as new). */
export function carryLayout<N extends Placed & { id?: string | number }>(
  prev: ReadonlyMap<string, Placed>,
  nodes: N[],
  links: readonly LinkEnds[],
): Set<string> {
  const added = new Set<string>();
  if (prev.size === 0) return added;

  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  for (const [id, n] of byId) {
    const old = prev.get(id);
    if (old?.x !== undefined && old.y !== undefined) {
      n.x = old.x;
      n.y = old.y;
      n.vx = old.vx ?? 0;
      n.vy = old.vy ?? 0;
    } else added.add(id);
  }

  const adjacent = new Map<string, string[]>();
  for (const l of links) {
    adjacent.set(l.source, [...(adjacent.get(l.source) ?? []), l.target]);
    adjacent.set(l.target, [...(adjacent.get(l.target) ?? []), l.source]);
  }

  let pending = [...added];
  while (pending.length) {
    const next: string[] = [];
    for (const id of pending) {
      const n = byId.get(id);
      const anchor = (adjacent.get(id) ?? [])
        .map((a) => byId.get(a))
        .find((a) => a?.x !== undefined && a.y !== undefined);
      if (!n || !anchor) {
        next.push(id);
        continue;
      }
      const angle = unitHash(id) * 2 * Math.PI;
      n.x = (anchor.x ?? 0) + Math.cos(angle) * SEED_DISTANCE;
      n.y = (anchor.y ?? 0) + Math.sin(angle) * SEED_DISTANCE;
      n.vx = 0;
      n.vy = 0;
    }
    // No progress: the rest have no placed neighbor at all.
    if (next.length === pending.length) break;
    pending = next;
  }
  return added;
}

/** Length of a new node's entrance, in ms. */
export const POP_MS = 520;

/** Entrance progress for a node added at `bornAt`: scale (overshoots
 *  slightly, then settles at 1) and opacity (fades in over the first half).
 *  Nodes with no birth time are fully present. */
export function popIn(
  bornAt: number | undefined,
  now: number,
): { scale: number; alpha: number } {
  if (bornAt === undefined) return { scale: 1, alpha: 1 };
  const t = Math.min(1, Math.max(0, (now - bornAt) / POP_MS));
  // easeOutBack
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const scale = 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  return { scale, alpha: Math.min(1, t * 2) };
}
