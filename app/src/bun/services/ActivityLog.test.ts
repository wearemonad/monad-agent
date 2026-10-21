import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog } from "./ActivityLog";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-activity-test-"));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("ActivityLog", () => {
  test("appends JSONL entries with timestamps", () => {
    const log = new ActivityLog();
    log.append(dir, { kind: "run-started", detail: "hello", runId: "r1" });
    log.append(dir, {
      kind: "tool",
      detail: "Read · file.md · auto-allowed",
      runId: "r1",
    });

    const lines = fs
      .readFileSync(log.logPath(dir), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("run-started");
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[1].detail).toContain("auto-allowed");
  });

  test("never throws on an unwritable workspace", () => {
    const log = new ActivityLog();
    expect(() =>
      log.append("/nonexistent-root-path/nope", { kind: "tool", detail: "x" }),
    ).not.toThrow();
  });
});
