import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { Codex } from "@openai/codex-sdk";
import type { CodexAuthStatus, OpenAIProviderId } from "../../shared/ipc";

/** How an OpenAI provider drives the Codex harness: which binary, which
 *  credentials. The OpenAI counterpart of AuthStrategy (which configures the
 *  Claude Agent SDK instead). */
export interface CodexAuthStrategy {
  id: OpenAIProviderId;
  /** Human-readable readiness check; throws with a friendly message when unusable. */
  validate(): void;
  /** Codex client options. `env` entries override the run's environment;
   *  an empty string means "delete this key" (as with AuthStrategy). */
  codexOptions(): {
    codexPathOverride?: string;
    apiKey?: string;
    env: Record<string, string>;
  };
}

/** Locates the user's installed Codex CLI — same search order and
 *  memoization as the Claude CLI lookup (SubscriptionCliAuth). */
export class CodexCli {
  private binaryPath: string | null = null;

  constructor(private getOverridePath?: () => string | undefined) {}

  /** Drop the memoized path so the next resolve looks at the disk again. */
  forgetBinary(): void {
    this.binaryPath = null;
  }

  resolveBinary(): string {
    const override = this.getOverridePath?.();
    if (override) {
      if (!fs.existsSync(override)) {
        throw new Error(
          `Configured Codex CLI path does not exist: ${override}`,
        );
      }
      return override;
    }
    if (this.binaryPath) return this.binaryPath;
    const candidates = [
      process.env.MONAD_CODEX_BIN,
      path.join(os.homedir(), ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.binaryPath = c;
        return c;
      }
    }
    // GUI apps don't inherit shell PATH on macOS; ask a login shell. This
    // also finds version-manager shims (asdf, mise, nvm-installed npm globals).
    try {
      // An interactive shell runs the user's .zshrc, which may print its own
      // output (prompt themes, greetings) — the path is the last absolute line.
      const found =
        execSync('zsh -ilc "which codex"', {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("/"))
          .pop() ?? "";
      if (found && fs.existsSync(found)) {
        this.binaryPath = found;
        return found;
      }
    } catch {
      // fall through to the error below
    }
    throw new Error(
      "Codex CLI not found. Install it (npm i -g @openai/codex) and sign in with `codex login`, or use an OpenAI API key instead.",
    );
  }

  tryResolve(): string {
    try {
      return this.resolveBinary();
    } catch {
      return "";
    }
  }

  /** `codex login status` — exits 0 and names the method when signed in. */
  status(): CodexAuthStatus {
    let bin: string;
    try {
      bin = this.resolveBinary();
    } catch (e) {
      return { loggedIn: false, error: String((e as Error).message) };
    }
    // The CLI prints its verdict on stderr, so read both streams.
    const res = spawnSync(bin, ["login", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    const text = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    if (res.status === 0) {
      const method = /chatgpt/i.test(text)
        ? "ChatGPT"
        : /api key/i.test(text)
          ? "API key"
          : undefined;
      return { loggedIn: true, ...(method ? { method } : {}) };
    }
    // Non-zero exit with "Not logged in" is the signed-out case; anything
    // else (spawn failure, timeout, broken config) is reported as an error.
    if (typeof res.status === "number" && /not logged in/i.test(text)) {
      return { loggedIn: false };
    }
    return {
      loggedIn: false,
      error: text || String(res.error?.message ?? "codex login status failed"),
    };
  }
}

/** Keys that would make the Codex CLI bill an API key instead of the
 *  ChatGPT login. Cleared for subscription runs so a developer-shell export
 *  or a stray .env can't silently switch billing while the UI says
 *  "subscription". */
const API_KEY_ENV = { OPENAI_API_KEY: "", CODEX_API_KEY: "" };

/** OpenAI mode A: ride the user's installed, ChatGPT-signed-in Codex CLI. */
export class OpenAISubscriptionAuth implements CodexAuthStrategy {
  id = "openai-subscription" as const;

  constructor(private cli: CodexCli) {}

  validate(): void {
    this.cli.resolveBinary();
  }

  codexOptions() {
    return { codexPathOverride: this.cli.resolveBinary(), env: API_KEY_ENV };
  }
}

/** Whether the SDK's bundled Codex binary is resolvable (it is in dev, where
 *  node_modules is present; packaged builds don't ship the ~300 MB binary).
 *  Memoized — the answer can't change while the app runs. */
let bundledCodex: boolean | null = null;
function hasBundledCodex(): boolean {
  if (bundledCodex === null) {
    try {
      new Codex(); // resolves the platform binary; throws when it's missing
      bundledCodex = true;
    } catch {
      bundledCodex = false;
    }
  }
  return bundledCodex;
}

/** OpenAI mode B: the Codex runtime billed to an OpenAI API key (Keychain).
 *  Prefers the SDK's bundled binary; falls back to the installed CLI. The
 *  key goes in as CODEX_API_KEY, which `codex exec` uses ahead of any stored
 *  ChatGPT login. */
export class OpenAIApiKeyAuth implements CodexAuthStrategy {
  id = "openai-api-key" as const;

  constructor(
    private getKey: () => string | null,
    private cli: CodexCli,
  ) {}

  validate(): void {
    if (!this.getKey()) {
      throw new Error("No OpenAI API key configured. Add one in Settings.");
    }
    if (!hasBundledCodex()) this.cli.resolveBinary();
  }

  codexOptions() {
    return {
      ...(hasBundledCodex()
        ? {}
        : { codexPathOverride: this.cli.resolveBinary() }),
      apiKey: this.getKey() ?? "",
      env: { OPENAI_API_KEY: "" },
    };
  }
}
