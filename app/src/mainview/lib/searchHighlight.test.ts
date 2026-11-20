import { describe, expect, test } from "bun:test";
import { findSearchMatches, splitHits } from "./searchHighlight";

describe("findSearchMatches", () => {
  const texts = ["Kickoff notes", "The Q3 budget review", "budget again"];

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
