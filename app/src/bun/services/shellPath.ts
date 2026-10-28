import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
export function fixProcessPath(): void {
  process.env.PATH = mergePaths(
    readLoginShellPath(),
    process.env.PATH ?? "",
    fallbackDirs().filter((p) => fs.existsSync(p)),
  );
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
function readLoginShellPath(): string[] {
  if (process.platform === "win32") return [];
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const res = Bun.spawnSync(
      [shell, "-ilc", 'printf "__PATH_S__%s__PATH_E__" "$PATH"'],
      {
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        timeout: 4000,
      },
    );
    const out = res.stdout?.toString() ?? "";
    const match = out.match(/__PATH_S__(.*?)__PATH_E__/s);
    return match ? match[1].split(":").filter(Boolean) : [];
  } catch {
    return [];
  }
}
