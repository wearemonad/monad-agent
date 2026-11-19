import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { Codex } from "@openai/codex-sdk";
import type { CodexAuthStatus, OpenAIProviderId } from "../../shared/ipc";
import {
  afterShellPath,
  checkCliLookup,
  findOnPath,
  shellPathPending,
} from "../services/shellPath";

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

  constructor(
    private getOverridePath?: () => string | undefined,
    /** The login-shell PATH probe while it runs (injectable for tests). */
    private pathPending: () => Promise<void> | null = shellPathPending,
  ) {}

  /** resolveBinary for readiness checks — see checkCliLookup. */
  validateBinary(): void {
    checkCliLookup(() => this.resolveBinary(), {
      overridden: !!this.getOverridePath?.(),
      pending: this.pathPending(),
    });
  }

  /** resolveBinary, after the login-shell PATH is in. */
  resolveBinaryAsync(): Promise<string> {
    return afterShellPath(() => this.resolveBinary(), this.pathPending);
  }

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
      path.join(process.env.HOME || os.homedir(), ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.binaryPath = c;
        return c;
      }
    }
    // GUI apps don't inherit the shell PATH on macOS; fixProcessPath merges
    // the login shell's PATH in (async, at boot) — which also carries
    // version-manager shims (asdf, mise, nvm-installed npm globals).
    const found = findOnPath("codex");
    if (found) {
      this.binaryPath = found;
      return found;
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

  private statusAt = 0;
  private cachedStatus: CodexAuthStatus | null = null;
  private pendingStatus: Promise<CodexAuthStatus> | null = null;

  /** Every verdict is reused for STATUS_TTL_MS — signed out too, so a
   *  signed-out user's image requests and health checks don't spawn the CLI
   *  each time. Settings' re-check, an explicit test and a finished in-app
   *  sign-in ask afresh ({ fresh: true }); an expired login surfaces as a
   *  failed turn anyway (classifyCodexFailure → ImageAuthFailed). */
  private remember(status: CodexAuthStatus): void {
    // An error is no verdict (CLI missing, timeout): ask again next time.
    if (status.error) {
      this.cachedStatus = null;
      return;
    }
    this.cachedStatus = status;
    this.statusAt = Date.now();
  }

  /** Drop the cached answer: the next statusAsync asks the CLI. */
  forgetStatus(): void {
    this.cachedStatus = null;
  }

  /** `codex login status` without blocking the event loop: spawned async,
   *  the answer cached (see remember), and concurrent callers (several
   *  threads asking for images at once) share one spawn. */
  statusAsync({ fresh = false } = {}): Promise<CodexAuthStatus> {
    if (fresh) this.forgetStatus();
    if (
      this.cachedStatus &&
      Date.now() - this.statusAt < CodexCli.STATUS_TTL_MS
    ) {
      return Promise.resolve(this.cachedStatus);
    }
    // A fresh check never joins a spawn that started before it.
    if (this.pendingStatus && !fresh) return this.pendingStatus;
    const pending: Promise<CodexAuthStatus> = this.spawnStatus().then(
      (status) => {
        // Only the latest spawn records its answer: one that started before
        // a fresh check must not overwrite it.
        if (this.pendingStatus === pending) {
          this.pendingStatus = null;
          this.remember(status);
        }
        return status;
      },
    );
    this.pendingStatus = pending;
    return pending;
  }

  static readonly STATUS_TTL_MS = 5 * 60_000;

  private async spawnStatus(): Promise<CodexAuthStatus> {
    let bin: string;
    try {
      bin = await this.resolveBinaryAsync();
    } catch (e) {
      return { loggedIn: false, error: String((e as Error).message) };
    }
    try {
      const proc = Bun.spawn([bin, "login", "status"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const status = parseLoginStatus(
        proc.signalCode ? null : code,
        `${out}${err}`,
      );
      return status;
    } catch (e) {
      return { loggedIn: false, error: String((e as Error)?.message ?? e) };
    }
  }
}

/** Read `codex login status`'s verdict. `code` is null when the process
 *  never exited normally (spawn failure, timeout kill). */
export function parseLoginStatus(
  code: number | null,
  output: string,
  spawnError?: string,
): CodexAuthStatus {
  const text = output.trim();
  if (code === 0) {
    const method = /chatgpt/i.test(text)
      ? "ChatGPT"
      : /api key/i.test(text)
        ? "API key"
        : undefined;
    return { loggedIn: true, ...(method ? { method } : {}) };
  }
  // Non-zero exit with "Not logged in" is the signed-out case; anything
  // else (spawn failure, timeout, broken config) is reported as an error.
  if (typeof code === "number" && /not logged in/i.test(text)) {
    return { loggedIn: false };
  }
  return {
    loggedIn: false,
    error: text || spawnError || "codex login status failed",
  };
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
    this.cli.validateBinary();
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
    if (!hasBundledCodex()) this.cli.validateBinary();
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
