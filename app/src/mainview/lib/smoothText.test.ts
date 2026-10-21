import { describe, expect, test } from "bun:test";
import { nextReveal } from "./smoothText";

describe("nextReveal", () => {
  test("advances at the base rate when nearly caught up", () => {
    // backlog 1 → rate ≈ 98 cps → ~1.6 chars per 16ms frame
    const next = nextReveal(99, 100, 16);
    expect(next).toBe(100); // clamped to target
  });

  test("never overshoots the target", () => {
    expect(nextReveal(0, 5, 10_000)).toBe(5);
    expect(nextReveal(7, 5, 16)).toBe(5); // target shrank (reset) → snap
  });

  test("catch-up rate scales with backlog so it converges on fast streams", () => {
    const smallBacklog = nextReveal(0, 20, 16) - 0;
    const bigBacklog = nextReveal(0, 2000, 16) - 0;
    expect(bigBacklog).toBeGreaterThan(smallBacklog * 10);
    // A 2000-char flush still drains in a couple of seconds, not minutes.
    // (The gentle catch-up trades some drain speed for continuous glide —
    // see CATCHUP_PER_CHAR in smoothText.ts.)
    let pos = 0;
    let frames = 0;
    while (pos < 2000 && frames < 200) {
      pos = nextReveal(pos, 2000, 16);
      frames++;
    }
    expect(frames).toBeLessThan(140); // < ~2.3s at 60fps
  });

  test("accumulates fractional progress across frames", () => {
    // tiny dt: less than a whole char per frame, but progress is monotonic
    const a = nextReveal(0, 100, 2);
    const b = nextReveal(a, 100, 2);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });
});
