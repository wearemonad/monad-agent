import { describe, expect, test } from "bun:test";
import { buildDraftMime, encodeHeaderValue } from "./googleTools";

describe("encodeHeaderValue", () => {
  test("leaves pure-ASCII values untouched", () => {
    expect(encodeHeaderValue("Following up on our call")).toBe(
      "Following up on our call",
    );
  });

  test("wraps non-ASCII values as an RFC 2047 encoded-word", () => {
    const encoded = encodeHeaderValue("Following up — we're going to pass");
    expect(encoded).toStartWith("=?UTF-8?B?");
    expect(encoded).toEndWith("?=");
    const b64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(
      "Following up — we're going to pass",
    );
  });
});

describe("buildDraftMime", () => {
  const draft = {
    to: "darrell@example.com",
    cc: "alex@example.com",
    subject: "Following up — we're going to pass",
    body: "Thanks for the demo — we'll pass for now.\n\nBest,\nAlex",
  };

  test("every line is pure ASCII (headers must never carry raw UTF-8)", () => {
    for (const line of buildDraftMime(draft).split("\r\n")) {
      expect(/^[\x00-\x7f]*$/.test(line)).toBe(true);
    }
  });

  test("declares UTF-8 charset and base64 transfer encoding", () => {
    const mime = buildDraftMime(draft);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain("MIME-Version: 1.0");
  });

  test("body round-trips non-ASCII text through base64", () => {
    const mime = buildDraftMime(draft);
    const body = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe(draft.body);
  });

  test("omits Cc when absent and keeps ASCII subjects readable", () => {
    const mime = buildDraftMime({
      to: "a@b.com",
      subject: "Quick question",
      body: "Hi",
    });
    expect(mime).not.toContain("Cc:");
    expect(mime).toContain("Subject: Quick question");
  });

  test("wraps long base64 bodies at 76 characters", () => {
    const mime = buildDraftMime({
      to: "a@b.com",
      subject: "x",
      body: "long text ".repeat(50),
    });
    const body = mime.split("\r\n\r\n")[1];
    for (const line of body.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(76);
  });
});
