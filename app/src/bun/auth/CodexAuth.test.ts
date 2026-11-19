import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CodexCli,
  OpenAISubscriptionAuth,
  parseLoginStatus,
} from "./CodexAuth";

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

describe("Codex CLI lookup before the login-shell PATH has arrived", () => {
  /** A machine with no codex anywhere: empty HOME, empty PATH. */
  let saved: { HOME?: string; PATH?: string };
  let home: string;
  beforeEach(() => {
    saved = { HOME: process.env.HOME, PATH: process.env.PATH };
    home = fs.mkdtempSync(path.join(os.tmpdir(), "monad-codex-path-"));
    process.env.HOME = home;
    process.env.PATH = path.join(home, "bin");
  });
  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("validate() lets 'not found' through until the PATH is in", () => {
    let pending: Promise<void> | null = new Promise(() => {});
    const auth = new OpenAISubscriptionAuth(
      new CodexCli(undefined, () => pending),
    );
    expect(() => auth.validate()).not.toThrow();
    pending = null;
    expect(() => auth.validate()).toThrow(/Codex CLI not found/);
  });

  test("status waits for the PATH, finds the CLI on it, and doesn't cache a miss", async () => {
    let arrive = () => {};
    let pending: Promise<void> | null = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const cli = new CodexCli(undefined, () => pending);
    const status = cli.statusAsync();
    // The shell answers with a PATH that has codex on it.
    fs.mkdirSync(path.join(home, "bin"));
    const bin = path.join(home, "bin", "codex");
    fs.writeFileSync(bin, "#!/bin/sh\necho 'Not logged in' >&2; exit 1\n");
    fs.chmodSync(bin, 0o755);
    pending = null;
    arrive();
    expect(await status).toEqual({ loggedIn: false });

    // A "CLI not found" error is no verdict: it is not reused.
    fs.rmSync(bin);
    cli.forgetBinary();
    expect((await cli.statusAsync({ fresh: true })).error).toMatch(/not found/);
    fs.writeFileSync(bin, "#!/bin/sh\necho 'Logged in using ChatGPT'\n");
    fs.chmodSync(bin, 0o755);
    expect(await cli.statusAsync()).toEqual({
      loggedIn: true,
      method: "ChatGPT",
    });
  });
});
