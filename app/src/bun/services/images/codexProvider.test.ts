import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Exit } from "effect";
import type { CodexAuthStatus } from "../../../shared/ipc";
import type { ImageFailure } from "./ImageFailure";
import {
  type CodexTurn,
  codexImageProvider,
  enabledConfigMcpServers,
} from "./codexProvider";

// The Codex fallback, driven by a fake Codex turn and a temp CODEX_HOME.
// Like the real `codex exec`, the fake reports nothing about images in its
// result — its image tool just leaves files under generated_images/<thread>/.

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const THREAD = "01a0b050-6661-7081-914f-b101fa014bb4";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "monad-codex-home-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const signedIn = (): CodexAuthStatus => ({ loggedIn: true, method: "ChatGPT" });

/** A Codex turn whose image tool writes `files` for THREAD. */
function turnThatDraws(...files: string[]) {
  const prompts: string[] = [];
  const turn: CodexTurn = async (prompt) => {
    prompts.push(prompt);
    const dir = path.join(home, "generated_images", THREAD);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f), PNG);
    return { threadId: THREAD, reply: "Done." };
  };
  return { turn, prompts };
}

const provider = (turn: CodexTurn, status: () => CodexAuthStatus = signedIn) =>
  codexImageProvider({
    home,
    cli: { status, resolveBinary: () => "/usr/local/bin/codex" },
    runTurn: turn,
  });

function failureOf<A>(exit: Exit.Exit<A, ImageFailure>): ImageFailure {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const err = exit.cause.reasons.find((r) => r._tag === "Fail");
  if (err?._tag !== "Fail") throw new Error("expected a typed failure");
  return err.error;
}

describe("Codex image provider", () => {
  test("returns the image Codex's image tool produced", async () => {
    const { turn, prompts } = turnThatDraws("ig_abc.png");

    const images = await Effect.runPromise(
      provider(turn).generate({ prompt: "a red fox", aspect: "portrait" }),
    );

    expect(images).toEqual([
      {
        path: path.join(home, "generated_images", THREAD, "ig_abc.png"),
        name: "ig_abc.png",
      },
    ]);
    expect(prompts[0]).toContain("a red fox");
    expect(prompts[0]).toContain("portrait");
  });

  /** A Codex turn that fails with `message` (a turn.failed / error event). */
  const failingTurn =
    (message: string): CodexTurn =>
    async () => ({ threadId: THREAD, failure: message });

  test("the ChatGPT plan's usage limit is a rate limit with its reset time", async () => {
    const failure = failureOf(
      await Effect.runPromiseExit(
        provider(
          failingTurn(
            "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:02 PM.",
          ),
        ).generate({ prompt: "x" }),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "ImageRateLimited",
      provider: "codex",
      retryAt: "at 2:02 PM",
    });
  });

  test.each([
    "Your access token could not be refreshed. Please log out and sign in again.",
    "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
    'unexpected status 401 Unauthorized: {"error":{"message":"Provided authentication token is expired. Please try signing in again.","code":"token_expired"}}',
  ])(
    "an expired sign-in session needs a fresh Codex login: %s",
    async (message) => {
      const failure = failureOf(
        await Effect.runPromiseExit(
          provider(failingTurn(message)).generate({ prompt: "x" }),
        ),
      );
      expect(failure).toMatchObject({
        _tag: "ImageAuthFailed",
        provider: "codex",
        reason: "expired",
      });
    },
  );

  test("without the Codex CLI installed, it says so and never starts a turn", async () => {
    const { turn, prompts } = turnThatDraws("ig_abc.png");
    const missing = codexImageProvider({
      home,
      cli: {
        status: () => ({ loggedIn: false, error: "Codex CLI not found." }),
        resolveBinary: () => {
          throw new Error(
            "Codex CLI not found. Install it (npm i -g @openai/codex) and sign in with `codex login`, or use an OpenAI API key instead.",
          );
        },
      },
      runTurn: turn,
    });
    const failure = failureOf(
      await Effect.runPromiseExit(missing.generate({ prompt: "x" })),
    );
    expect(failure._tag).toBe("ImageProviderUnavailable");
    expect(prompts).toHaveLength(0);
  });

  test("signed out of Codex, it asks for a sign-in and never starts a turn", async () => {
    const { turn, prompts } = turnThatDraws("ig_abc.png");
    const failure = failureOf(
      await Effect.runPromiseExit(
        provider(turn, () => ({ loggedIn: false })).generate({ prompt: "x" }),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "ImageAuthFailed",
      reason: "signed-out",
    });
    expect(prompts).toHaveLength(0);
  });

  test("a finished turn with no image reports Codex's own explanation", async () => {
    const turn: CodexTurn = async () => ({
      threadId: THREAD,
      reply: "I can't create that image because it depicts a real person.",
    });
    const failure = failureOf(
      await Effect.runPromiseExit(provider(turn).generate({ prompt: "x" })),
    );
    expect(failure).toMatchObject({
      _tag: "ImageNotProduced",
      detail: "I can't create that image because it depicts a real person.",
    });
  });

  test("a Codex exec that exits with an error is classified like a failed turn", async () => {
    const turn: CodexTurn = async () => {
      throw new Error(
        "Codex Exec exited with code 1: ERROR: Your access token could not be refreshed. Please log out and sign in again.",
      );
    };
    const failure = failureOf(
      await Effect.runPromiseExit(provider(turn).generate({ prompt: "x" })),
    );
    expect(failure).toMatchObject({
      _tag: "ImageAuthFailed",
      reason: "expired",
    });
  });
});

describe("Codex image provider — concurrency", () => {
  test("an async sign-in check is awaited, and parallel requests all finish", async () => {
    const { turn } = turnThatDraws("ig_par.png");
    let checks = 0;
    const p = provider(turn, (async () => {
      checks++;
      await Bun.sleep(5);
      return signedIn();
    }) as unknown as () => CodexAuthStatus);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        Effect.runPromise(p.generate({ prompt: "a red fox" })),
      ),
    );
    expect(checks).toBe(3);
    for (const images of results) expect(images.length).toBeGreaterThan(0);
  });
});

describe("MCP servers switched off for image turns", () => {
  test("lists config.toml servers that are on, skipping disabled and odd names", () => {
    const toml = `
model = "gpt-5"
[mcp_servers.context7]
command = "npx"
[mcp_servers.aws-mcp]
command = "uvx"
[mcp_servers.off]
command = "x"
enabled = false
[mcp_servers."has.dot"]
command = "y"
[mcp_servers.node_repl.env]
FOO = "1"
`;
    expect(enabledConfigMcpServers(toml)).toEqual([
      "context7",
      "aws-mcp",
      "node_repl",
    ]);
  });

  test("no servers, or a config that doesn't parse, overrides nothing", () => {
    expect(enabledConfigMcpServers('model = "x"')).toEqual([]);
    expect(enabledConfigMcpServers("[[[ not toml")).toEqual([]);
  });
});
