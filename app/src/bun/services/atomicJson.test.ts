import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonAtomic, writeAtomic, writeJsonAtomic } from "./atomicJson";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-atomic-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeAtomic", () => {
  test("round-trips and creates missing directories", () => {
    const file = path.join(dir, "nested", "deep", "x.json");
    writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
  });

  test("leaves no temp files behind", () => {
    const file = path.join(dir, "x.json");
    writeAtomic(file, "hello");
    expect(fs.readdirSync(dir)).toEqual(["x.json"]);
  });

  test("overwrites existing content", () => {
    const file = path.join(dir, "x.json");
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ v: 2 });
  });
});

describe("readJsonAtomic", () => {
  test("returns the default when the file is absent (ENOENT)", () => {
    const out = readJsonAtomic(path.join(dir, "missing.json"), () => ({
      fresh: true,
    }));
    expect(out).toEqual({ fresh: true });
  });

  test("parses an existing valid file", () => {
    const file = path.join(dir, "x.json");
    writeJsonAtomic(file, { workspaces: [1, 2] });
    expect(
      readJsonAtomic(file, () => ({ workspaces: [] as number[] })),
    ).toEqual({
      workspaces: [1, 2],
    });
  });

  test("a corrupt file is quarantined, not overwritten, and the default returned", () => {
    const file = path.join(dir, "workspaces.json");
    fs.writeFileSync(file, '{"workspaces": [{"id":"a"'); // truncated write
    let corruptMsg = "";
    const out = readJsonAtomic(
      file,
      () => ({ workspaces: [], activeId: null }),
      {
        now: 12345,
        onCorrupt: (m) => (corruptMsg = m),
      },
    );
    expect(out).toEqual({ workspaces: [], activeId: null });
    // original bytes preserved for recovery
    expect(fs.existsSync(path.join(dir, "workspaces.json.corrupt-12345"))).toBe(
      true,
    );
    // and moved AWAY from the live path so nothing overwrites recoverable data
    expect(fs.existsSync(file)).toBe(false);
    expect(
      fs.readFileSync(path.join(dir, "workspaces.json.corrupt-12345"), "utf8"),
    ).toBe('{"workspaces": [{"id":"a"');
    expect(corruptMsg).toContain("corrupt");
  });

  test("a transient read error (a directory in place of a file) rethrows", () => {
    // EISDIR stands in for a lock/EACCES: the file is intact but unreadable —
    // returning a default here would let a caller save an empty doc over it.
    const asDir = path.join(dir, "locked.json");
    fs.mkdirSync(asDir);
    expect(() => readJsonAtomic(asDir, () => ({}))).toThrow();
  });
});
