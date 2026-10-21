import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import type { AuthMode } from "../../shared/ipc";

export interface AuthStrategy {
  id: AuthMode;
  /** Auth-specific SDK options: binary path and/or env overrides.
   *  AgentService merges env as process.env < workspace .env < these. */
  sdkOptions(): {
    pathToClaudeCodeExecutable?: string;
    env?: Record<string, string>;
  };
  /** Human-readable readiness check; throws with a friendly message when unusable. */
  validate(): void;
  /** Optional async pre-run hook, awaited by AgentService before the query
   *  starts (e.g. local mode boots the Ollama server first). */
  prepare?(): Promise<void>;
}

/** Mode A: ride the user's installed, subscription-authenticated Claude Code CLI.
 *  Policy-fragile (see plan) — the app must keep working when this is removed. */
export class SubscriptionCliAuth implements AuthStrategy {
  id = "subscription-cli" as const;
  private binaryPath: string | null = null;

  constructor(private getOverridePath?: () => string | undefined) {}

  /** Drop the memoized path so the next resolve looks at the disk again —
   *  a re-check must be able to see a CLI that moved, vanished, or appeared. */
  forgetBinary(): void {
    this.binaryPath = null;
  }

  resolveBinary(): string {
    const override = this.getOverridePath?.();
    if (override) {
      if (!fs.existsSync(override)) {
        throw new Error(
          `Configured Claude CLI path does not exist: ${override}`,
        );
      }
      return override;
    }
    if (this.binaryPath) return this.binaryPath;
    const candidates = [
      process.env.MONAD_CLAUDE_BIN,
      path.join(os.homedir(), ".local/bin/claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      path.join(os.homedir(), ".claude/local/claude"),
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.binaryPath = c;
        return c;
      }
    }
    // GUI apps don't inherit shell PATH on macOS; ask a login shell.
    try {
      const found = execSync('zsh -ilc "which claude"', {
        encoding: "utf8",
      }).trim();
      if (found && fs.existsSync(found)) {
        this.binaryPath = found;
        return found;
      }
    } catch {
      // fall through to validate() error
    }
    throw new Error(
      "Claude Code CLI not found. Install it and log in (https://claude.com/claude-code), or switch Monad to API-key mode.",
    );
  }

  validate(): void {
    this.resolveBinary();
  }

  sdkOptions() {
    return {
      pathToClaudeCodeExecutable: this.resolveBinary(),
      // Clear any inherited API-key env (a developer shell export, a stray
      // .env) — otherwise the CLI silently bills API rates while the UI says
      // "subscription". Empty string = "delete this key" (AgentService drops
      // empty-valued entries before spawning).
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: "",
      },
    };
  }
}

/** Mode B: SDK's bundled runtime + ANTHROPIC_API_KEY. Fully sanctioned. */
export class ApiKeyAuth implements AuthStrategy {
  id = "api-key" as const;
  constructor(private getKey: () => string | null) {}

  validate(): void {
    if (!this.getKey()) {
      throw new Error("No Anthropic API key configured. Add one in Settings.");
    }
  }

  sdkOptions() {
    return { env: { ANTHROPIC_API_KEY: this.getKey() ?? "" } };
  }
}

/** What LocalOllamaAuth needs from OllamaService (narrowed for testability). */
export type OllamaRuntime = {
  isInstalled(): boolean;
  ensureRunning(): Promise<void>;
};

/** Mode C: SDK's bundled runtime pointed at the local Ollama server, which
 *  speaks Anthropic's Messages API natively (v0.14+). Experimental — local
 *  models are weaker at tool-heavy runs than Claude; the UI says so. */
export class LocalOllamaAuth implements AuthStrategy {
  id = "local-ollama" as const;

  constructor(
    private getModel: () => string | undefined,
    private ollama: OllamaRuntime,
    private baseUrl: string,
  ) {}

  validate(): void {
    if (!this.ollama.isInstalled()) {
      throw new Error(
        "Ollama isn't installed. Set it up in Settings → Providers → Ollama.",
      );
    }
    if (!this.getModel()) {
      throw new Error(
        "No local model chosen. Download or pick one in Settings → Providers → Ollama.",
      );
    }
  }

  async prepare(): Promise<void> {
    await this.ollama.ensureRunning();
  }

  sdkOptions() {
    const model = this.getModel() ?? "";
    return {
      env: {
        ANTHROPIC_BASE_URL: this.baseUrl,
        // Ollama ignores credentials but the SDK insists on having some.
        ANTHROPIC_API_KEY: "ollama",
        ANTHROPIC_AUTH_TOKEN: "ollama",
        // Cover every model slot: the default AND the small/fast model the
        // runtime uses for side tasks — a stray "claude-haiku-…" id would
        // 404 against the local library.
        ANTHROPIC_MODEL: model,
        ANTHROPIC_SMALL_FAST_MODEL: model,
      },
    };
  }
}
