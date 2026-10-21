import { describe, expect, test } from "bun:test";
import { encodeProjectDir, extractSnippet } from "./SessionStore";

describe("encodeProjectDir", () => {
  test("matches the CLI's session folder naming", () => {
    expect(encodeProjectDir("/Users/alex/brains/main")).toBe(
      "-Users-alex-brains-main",
    );
    expect(encodeProjectDir("/tmp/my.dir_x")).toBe("-tmp-my-dir-x");
  });
});

const line = (type: string, text: string) =>
  JSON.stringify({ type, message: { content: [{ type: "text", text }] } });

describe("extractSnippet", () => {
  test("finds a case-insensitive match with context and ellipses", () => {
    const jsonl = [
      line("user", "What did we agree with Acme?"),
      line(
        "assistant",
        `${"x".repeat(100)} the Acme retainer is €2,400 per month ${"y".repeat(100)}`,
      ),
    ].join("\n");
    const hit = extractSnippet(jsonl, "retainer is €2,400");
    expect(hit).toContain("retainer is €2,400 per month");
    expect(hit!.startsWith("…")).toBe(true);
    expect(hit!.endsWith("…")).toBe(true);
  });

  test("ignores tool payloads and non-message lines", () => {
    const jsonl = [
      JSON.stringify({
        type: "system",
        toolUseResult: "secret-needle in tool output",
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "secret-needle again" }],
        },
      }),
    ].join("\n");
    expect(extractSnippet(jsonl, "secret-needle")).toBeNull();
  });

  test("skips injected <system-reminder>-style payloads", () => {
    const jsonl = line(
      "user",
      "<system-reminder>needle inside reminder</system-reminder>",
    );
    expect(extractSnippet(jsonl, "needle")).toBeNull();
  });

  test("no match → null; malformed lines don't throw", () => {
    expect(
      extractSnippet(`{broken json\n${line("user", "hello")}`, "absent"),
    ).toBeNull();
  });
});
