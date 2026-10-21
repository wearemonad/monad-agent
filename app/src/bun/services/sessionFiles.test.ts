import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeProjectDir,
  lastTagInFile,
  sessionEntrypoint,
  sessionHasMessages,
  transcriptDelivered,
} from "./sessionFiles";
import {
  assistantLine,
  filler,
  tagLine,
  userLine,
  withTempClaudeHome,
  writeSession,
} from "./sessionFixtures";

let env: ReturnType<typeof withTempClaudeHome>;
beforeEach(() => {
  env = withTempClaudeHome();
});
afterEach(() => env.restore());

describe("claudeProjectDir mirrors the SDK", () => {
  test("honours CLAUDE_CONFIG_DIR", () => {
    expect(
      claudeProjectDir(env.workspace).startsWith(
        path.join(process.env.CLAUDE_CONFIG_DIR!, "projects"),
      ),
    ).toBe(true);
  });

  test("short path: plain encoding, and the SDK finds our fixture there", async () => {
    const id = randomUUID();
    writeSession(env.workspace, id, [userLine(id, env.workspace, "hi")]);
    const found = await listSessions({ dir: env.workspace });
    expect(found.map((s) => s.sessionId)).toEqual([id]);
  });

  test("long path (>200 chars): truncated + hash suffix, same folder the SDK reads", async () => {
    let long = env.workspace;
    while (long.length <= 220)
      long = path.join(long, "a-rather-long-folder-name");
    fs.mkdirSync(long, { recursive: true });
    expect(path.basename(claudeProjectDir(long))).toMatch(/^.{200}-[0-9a-z]+$/);
    const id = randomUUID();
    writeSession(long, id, [userLine(id, long, "hi")]);
    const found = await listSessions({ dir: long });
    expect(found.map((s) => s.sessionId)).toEqual([id]);
  });

  test("symlinked workspace resolves to the real folder, like the SDK", async () => {
    const link = `${env.workspace}-link`;
    fs.symlinkSync(env.workspace, link);
    expect(claudeProjectDir(link)).toBe(claudeProjectDir(env.workspace));
    const id = randomUUID();
    writeSession(link, id, [userLine(id, env.workspace, "hi")]);
    const found = await listSessions({ dir: link });
    expect(found.map((s) => s.sessionId)).toEqual([id]);
  });
});

describe("lastTagInFile", () => {
  test("finds the last tag anywhere in the file, even behind MB-long lines", async () => {
    const id = randomUUID();
    const w = env.workspace;
    const file = writeSession(w, id, [
      userLine(id, w, "hi"),
      tagLine(id, "monad:ws1"),
      assistantLine(id, w, "y".repeat(2_000_000)), // one huge line
      ...filler(id, w, 200_000),
    ]);
    expect(await lastTagInFile(file)).toBe("monad:ws1");
  });

  test("last tag wins; a cleared tag reads as empty", async () => {
    const id = randomUUID();
    const w = env.workspace;
    const a = writeSession(w, id, [
      userLine(id, w, "hi"),
      tagLine(id, "monad:ws1"),
      tagLine(id, "monad:ws2"),
    ]);
    expect(await lastTagInFile(a)).toBe("monad:ws2");
    const id2 = randomUUID();
    const b = writeSession(w, id2, [
      userLine(id2, w, "hi"),
      tagLine(id2, "monad:ws1"),
      tagLine(id2, ""),
    ]);
    expect(await lastTagInFile(b)).toBe("");
  });

  test("no tag → null; missing file → null", async () => {
    const id = randomUUID();
    const file = writeSession(env.workspace, id, [
      userLine(id, env.workspace, 'mentions "type":"tag" in prose'),
    ]);
    expect(await lastTagInFile(file)).toBeNull();
    expect(await lastTagInFile(`${file}.missing`)).toBeNull();
  });

  test("a tag entry as the final line without a trailing newline", async () => {
    const id = randomUUID();
    const file = writeSession(env.workspace, id, [
      userLine(id, env.workspace, "hi"),
    ]);
    fs.appendFileSync(file, JSON.stringify(tagLine(id, "monad:ws1")));
    expect(await lastTagInFile(file)).toBe("monad:ws1");
  });
});

describe("sessionEntrypoint", () => {
  test("reads the entrypoint from the head", async () => {
    const id = randomUUID();
    const w = env.workspace;
    expect(
      await sessionEntrypoint(
        writeSession(w, id, [userLine(id, w, "hi", "cli")]),
      ),
    ).toBe("cli");
    const id2 = randomUUID();
    expect(
      await sessionEntrypoint(writeSession(w, id2, [userLine(id2, w, "hi")])),
    ).toBe("sdk-ts");
  });
});

describe("transcriptDelivered", () => {
  const ws = "/Users/x/ws";
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
  const toolResult = (id: string, isError = false) =>
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: isError,
            content: "ok",
          },
        ],
      },
    });

  test("a successful Write into outbox/ is a delivery (relative or absolute)", () => {
    expect(
      transcriptDelivered(
        [
          toolUse("t1", "Write", {
            file_path: "outbox/briefings/2026-09-30-briefing.md",
          }),
          toolResult("t1"),
        ].join("\n"),
        ws,
      ),
    ).toBe(true);
    expect(
      transcriptDelivered(
        [
          toolUse("t1", "Write", { file_path: `${ws}/outbox/briefings/b.md` }),
          toolResult("t1"),
        ].join("\n"),
        ws,
      ),
    ).toBe(true);
  });

  test("a successful gmail_create_draft is a delivery", () => {
    expect(
      transcriptDelivered(
        [
          toolUse("t1", "mcp__google__gmail_create_draft", { to: "a@b.c" }),
          toolResult("t1"),
        ].join("\n"),
        ws,
      ),
    ).toBe(true);
  });

  test("errored, pending, or out-of-outbox writes are not", () => {
    expect(
      transcriptDelivered(
        [
          toolUse("t1", "Write", { file_path: "outbox/b.md" }),
          toolResult("t1", true),
        ].join("\n"),
        ws,
      ),
    ).toBe(false);
    expect(
      transcriptDelivered(
        toolUse("t1", "Write", { file_path: "outbox/b.md" }),
        ws,
      ),
    ).toBe(false);
    expect(
      transcriptDelivered(
        [
          toolUse("t1", "Write", { file_path: "knowledge/b.md" }),
          toolResult("t1"),
        ].join("\n"),
        ws,
      ),
    ).toBe(false);
    expect(
      transcriptDelivered(
        [
          toolUse("t1", "Write", { file_path: "../outbox/b.md" }),
          toolResult("t1"),
        ].join("\n"),
        ws,
      ),
    ).toBe(false);
  });

  test("the CLI's synthetic API-error text never counts", () => {
    expect(
      transcriptDelivered(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "API Error: 529 overloaded" }],
          },
        }),
        ws,
      ),
    ).toBe(false);
  });
});

describe("sessionHasMessages", () => {
  test("metadata-only file → false; a real message anywhere → true", async () => {
    const w = env.workspace;
    const ghost = randomUUID();
    expect(
      await sessionHasMessages(
        writeSession(w, ghost, [tagLine(ghost, "monad:ws1")]),
      ),
    ).toBe(false);
    const big = randomUUID();
    expect(
      await sessionHasMessages(
        writeSession(w, big, [userLine(big, w, "z".repeat(500_000))]),
      ),
    ).toBe(true);
  });

  test("missing file → false", async () => {
    expect(await sessionHasMessages(`${env.workspace}/nope.jsonl`)).toBe(false);
  });
});
