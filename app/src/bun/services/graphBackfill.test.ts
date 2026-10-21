import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GRAPH_BACKFILL_VERSION,
  MAX_BACKFILL_ATTEMPTS,
  backfillDue,
  backfillStatus,
  buildGraphBackfillPrompt,
  isGraphBackfillSafeTool,
  readBackfillState,
  writeBackfillState,
} from "./graphBackfill";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-backfill-test-"));
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

const done = (over: object = {}) => ({
  version: GRAPH_BACKFILL_VERSION,
  status: "done" as const,
  attempts: 1,
  finishedAt: "2026-10-12T10:00:00Z",
  ...over,
});

describe("backfillDue", () => {
  test("due when never run or run under an older version", () => {
    expect(backfillDue(null)).toBe(true);
    expect(backfillDue(done({ version: GRAPH_BACKFILL_VERSION - 1 }))).toBe(
      true,
    );
  });
  test("not due after success, an empty brain, or a deliberate stop", () => {
    expect(backfillDue(done())).toBe(false);
    expect(backfillDue(done({ status: "empty" }))).toBe(false);
    expect(backfillDue(done({ status: "stopped" }))).toBe(false);
  });
  test("failures retry, but only up to the cap", () => {
    expect(backfillDue(done({ status: "failed", attempts: 1 }))).toBe(true);
    expect(
      backfillDue(done({ status: "failed", attempts: MAX_BACKFILL_ATTEMPTS })),
    ).toBe(false);
  });
});

describe("state file", () => {
  test("round-trips per workspace", () => {
    expect(readBackfillState(ws)).toBeNull();
    writeBackfillState(ws, done({ reviewCount: 4 }));
    expect(readBackfillState(ws)?.reviewCount).toBe(4);
    expect(backfillStatus(readBackfillState(ws), false)).toEqual({
      state: "done",
      finishedAt: "2026-10-12T10:00:00Z",
      reviewCount: 4,
    });
    expect(backfillStatus(readBackfillState(ws), true)).toEqual({
      state: "running",
    });
  });
});

describe("isGraphBackfillSafeTool", () => {
  const allow = (tool: string, input: Record<string, unknown>) =>
    isGraphBackfillSafeTool(tool, input, ws);
  const k = (rel: string) => path.join(ws, "knowledge", rel);

  test("memory recall yes, working-memory writes no", () => {
    expect(allow("mcp__memory__memory_entities", {})).toBe(true);
    expect(allow("mcp__memory__memory_remember", {})).toBe(false);
  });
  test("edits knowledge docs, entity pages and INDEX.md", () => {
    expect(allow("Edit", { file_path: k("clients/acme.md") })).toBe(true);
    expect(allow("Write", { file_path: k("entities/acme-gmbh.md") })).toBe(
      true,
    );
    expect(allow("Edit", { file_path: k("INDEX.md") })).toBe(true);
  });
  test("never writes originals, daily logs, working memory, or outside knowledge/", () => {
    expect(allow("Edit", { file_path: k("originals/2026-x.pdf") })).toBe(false);
    expect(allow("Edit", { file_path: k("notes/daily/2026-09-15.md") })).toBe(
      false,
    );
    expect(allow("Write", { file_path: k("working-memory.md") })).toBe(false);
    expect(allow("Write", { file_path: path.join(ws, "inbox/x.md") })).toBe(
      false,
    );
    expect(allow("Write", { file_path: path.join(ws, "CLAUDE.md") })).toBe(
      false,
    );
    expect(allow("Write", { file_path: "/etc/hosts" })).toBe(false);
  });
  test("reads stay in the workspace; no shell", () => {
    expect(allow("Read", { file_path: k("notes/daily/2026-09-15.md") })).toBe(
      true,
    );
    expect(allow("Read", { file_path: "/Users/someone/.ssh/id_rsa" })).toBe(
      false,
    );
    expect(allow("Bash", { command: "ls knowledge" })).toBe(false);
  });
});

test("the prompt keeps edits additive and facts sourced", () => {
  const p = buildGraphBackfillPrompt();
  expect(p).toContain("Change nothing else");
  expect(p).toContain("Never invent");
  expect(p).toContain("knowledge/entities/<kebab-name>.md");
  expect(p).toContain("type: person | company | project | product | other");
});
