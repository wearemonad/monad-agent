import { describe, expect, test } from "bun:test";
import {
  type BlockSplit,
  splitMarkdownBlocks,
  splitStreaming,
} from "./markdownBlocks";

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

/** A document with every construct the splitter cares about, including a
 *  list item ("1. b") whose first character alone ("1") isn't one yet. */
const DOC = [
  "## Plan",
  "",
  "Intro paragraph with **bold**.",
  "",
  "- a",
  "",
  "1. b",
  "",
  "   continued",
  "",
  "```ts",
  "const x = 1;",
  "",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "Closing line.",
].join("\n");

describe("splitStreaming", () => {
  test("after every streamed prefix, matches a full split of it", () => {
    let prev: BlockSplit | undefined;
    for (let n = 0; n <= DOC.length; n++) {
      const text = DOC.slice(0, n);
      prev = splitStreaming(text, prev);
      expect(prev.blocks).toEqual(splitMarkdownBlocks(text));
    }
  });

  test("in bigger steps too, as a stream batch delivers them", () => {
    let prev: BlockSplit | undefined;
    for (let n = 0; n <= DOC.length; n += 7) {
      prev = splitStreaming(DOC.slice(0, n), prev);
      expect(prev.blocks).toEqual(splitMarkdownBlocks(DOC.slice(0, n)));
    }
  });

  test("a definition arriving late merges everything, like a full split", () => {
    const first = splitStreaming("See [docs][d].\n\nMore.");
    const text = "See [docs][d].\n\nMore.\n\n[d]: https://x.dev";
    expect(splitStreaming(text, first).blocks).toEqual([text]);
  });

  test("text that doesn't extend the previous one starts over", () => {
    const first = splitStreaming("One.\n\nTwo.");
    expect(splitStreaming("Other.\n\nText.", first).blocks).toEqual([
      "Other.",
      "Text.",
    ]);
  });
});
