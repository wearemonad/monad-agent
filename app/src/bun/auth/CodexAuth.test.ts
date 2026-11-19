import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexCli, parseLoginStatus } from "./CodexAuth";

describe("parseLoginStatus", () => {
  test("exit 0 is signed in, naming the method", () => {
    expect(parseLoginStatus(0, "Logged in using ChatGPT\n")).toEqual({
      loggedIn: true,
      method: "ChatGPT",
    });
    expect(parseLoginStatus(0, "Logged in using an API key")).toEqual({
      loggedIn: true,
      method: "API key",
    });
  });

  test("a non-zero exit saying so is plainly signed out", () => {
    expect(parseLoginStatus(1, "Not logged in")).toEqual({ loggedIn: false });
  });

  test("anything else is an error, not a sign-out", () => {
    expect(parseLoginStatus(null, "", "spawn ENOENT")).toEqual({
      loggedIn: false,
      error: "spawn ENOENT",
    });
    expect(parseLoginStatus(2, "config error")).toEqual({
      loggedIn: false,
      error: "config error",
    });
  });
});

describe("codex login status is cached until a fresh check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-codex-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, "calls");
  const answer = path.join(dir, "answer");
  /** A stand-in `codex` that logs each call and answers from a file. */
  const bin = path.join(dir, "codex");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho x >> "${calls}"\nif [ "$(cat "${answer}")" = in ]; then echo "Logged in using ChatGPT"; exit 0; fi\necho "Not logged in" >&2; exit 1\n`,
  );
  fs.chmodSync(bin, 0o755);
  const spawns = () =>
    fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").split("\n").length - 1
      : 0;

  test("a signed-out answer is reused too, and fresh asks again", async () => {
    fs.writeFileSync(answer, "out");
    const cli = new CodexCli(() => bin);
    expect(await cli.statusAsync()).toEqual({ loggedIn: false });
    expect(await cli.statusAsync()).toEqual({ loggedIn: false });
    expect(spawns()).toBe(1);

    fs.writeFileSync(answer, "in"); // signed in from Terminal
    expect(await cli.statusAsync({ fresh: true })).toEqual({
      loggedIn: true,
      method: "ChatGPT",
    });
    expect(await cli.statusAsync()).toEqual({
      loggedIn: true,
      method: "ChatGPT",
    });
    expect(spawns()).toBe(2);
  });
});
