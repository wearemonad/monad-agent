import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "./spawnAsync";

/** GUI-launched macOS apps inherit launchd's minimal PATH
 *  (/usr/bin:/bin:/usr/sbin:/sbin), so user-installed tools — npx from
 *  Homebrew/nvm, uvx, docker — "vanish" even though they work fine in the
 *  terminal. Resolve the user's login-shell PATH once at startup and merge it
 *  into process.env.PATH. Dev runs launched from a terminal already have a
 *  full PATH; merging keeps their entries intact.
 *
 *  Caveat: Bun snapshots the environment at launch. Bun.which, Bun.spawn and
 *  child_process do NOT see later process.env.PATH writes unless they are
 *  passed explicitly (`{ PATH: process.env.PATH }` / `env: process.env`) —
 *  agent runs do this via their merged env. */

let resolving: Promise<void> | null = null;
let settled = false;

/** Starts the login-shell probe (async — it can take seconds with a heavy
 *  .zshrc) and returns the memoised promise. The well-known fallback dirs are
 *  merged in synchronously first, so the common installs resolve even before
 *  the shell answers. Callers that spawn user tools await shellPathReady(). */
export function fixProcessPath(): Promise<void> {
  if (resolving) return resolving;
  process.env.PATH = mergePaths(
    [],
    process.env.PATH ?? "",
    fallbackDirs().filter((p) => fs.existsSync(p)),
  );
  resolving = readLoginShellPath().then((shellPaths) => {
    process.env.PATH = mergePaths(shellPaths, process.env.PATH ?? "", []);
    settled = true;
  });
  return resolving;
}

/** The login-shell probe while it is still running, else null — so callers
 *  pay no extra tick once PATH is settled: `const p = shellPathPending();
 *  if (p) await p;`. */
export function shellPathPending(): Promise<void> | null {
  return settled ? null : resolving;
}

/** The first executable called `name` on `pathVar` — `which`, without a shell
 *  (and without blocking on one). */
export function findOnPath(
  name: string,
  pathVar: string = process.env.PATH ?? "",
): string | null {
  for (const dir of pathVar.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Shell entries first (they're the user's intended order), then whatever the
 *  process already had, then existing well-known dirs as a safety net for
 *  setups where the shell probe fails. Exported for tests. */
export function mergePaths(
  shellPaths: string[],
  currentPath: string,
  fallbacks: string[],
): string {
  const merged = new Set<string>();
  for (const p of shellPaths) if (p) merged.add(p);
  for (const p of currentPath.split(":")) if (p) merged.add(p);
  for (const p of fallbacks) if (p) merged.add(p);
  return [...merged].join(":");
}

function fallbackDirs(): string[] {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
  ];
}

/** Ask the user's shell what PATH a real terminal session gets. -l sources
 *  the login profile (Homebrew's shellenv), -i sources the interactive rc
 *  (nvm and friends). Output is wrapped in sentinels so prompt noise or
 *  plugin chatter from the rc files can't corrupt the result. */
async function readLoginShellPath(): Promise<string[]> {
  if (process.platform === "win32") return [];
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const res = await run(
      [shell, "-ilc", 'printf "__PATH_S__%s__PATH_E__" "$PATH"'],
      {
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
        timeout: 4000,
      },
    );
    const match = res.stdout.match(/__PATH_S__(.*?)__PATH_E__/s);
    return match ? match[1].split(":").filter(Boolean) : [];
  } catch {
    return [];
  }
}
