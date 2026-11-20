import { describe, expect, test } from "bun:test";
import { findSearchMatches, splitHits } from "./searchHighlight";

describe("findSearchMatches", () => {
  const texts = ["Kickoff notes", "The Q3 budget review", "budget again"].map(
    (text) => ({ text, markdown: false }),
  );

  test("counts a phrase case-insensitively and finds its first text", () => {
    expect(findSearchMatches(texts, "  BUDGET ")).toEqual({
      needles: ["budget"],
      count: 2,
      first: 1,
    });
  });

  test("a phrase that matches nowhere falls back to its longer words", () => {
    expect(findSearchMatches(texts, "budget of kickoff")).toEqual({
      needles: ["budget", "kickoff"],
      count: 3,
      first: 0,
    });
  });

  test("too short a term, or no match at all, finds nothing", () => {
    const none = { needles: [], count: 0, first: -1 };
    expect(findSearchMatches(texts, "b")).toEqual(none);
    expect(findSearchMatches(texts, null)).toEqual(none);
    expect(findSearchMatches(texts, "roadmap")).toEqual(none);
  });

  test("markdown counts what renders: not URLs, not markup", () => {
    const md = (text: string) => ({ text, markdown: true });
    expect(
      findSearchMatches(
        [md("See [the docs](https://budget.example) and `budget.md`.")],
        "budget",
      ).count,
    ).toBe(1);
    // "**" splits the phrase across two rendered runs, so it can't be
    // marked as one — and isn't counted as one; its words are.
    expect(findSearchMatches([md("A **big** budget")], "big budget")).toEqual({
      needles: ["big", "budget"],
      count: 2,
      first: 0,
    });
  });
});

describe("splitHits", () => {
  test("keeps the original casing in hit and non-hit runs", () => {
    expect(splitHits("Plan the plan", ["plan"])).toEqual([
      { text: "Plan", hit: true },
      { text: " the ", hit: false },
      { text: "plan", hit: true },
    ]);
  });

  test("a longer needle wins where two start at the same place", () => {
    expect(splitHits("budgeting", ["budget", "budgeting"])).toEqual([
      { text: "budgeting", hit: true },
    ]);
  });
});
