import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMORY_REVIEW_INTERVAL,
  appendCapture,
  buildReviewPrompt,
  bumpReviewCounter,
  condenseLastExchange,
  dailyLogRelPath,
  resetReviewCounter,
} from "./memoryCapture";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-capture-"));
const ws = path.join(root, "brain");
fs.mkdirSync(path.join(ws, "knowledge"), { recursive: true });

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const line = (type: "user" | "assistant", text: string) =>
  JSON.stringify({ type, message: { content: [{ type: "text", text }] } });

describe("condenseLastExchange", () => {
  test("takes the LAST exchange and casts it to third person", () => {
    const jsonl = [
      line("user", "First question about pricing"),
      line("assistant", "First answer."),
      line("user", "And what did we agree with Acme?"),
      line("assistant", "Net-30 via Stripe, agreed in March."),
    ].join("\n");
    const ex = condenseLastExchange(jsonl, "2026-08-09")!;
    expect(ex.body).toContain("User asked: And what did we agree");
    expect(ex.body).toContain("Agent answered: Net-30 via Stripe");
    expect(ex.body).not.toContain("First question");
    expect(ex.hash).toHaveLength(12);
  });

  test("null for tool-only sessions with no visible exchange", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    });
    expect(condenseLastExchange(jsonl, "2026-08-09")).toBeNull();
  });
});

describe("appendCapture", () => {
  const now = new Date(2026, 7, 9, 14, 32); // local 2026-08-09 14:32

  test("creates the daily log with frontmatter, then appends without it", () => {
    const first = appendCapture(
      ws,
      "sess-1",
      { body: "User asked: A\nAgent answered: B", hash: "aaaaaaaaaaaa" },
      now,
    )!;
    expect(first.created).toBe(true);
    expect(first.relPath).toBe(dailyLogRelPath(now));
    const second = appendCapture(
      ws,
      "sess-1",
      { body: "User asked: C\nAgent answered: D", hash: "bbbbbbbbbbbb" },
      now,
    )!;
    expect(second.created).toBe(false);

    const file = fs.readFileSync(
      path.join(ws, "knowledge", first.relPath),
      "utf8",
    );
    expect(file).toContain("source: auto-capture");
    expect(file).toContain("## Auto-captured");
    expect(file).toContain("14:32 · session sess-1");
    expect(file).toContain("User asked: C");
    expect(file.match(/^---/gm)!.length).toBe(2); // one frontmatter block only
  });

  test("same exchange hash is a no-op (idempotent re-capture)", () => {
    const again = appendCapture(
      ws,
      "sess-1",
      { body: "User asked: A\nAgent answered: B", hash: "aaaaaaaaaaaa" },
      now,
    );
    expect(again).toBeNull();
    const file = fs.readFileSync(
      path.join(ws, "knowledge", dailyLogRelPath(now)),
      "utf8",
    );
    expect(file.split("cap:aaaaaaaaaaaa").length).toBe(2); // marker appears once
  });
});

describe("review cadence", () => {
  const stateFile = path.join(ws, ".monad", "memory-state.json");

  test("counter climbs to the interval, reset starts over", () => {
    resetReviewCounter(stateFile);
    let n = 0;
    for (let i = 0; i < MEMORY_REVIEW_INTERVAL; i++)
      n = bumpReviewCounter(stateFile);
    expect(n).toBe(MEMORY_REVIEW_INTERVAL);
    resetReviewCounter(stateFile);
    expect(bumpReviewCounter(stateFile)).toBe(1);
  });

  test("corrupt state restarts the count instead of failing", () => {
    fs.writeFileSync(stateFile, "{not json");
    expect(bumpReviewCounter(stateFile)).toBe(1);
  });

  test("review prompt names the daily logs and demands restraint", () => {
    const p = buildReviewPrompt(["2026-08-09", "2026-08-08"]);
    expect(p).toContain("knowledge/notes/daily/2026-08-09.md");
    expect(p).toContain("memory_remember");
    expect(p).toContain("Nothing to save.");
  });
});
