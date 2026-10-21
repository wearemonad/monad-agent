import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexThreadStore, type CodexThreadRecord } from "./CodexThreadStore";

const dirs: string[] = [];
function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-threads-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function record(over: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  return {
    threadId: "01a0f631-9bc9-75c1-9d5c-3ebe311e5e88",
    workspaceId: "ws1",
    provider: "openai-subscription",
    model: "gpt-6-astra",
    title: "Hello",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    items: [{ type: "user", text: "Hello" }],
    ...over,
  };
}

describe("CodexThreadStore", () => {
  test("round-trips, lists newest first, renames and removes", () => {
    const cwd = tmpWorkspace();
    const store = new CodexThreadStore();
    store.write(cwd, record());
    store.write(
      cwd,
      record({ threadId: "t-2", updatedAt: "2026-10-01T11:00:00.000Z" }),
    );
    expect(store.list(cwd, "ws1").map((s) => s.sessionId)).toEqual([
      "t-2",
      "01a0f631-9bc9-75c1-9d5c-3ebe311e5e88",
    ]);
    expect(store.rename(cwd, "t-2", "  Renamed ")).toBe(true);
    expect(store.read(cwd, "t-2")?.title).toBe("Renamed");
    expect(store.remove(cwd, "t-2")).toBe(true);
    expect(store.has(cwd, "t-2")).toBe(false);
  });

  test("scopes the listing to its workspace and skips empty threads", () => {
    const cwd = tmpWorkspace();
    const store = new CodexThreadStore();
    store.write(cwd, record({ threadId: "other", workspaceId: "ws2" }));
    store.write(cwd, record({ threadId: "empty", items: [] }));
    expect(store.list(cwd, "ws1")).toEqual([]);
  });

  test("refuses ids that could escape the threads directory", () => {
    const cwd = tmpWorkspace();
    const store = new CodexThreadStore();
    expect(store.has(cwd, "../../etc/passwd")).toBe(false);
    expect(store.read(cwd, "../secrets")).toBeNull();
    expect(store.remove(cwd, "../x")).toBe(false);
  });
});
