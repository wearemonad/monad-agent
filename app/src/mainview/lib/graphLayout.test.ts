import { describe, expect, test } from "bun:test";
import { carryLayout, POP_MS, type Placed, popIn } from "./graphLayout";

type N = Placed & { id: string };

describe("carryLayout", () => {
  test("first layout: nothing carried, nothing counts as new", () => {
    const nodes: N[] = [{ id: "a" }, { id: "b" }];
    const added = carryLayout(new Map(), nodes, [{ source: "a", target: "b" }]);
    expect(added.size).toBe(0);
    expect(nodes[0].x).toBeUndefined();
  });

  test("known nodes keep their position", () => {
    const prev = new Map<string, Placed>([
      ["a", { x: 10, y: -4, vx: 1, vy: 2 }],
    ]);
    const nodes: N[] = [{ id: "a" }];
    expect(carryLayout(prev, nodes, []).size).toBe(0);
    expect(nodes[0]).toMatchObject({ x: 10, y: -4, vx: 1, vy: 2 });
  });

  test("a new node starts next to the neighbor it links to", () => {
    const prev = new Map<string, Placed>([["a", { x: 100, y: 50 }]]);
    const nodes: N[] = [{ id: "a" }, { id: "b" }];
    const added = carryLayout(prev, nodes, [{ source: "b", target: "a" }]);
    expect([...added]).toEqual(["b"]);
    const d = Math.hypot((nodes[1].x ?? 0) - 100, (nodes[1].y ?? 0) - 50);
    expect(d).toBeCloseTo(14, 5);
  });

  test("a chain of new nodes grows outward from the old graph", () => {
    const prev = new Map<string, Placed>([["a", { x: 0, y: 0 }]]);
    // c only links to b, which is itself new — placed in a later pass.
    const nodes: N[] = [{ id: "c" }, { id: "b" }, { id: "a" }];
    carryLayout(prev, nodes, [
      { source: "c", target: "b" },
      { source: "b", target: "a" },
    ]);
    expect(nodes[0].x).toBeDefined();
    expect(nodes[1].x).toBeDefined();
  });

  test("a new node with no placed neighbor is left to the engine", () => {
    const prev = new Map<string, Placed>([["a", { x: 0, y: 0 }]]);
    const nodes: N[] = [{ id: "a" }, { id: "lonely" }];
    const added = carryLayout(prev, nodes, []);
    expect(added.has("lonely")).toBe(true);
    expect(nodes[1].x).toBeUndefined();
  });

  test("seed positions are deterministic", () => {
    const run = () => {
      const nodes: N[] = [{ id: "a" }, { id: "b" }];
      carryLayout(new Map([["a", { x: 0, y: 0 }]]), nodes, [
        { source: "a", target: "b" },
      ]);
      return [nodes[1].x, nodes[1].y];
    };
    expect(run()).toEqual(run());
  });
});

describe("popIn", () => {
  test("no birth time: fully present", () => {
    expect(popIn(undefined, 123)).toEqual({ scale: 1, alpha: 1 });
  });

  test("starts invisible and settles at full size", () => {
    const start = popIn(1000, 1000);
    expect(start.scale).toBeCloseTo(0, 9);
    expect(start.alpha).toBe(0);
    const end = popIn(1000, 1000 + POP_MS);
    expect(end.scale).toBeCloseTo(1, 9);
    expect(end.alpha).toBe(1);
    expect(popIn(1000, 1000 + POP_MS * 10).scale).toBeCloseTo(1, 9);
  });

  test("overshoots slightly on the way in", () => {
    const peak = Math.max(
      ...Array.from(
        { length: 50 },
        (_, i) => popIn(0, (i / 49) * POP_MS).scale,
      ),
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.15);
  });
});
