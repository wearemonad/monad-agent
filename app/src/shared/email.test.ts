import { describe, expect, test } from "bun:test";
import { parseEmailDraftInput } from "./email";

describe("parseEmailDraftInput", () => {
  const valid = {
    to: "darrel@example.com",
    subject: "Workshop quotation",
    variants: [
      { label: "Brief and clean", body: "Hi Darrel,\n\nThanks." },
      {
        label: "Warmer, more context",
        body: "Hi Darrel,\n\nThank you so much.",
      },
    ],
  };

  test("valid input normalizes into card data", () => {
    expect(parseEmailDraftInput(valid)).toEqual({
      to: "darrel@example.com",
      cc: undefined,
      subject: "Workshop quotation",
      variants: valid.variants,
    });
  });

  test("cc is kept when present, dropped when blank", () => {
    expect(parseEmailDraftInput({ ...valid, cc: "carl@example.com" })?.cc).toBe(
      "carl@example.com",
    );
    expect(parseEmailDraftInput({ ...valid, cc: "  " })?.cc).toBeUndefined();
  });

  test("missing recipient, subject, or variants → null", () => {
    expect(parseEmailDraftInput({ ...valid, to: " " })).toBe(null);
    expect(parseEmailDraftInput({ ...valid, subject: "" })).toBe(null);
    expect(parseEmailDraftInput({ ...valid, variants: [] })).toBe(null);
    expect(parseEmailDraftInput(null)).toBe(null);
  });

  test("malformed variants are filtered; empty labels get a fallback", () => {
    const parsed = parseEmailDraftInput({
      ...valid,
      variants: [
        { label: "", body: "hello" },
        { body: "no label field" },
        { label: "x", body: " " },
      ],
    });
    expect(parsed?.variants).toEqual([{ label: "Draft", body: "hello" }]);
  });

  test("variants are capped at 4", () => {
    const parsed = parseEmailDraftInput({
      ...valid,
      variants: Array.from({ length: 6 }, (_, i) => ({
        label: `v${i}`,
        body: `b${i}`,
      })),
    });
    expect(parsed?.variants).toHaveLength(4);
  });
});
