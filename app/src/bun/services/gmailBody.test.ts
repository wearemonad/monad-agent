import { describe, expect, test } from "bun:test";
import { extractBody } from "./GoogleDriveService";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("extractBody (Gmail payload)", () => {
  test("prefers the text/plain part in a multipart tree", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("plain wins") } },
            { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "a.pdf",
          body: { attachmentId: "x" },
        },
      ],
    };
    expect(extractBody(payload)).toBe("plain wins");
  });

  test("falls back to the top-level body when there are no parts", () => {
    expect(
      extractBody({ mimeType: "text/html", body: { data: b64("<b>hi</b>") } }),
    ).toBe("<b>hi</b>");
  });

  test("empty payload → empty string", () => {
    expect(extractBody(undefined)).toBe("");
    expect(extractBody({})).toBe("");
  });
});
