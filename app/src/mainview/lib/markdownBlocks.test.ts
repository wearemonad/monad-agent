import { describe, expect, test } from "bun:test";
import { splitMarkdownBlocks } from "./markdownBlocks";

describe("splitMarkdownBlocks", () => {
  test("splits paragraphs at blank lines", () => {
    expect(splitMarkdownBlocks("One.\n\nTwo\nstill two.\n\n\nThree.")).toEqual([
      "One.",
      "Two\nstill two.",
      "Three.",
    ]);
  });

  test("keeps a fenced code block whole across its blank lines", () => {
    const fence = "```ts\nconst a = 1;\n\n\nconst b = 2;\n```";
    expect(splitMarkdownBlocks(`Intro.\n\n${fence}\n\nAfter.`)).toEqual([
      "Intro.",
      fence,
      "After.",
    ]);
  });

  test("a fence only closes on a matching marker at least as long", () => {
    const fence = "````md\n```\n\nstill inside\n~~~\n\n````";
    expect(splitMarkdownBlocks(`${fence}\n\nAfter.`)).toEqual([
      fence,
      "After.",
    ]);
  });

  test("keeps a loose, nested list whole", () => {
    const list = [
      "1. First",
      "",
      "   Continued paragraph.",
      "",
      "   - nested a",
      "",
      "   - nested b",
      "",
      "     ```sh",
      "     ls",
      "",
      "     ```",
      "",
      "2. Second",
    ].join("\n");
    expect(splitMarkdownBlocks(`Steps:\n\n${list}\n\nDone.`)).toEqual([
      "Steps:",
      list,
      "Done.",
    ]);
  });

  test("a list ends at a blank line followed by unindented text", () => {
    expect(splitMarkdownBlocks("- a\n- b\n\nAfter.\n\n- c")).toEqual([
      "- a\n- b",
      "After.",
      "- c",
    ]);
  });

  test("keeps a table whole", () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";
    expect(splitMarkdownBlocks(`Results:\n\n${table}\n\n## Next`)).toEqual([
      "Results:",
      table,
      "## Next",
    ]);
  });

  test("a heading at the very end is its own block", () => {
    expect(splitMarkdownBlocks("Body text.\n\n### Summary")).toEqual([
      "Body text.",
      "### Summary",
    ]);
  });

  test("text with link or footnote definitions stays one block", () => {
    const text =
      "See [the docs][d].\n\nMore[^1].\n\n[d]: https://x.dev\n[^1]: Note.";
    expect(splitMarkdownBlocks(text)).toEqual([text]);
  });

  test("empty text has no blocks", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("\n\n")).toEqual([]);
  });

  test("an unterminated fence (mid-stream) runs to the end", () => {
    expect(splitMarkdownBlocks("A.\n\n```\ncode\n\nmore")).toEqual([
      "A.",
      "```\ncode\n\nmore",
    ]);
  });
});
