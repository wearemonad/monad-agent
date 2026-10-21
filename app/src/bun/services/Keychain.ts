import { execFileSync } from "node:child_process";

const ACCOUNT = "monad";

/** Quote one argument of a `security -i` command line. Interactive mode splits
 *  the line itself, so backslash and double-quote are the two characters that
 *  would otherwise change where an argument ends. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A newline ends a `security -i` command, so a field carrying one could append
 *  a second command that quoting cannot contain. No caller can supply one today
 *  — service names are constants or `<prefix>-<uuid>`, and the one caller
 *  storing user input (WorkspaceEnvStore) hands over JSON, which escapes every
 *  control character — so this is the guard that keeps that true rather than a
 *  live hole. Rejected loudly: silently stripping would corrupt a secret. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** macOS Keychain-backed secret storage via the `security` CLI.
 *  Secrets never travel to the webview; args are passed as an array (no shell). */
export const Keychain = {
  set(service: string, secret: string): void {
    // The secret must never reach argv — `ps -ww` exposes argv to any same-user
    // process — which rules out a plain `-w <secret>`.
    //
    // It also cannot go through `-w` with no value: that makes `security`
    // prompt, and the prompt is readpassphrase(3), which opens /dev/tty when
    // the process HAS a controlling terminal and ignores piped stdin entirely.
    // Running from a terminal (any `bun start` dev session) therefore blocked
    // here forever on a prompt painted over the dev log — and because this call
    // is synchronous, it froze the whole backend: the Google connect that
    // triggered it never finished and the UI sat on "Waiting for browser
    // sign-in…" with no error, since no further event could ever be emitted.
    //
    // Interactive mode takes the COMMAND ITSELF on stdin, so the secret is
    // neither in argv nor routed through the tty. Failures still surface: a
    // rejected command exits non-zero and execFileSync throws.
    if (hasControlChars(service))
      throw new Error("Service names may not contain control characters.");
    if (hasControlChars(secret))
      throw new Error("Secrets may not contain control characters.");
    execFileSync("security", ["-i"], {
      input: `add-generic-password -U -a ${quote(ACCOUNT)} -s ${quote(service)} -w ${quote(secret)}\n`,
      stdio: ["pipe", "ignore", "ignore"],
      // Nothing here should ever block, but a sync call on the backend's only
      // thread is the wrong place to find out otherwise.
      timeout: 10_000,
    });
  },

  get(service: string): string | null {
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-a", ACCOUNT, "-s", service, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch (e) {
      // Exit 44 = item genuinely not in the keychain (the common "not set"
      // case). Any other status means the item may exist but the read failed
      // (keychain locked, access denied) — log it so we don't mistakenly tell
      // the user to configure a credential they already set.
      const status = (e as { status?: number }).status;
      if (status !== 44) {
        console.warn(
          `[keychain] read failed for "${service}" (exit ${status ?? "?"})`,
        );
      }
      return null;
    }
  },

  delete(service: string): void {
    try {
      execFileSync(
        "security",
        ["delete-generic-password", "-a", ACCOUNT, "-s", service],
        {
          stdio: "ignore",
        },
      );
    } catch {
      // absent is fine
    }
  },
};

export const KeychainServices = {
  anthropicApiKey: "monad-anthropic-api-key",
  openaiApiKey: "monad-openai-api-key",
  googleClientSecret: "monad-google-client-secret",
  driveRefreshToken: (workspaceId: string) => `monad-drive-${workspaceId}`,
};
