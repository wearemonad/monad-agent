import { describe, expect, test } from "bun:test";
import {
  assertHeaderSafe,
  parseEmailDraftInput,
  sanitizeAddressList,
} from "../../shared/email";
import { buildDraftMime } from "./googleTools";

describe("sanitizeAddressList (C6)", () => {
  test("accepts plain and display-name addresses, normalizing whitespace", () => {
    expect(sanitizeAddressList("a@b.com", "To")).toBe("a@b.com");
    expect(sanitizeAddressList("  a@b.com ,  c@d.com ", "To")).toBe(
      "a@b.com, c@d.com",
    );
    expect(sanitizeAddressList("Jane Doe <jane@corp.com>", "To")).toBe(
      "Jane Doe <jane@corp.com>",
    );
  });

  test("rejects a CRLF-injected recipient — the hidden-Bcc attack", () => {
    expect(() =>
      sanitizeAddressList("boss@corp.com\r\nBcc: exfil@attacker.com", "To"),
    ).toThrow(/line break|control/i);
    expect(() => sanitizeAddressList("a@b.com\nBcc: x@y.com", "To")).toThrow();
    expect(() => sanitizeAddressList("a@b.com\0", "To")).toThrow();
  });

  test("rejects malformed addresses", () => {
    expect(() => sanitizeAddressList("not-an-email", "To")).toThrow(
      /invalid address/i,
    );
    expect(() => sanitizeAddressList("a@b", "To")).toThrow();
  });

  test("required vs optional empty", () => {
    expect(() => sanitizeAddressList("", "To")).toThrow(/required/i);
    expect(sanitizeAddressList("", "Cc", true)).toBe("");
    expect(sanitizeAddressList("  ", "Cc", true)).toBe("");
  });
});

describe("assertHeaderSafe (Subject)", () => {
  test("passes clean subjects, rejects control chars", () => {
    expect(assertHeaderSafe("Quarterly report", "Subject")).toBe(
      "Quarterly report",
    );
    expect(() => assertHeaderSafe("Hi\r\nBcc: x@y.com", "Subject")).toThrow();
  });
});

describe("buildDraftMime enforces the guard", () => {
  test("a poisoned recipient never reaches a header line", () => {
    expect(() =>
      buildDraftMime({
        to: "boss@corp.com\r\nBcc: exfil@attacker.com",
        subject: "FYI",
        body: "hello",
      }),
    ).toThrow();
  });

  test("a clean draft produces well-formed headers", () => {
    const mime = buildDraftMime({
      to: "a@b.com",
      cc: "c@d.com",
      subject: "Hi",
      body: "body",
    });
    expect(mime).toContain("To: a@b.com");
    expect(mime).toContain("Cc: c@d.com");
    // no injected header lines: exactly the headers we emitted
    expect(
      mime
        .split("\r\n\r\n")[0]
        .split("\r\n")
        .filter((l) => /^Bcc:/i.test(l)),
    ).toEqual([]);
  });
});

describe("parseEmailDraftInput rejects poisoned card drafts", () => {
  const variants = [{ label: "A", body: "hello" }];
  test("a CRLF recipient yields null (renders as a plain tool row, not a card)", () => {
    expect(
      parseEmailDraftInput({
        to: "boss@corp.com\r\nBcc: exfil@attacker.com",
        subject: "Hi",
        variants,
      }),
    ).toBeNull();
  });

  test("a clean draft still parses", () => {
    const out = parseEmailDraftInput({
      to: "a@b.com",
      subject: "Hi",
      variants,
    });
    expect(out?.to).toBe("a@b.com");
  });
});
