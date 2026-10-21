import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkspaceEnv } from "./envFile";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-env-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (contents: string) =>
  fs.writeFileSync(path.join(dir, ".env"), contents);

describe("loadWorkspaceEnv", () => {
  test("missing file → empty", () => {
    expect(loadWorkspaceEnv(dir)).toEqual({});
  });

  test("basic KEY=VALUE, export prefix, and quotes", () => {
    write(`FOO=bar\nexport BAZ=qux\nQUOTED="hello world"\nSINGLE='a b'\n`);
    expect(loadWorkspaceEnv(dir)).toEqual({
      FOO: "bar",
      BAZ: "qux",
      QUOTED: "hello world",
      SINGLE: "a b",
    });
  });

  test("comments: full-line and inline on unquoted values", () => {
    write(`# a comment\nKEY=abc123 # from settings\nBARE=value\n`);
    const env = loadWorkspaceEnv(dir);
    expect(env.KEY).toBe("abc123");
    expect(env.BARE).toBe("value");
  });

  test("a '#' inside a quoted value is preserved (not a comment)", () => {
    write(`PW="a#b#c"\n`);
    expect(loadWorkspaceEnv(dir).PW).toBe("a#b#c");
  });

  test("a multiline double-quoted value spans lines", () => {
    write(`KEY="-----BEGIN-----\nline2\nline3-----END-----"\nNEXT=ok\n`);
    const env = loadWorkspaceEnv(dir);
    expect(env.KEY).toBe("-----BEGIN-----\nline2\nline3-----END-----");
    expect(env.NEXT).toBe("ok");
  });

  test("escaped \\n in a double-quoted value becomes a newline", () => {
    write(`KEY="-----BEGIN-----\\nmiddle\\n-----END-----"\n`);
    expect(loadWorkspaceEnv(dir).KEY).toBe(
      "-----BEGIN-----\nmiddle\n-----END-----",
    );
  });

  test("single-quoted values are literal (no escape processing)", () => {
    write(`KEY='a\\nb'\n`);
    expect(loadWorkspaceEnv(dir).KEY).toBe("a\\nb");
  });

  test("ignores malformed keys and blank lines", () => {
    write(`\n=noKey\n1BAD=x\nGOOD=y\n`);
    expect(loadWorkspaceEnv(dir)).toEqual({ GOOD: "y" });
  });
});
