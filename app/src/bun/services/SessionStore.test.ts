import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { matchesJobPrompt, SessionStore } from "./SessionStore";
import * as sessionFiles from "./sessionFiles";
import {
  readSessionOwners,
  recordSessionKind,
  recordSessionOwner,
} from "./sessionMeta";
import {
  aiTitleLine,
  assistantLine,
  filler,
  tagLine,
  userLine,
  withTempClaudeHome,
  writeSession,
} from "./sessionFixtures";

/** Integration tests against the REAL SDK listSessions, over JSONL fixtures
 *  in a temp CLAUDE_CONFIG_DIR. The SDK reports a session's tag from the
 *  last 64 KB of its file only — these pin down that Monad threads stay
 *  listed after a long run pushes the tag out of that window. */

const WS = "ws1";
let env: ReturnType<typeof withTempClaudeHome>;
let cwd: string;
const store = new SessionStore();
const ids = async () =>
  (await store.list(cwd, WS)).map((s) => s.sessionId).sort();

beforeEach(() => {
  env = withTempClaudeHome();
  cwd = env.workspace;
});
afterEach(() => env.restore());

/** A Monad thread tagged at run start, then `after` bytes of transcript. */
function thread(after: number, tag = `monad:${WS}`, prompt = "hello"): string {
  const id = randomUUID();
  writeSession(cwd, id, [
    userLine(id, cwd, prompt),
    tagLine(id, tag),
    ...filler(id, cwd, after),
    assistantLine(id, cwd, "done"),
  ]);
  return id;
}

describe("SessionStore.list — which sessions are Monad threads", () => {
  test("tag inside the tail window → listed without any file scan (fast path)", async () => {
    const id = thread(1_000);
    const scan = spyOn(sessionFiles, "lastTagInFile");
    expect(await ids()).toEqual([id]);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  test("tag pushed >64 KB back by a long run → recovered by scan, cached", async () => {
    const id = thread(150_000);
    const scan = spyOn(sessionFiles, "lastTagInFile");
    expect(await ids()).toEqual([id]);
    // (also proves the spy sees SessionStore's calls, so the "not called"
    // assertions elsewhere aren't vacuous)
    expect(scan).toHaveBeenCalledTimes(1);
    expect(readSessionOwners(cwd)[id]).toEqual({ owner: WS });
    // Second listing trusts the cache — no re-read of the transcript.
    scan.mockClear();
    expect(await ids()).toEqual([id]);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  test("recorded owner, no tag anywhere (tagSession failed) → listed", async () => {
    const id = randomUUID();
    writeSession(cwd, id, [
      userLine(id, cwd, "hi"),
      assistantLine(id, cwd, "ok"),
    ]);
    recordSessionOwner(cwd, id, WS);
    expect(await ids()).toEqual([id]);
  });

  test("never-tagged SDK session (hidden ingest run) → hidden, negative cached", async () => {
    const id = randomUUID();
    writeSession(cwd, id, [
      userLine(id, cwd, "ingest"),
      ...filler(id, cwd, 100_000),
    ]);
    expect(await ids()).toEqual([]);
    expect(readSessionOwners(cwd)[id]?.owner).toBeNull();
    const scan = spyOn(sessionFiles, "lastTagInFile");
    expect(await ids()).toEqual([]);
    expect(scan).not.toHaveBeenCalled(); // unchanged file → no rescan
    scan.mockRestore();
  });

  test("terminal Claude Code sessions are never scanned", async () => {
    const id = randomUUID();
    writeSession(cwd, id, [
      userLine(id, cwd, "terminal", "cli"),
      tagLine(id, `monad:${WS}`),
      ...filler(id, cwd, 100_000),
    ]);
    const scan = spyOn(sessionFiles, "lastTagInFile");
    expect(await ids()).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  test("another workspace's tag → not listed (tail or scanned)", async () => {
    thread(1_000, "monad:other");
    thread(150_000, "monad:other");
    expect(await ids()).toEqual([]);
  });

  test("a message-less ghost carrying a Monad tag stays hidden", async () => {
    const id = randomUUID();
    // Shaped like the fork a prewarmed resume leaves: the parent's metadata
    // (title + tag) and no messages. The SDK lists it (it has a title) with
    // no firstPrompt — the file check must confirm it's empty.
    writeSession(cwd, id, [
      aiTitleLine(id, "Parent thread"),
      tagLine(id, `monad:${WS}`),
    ]);
    const listed = await listSessions({ dir: cwd });
    expect(listed.map((s) => s.sessionId)).toContain(id);
    expect(await ids()).toEqual([]);
  });

  test(">200 newer non-Monad sessions don't push an older thread off the list", async () => {
    const old = new Date(Date.now() - 86_400_000);
    const id = randomUUID();
    writeSession(
      cwd,
      id,
      [userLine(id, cwd, "old thread"), tagLine(id, `monad:${WS}`)],
      old,
    );
    for (let i = 0; i < 205; i++) {
      const other = randomUUID();
      writeSession(cwd, other, [userLine(other, cwd, `terminal ${i}`, "cli")]);
    }
    expect(await ids()).toEqual([id]);
  });
});

describe("SessionStore.list — ghost filter (F9)", () => {
  test("a thread whose first message is >64 KB is listed (SDK gives no firstPrompt)", async () => {
    const id = randomUUID();
    writeSession(cwd, id, [
      userLine(id, cwd, `Please review this: ${"p".repeat(100_000)}`),
      tagLine(id, `monad:${WS}`),
      assistantLine(id, cwd, "Reviewed."),
      aiTitleLine(id, "Document review"),
    ]);
    const [info] = (await listSessions({ dir: cwd })).filter(
      (s) => s.sessionId === id,
    );
    expect(info.firstPrompt).toBeUndefined(); // the SDK limitation itself
    expect(await ids()).toEqual([id]);
  });

  test("the file check is cached until the file changes", async () => {
    const id = randomUUID();
    writeSession(cwd, id, [
      userLine(id, cwd, "x".repeat(100_000)),
      tagLine(id, `monad:${WS}`),
      aiTitleLine(id, "Big paste"),
    ]);
    const check = spyOn(sessionFiles, "sessionHasMessages");
    expect(await ids()).toEqual([id]);
    expect(check).toHaveBeenCalledTimes(1);
    check.mockClear();
    expect(await ids()).toEqual([id]);
    expect(check).not.toHaveBeenCalled();
    check.mockRestore();
  });
});

describe("SessionStore.list — briefing kind", () => {
  test("stamped kind wins; unstamped scheduled briefings are recognised by prompt", async () => {
    const prompt =
      "Run the morning-briefing skill and produce today's briefing.";
    const stamped = thread(1_000, `monad:${WS}`, prompt);
    const legacy = thread(1_000, `monad:${WS}`, prompt);
    const chat = thread(1_000, `monad:${WS}`, "what's up");
    recordSessionKind(cwd, stamped, "briefing");
    const kinds = Object.fromEntries(
      (await store.list(cwd, WS, [prompt])).map((s) => [s.sessionId, s.kind]),
    );
    expect(kinds[stamped]).toBe("briefing");
    expect(kinds[legacy]).toBe("briefing");
    expect(kinds[chat]).toBeUndefined();
  });

  test("matchesJobPrompt handles the SDK's ~200-char '…' truncation", () => {
    const long = `Run the briefing. ${"context ".repeat(40)}`;
    expect(matchesJobPrompt(`${long.slice(0, 200).trim()}…`, [long])).toBe(
      true,
    );
    expect(matchesJobPrompt("Run the briefing.", ["Run the  briefing. "])).toBe(
      true,
    );
    expect(matchesJobPrompt("Something else", [long])).toBe(false);
    expect(matchesJobPrompt(undefined, [long])).toBe(false);
    expect(matchesJobPrompt("x", [""])).toBe(false);
  });
});

describe("SessionStore.remove", () => {
  test("forgets the recorded owner", async () => {
    const id = thread(1_000);
    recordSessionOwner(cwd, id, WS);
    expect(await store.remove(cwd, id)).toBe(true);
    expect(readSessionOwners(cwd)[id]).toBeUndefined();
    expect(await ids()).toEqual([]);
  });
});
