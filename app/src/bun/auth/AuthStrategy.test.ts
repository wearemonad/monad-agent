import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SubscriptionCliAuth } from "./AuthStrategy";

/** A machine with no claude/codex anywhere: empty HOME, empty PATH. */
let saved: { HOME?: string; PATH?: string };
let home: string;
beforeEach(() => {
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  home = fs.mkdtempSync(path.join(os.tmpdir(), "monad-auth-"));
  process.env.HOME = home;
  process.env.PATH = path.join(home, "bin");
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

function installOnPath(name: string): string {
  const dir = path.join(home, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe("CLI lookup before the login-shell PATH has arrived", () => {
  test("Claude: 'not found' waits for the shell PATH, then the CLI is found on it", () => {
    let pending: Promise<void> | null = new Promise(() => {});
    const auth = new SubscriptionCliAuth(undefined, () => pending);
    expect(() => auth.validate()).not.toThrow();
    // The shell answers: its PATH has the CLI.
    const bin = installOnPath("claude");
    pending = null;
    expect(auth.resolveBinary()).toBe(bin);
  });

  test("Claude: once the shell PATH is in, a missing CLI is reported", () => {
    const auth = new SubscriptionCliAuth(undefined, () => null);
    expect(() => auth.validate()).toThrow(/Claude Code CLI not found/);
  });

  test("Claude: a configured path that doesn't exist is reported at once", () => {
    const auth = new SubscriptionCliAuth(
      () => path.join(home, "nope"),
      () => new Promise(() => {}),
    );
    expect(() => auth.validate()).toThrow(/does not exist/);
  });
});
