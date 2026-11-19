import { run, runChecked } from "./spawnAsync";

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

/** Values already read (null = known absent). Reads happen asynchronously —
 *  `security` is a child process, and waiting on one synchronously stalls
 *  bun's only thread and with it every streaming Thread — so the sync get()
 *  answers from here alone. index.ts awaits prefetch() of every known item at
 *  boot, before anything can ask. Monad is the only writer of these items and
 *  keeps the cache in step through set/delete; a failed read (locked
 *  keychain, denied access) is never cached, so the next load() retries. */
const cache = new Map<string, string | null>();
/** Reads in flight, so concurrent loads of one item share a spawn. */
const pending = new Map<string, Promise<string | null>>();

async function readItem(service: string): Promise<string | null> {
  const res = await run(
    ["security", "find-generic-password", "-a", ACCOUNT, "-s", service, "-w"],
    { timeout: 10_000 },
  );
  if (res.code === 0) {
    const value = res.stdout.trim();
    cache.set(service, value);
    return value;
  }
  // Exit 44 = item genuinely not in the keychain (the common "not set" case).
  // Any other status means the item may exist but the read failed (keychain
  // locked, access denied) — log it so we don't mistakenly tell the user to
  // configure a credential they already set.
  if (res.code === 44) cache.set(service, null);
  else
    console.warn(
      `[keychain] read failed for "${service}" (exit ${res.code ?? "killed"})`,
    );
  return null;
}

/** macOS Keychain-backed secret storage via the `security` CLI.
 *  Secrets never travel to the webview; args are passed as an array (no shell). */
export const Keychain = {
  async set(service: string, secret: string): Promise<void> {
    // The secret must never reach argv — `ps -ww` exposes argv to any same-user
    // process — which rules out a plain `-w <secret>`.
    //
    // It also cannot go through `-w` with no value: that makes `security`
    // prompt, and the prompt is readpassphrase(3), which opens /dev/tty when
    // the process HAS a controlling terminal and ignores piped stdin entirely.
    // Running from a terminal (any `bun start` dev session) therefore blocked
    // there forever on a prompt painted over the dev log.
    //
    // Interactive mode takes the COMMAND ITSELF on stdin, so the secret is
    // neither in argv nor routed through the tty. Failures still surface: a
    // rejected command exits non-zero and runChecked throws.
    if (hasControlChars(service))
      throw new Error("Service names may not contain control characters.");
    if (hasControlChars(secret))
      throw new Error("Secrets may not contain control characters.");
    await runChecked(["security", "-i"], {
      input: `add-generic-password -U -a ${quote(ACCOUNT)} -s ${quote(service)} -w ${quote(secret)}\n`,
      timeout: 10_000,
    });
    cache.set(service, secret);
  },

  /** The cached value: never spawns. null when absent or not loaded yet — a
   *  cold miss starts a background load, so a later call sees the value. */
  get(service: string): string | null {
    const known = cache.get(service);
    if (known !== undefined) return known;
    void Keychain.load(service);
    return null;
  },

  /** Read through the cache, spawning `security` (async) on a miss. */
  load(service: string): Promise<string | null> {
    const known = cache.get(service);
    if (known !== undefined) return Promise.resolve(known);
    let p = pending.get(service);
    if (!p) {
      p = readItem(service)
        .catch((e) => {
          console.warn(
            `[keychain] read failed for "${service}": ${(e as Error).message}`,
          );
          return null;
        })
        .finally(() => pending.delete(service));
      pending.set(service, p);
    }
    return p;
  },

  /** Warm the cache for every item the app knows about, in parallel. */
  async prefetch(services: string[]): Promise<void> {
    await Promise.all(services.map((s) => Keychain.load(s)));
  },

  async delete(service: string): Promise<void> {
    cache.set(service, null);
    // Absent is fine: a non-zero exit is ignored.
    await run(
      ["security", "delete-generic-password", "-a", ACCOUNT, "-s", service],
      {
        timeout: 10_000,
      },
    ).catch(() => {});
  },
};

export const KeychainServices = {
  anthropicApiKey: "monad-anthropic-api-key",
  openaiApiKey: "monad-openai-api-key",
  googleClientSecret: "monad-google-client-secret",
  driveRefreshToken: (workspaceId: string) => `monad-drive-${workspaceId}`,
  /** Settings → Image models, one key per provider. */
  imageApiKey: (provider: string) => `monad-image-${provider}-api-key`,
  /** Per-workspace credentials entered in Settings (WorkspaceEnvStore). */
  workspaceEnv: (workspaceId: string) => `monad-wsenv-${workspaceId}`,
};
