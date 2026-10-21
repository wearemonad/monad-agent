import * as fs from "node:fs";
import * as path from "node:path";

/** Crash-safe JSON persistence for the app's small config stores.
 *
 *  The failure this prevents (C7): a bare `writeFileSync` opens the real file
 *  with O_TRUNC, so a kill — or a cloud-sync/AV lock — mid-write leaves a
 *  truncated file. If the paired `load()` then treats "unparseable" the same as
 *  "absent" and returns an empty default, the next `save()` overwrites the only
 *  copy with that empty default: the registry (workspaces, allowlists, Drive
 *  links, schedules, budgets) is gone permanently and the app looks freshly
 *  installed.
 *
 *  Two guarantees:
 *   - writeAtomic writes to a sibling temp file and renames onto the target.
 *     rename(2) within a directory is atomic, so a reader sees either the old
 *     bytes or the new ones, never a half-written file.
 *   - readJsonAtomic distinguishes ENOENT (no file yet → default) from a parse
 *     error (corruption). On corruption it QUARANTINES the file to
 *     `<name>.corrupt-<ts>` and throws, so the caller does not silently
 *     auto-save an empty default over recoverable data. */

export function writeAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup; surface the original rename failure
    }
    throw e;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2));
}

/** Read + parse JSON with corruption-safe fallback.
 *
 *  - File absent (ENOENT) → `whenMissing()`. Normal first run.
 *  - File present but unparseable → QUARANTINE it to `<name>.corrupt-<ts>` and
 *    return `whenMissing()`. The bad bytes are preserved for recovery, and
 *    because the original has been renamed away, a subsequent `save()` writes a
 *    fresh file rather than overwriting recoverable data. `onCorrupt` fires so
 *    the caller can log/surface it.
 *  - Any other read error (EACCES, a cloud-sync/AV lock, EIO) → RETHROW. The
 *    file is intact but momentarily unreadable; returning a default here would
 *    let the caller save an empty document over good data once the lock clears.
 *    Failing loudly is correct — the data is not lost.
 *
 *  `now` is injectable because `Date.now()` is unavailable in some execution
 *  contexts (and to keep the quarantine name deterministic in tests). */
export function readJsonAtomic<T>(
  file: string,
  whenMissing: () => T,
  opts: { now?: number; onCorrupt?: (message: string) => void } = {},
): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return whenMissing();
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const now = opts.now ?? Date.now();
    const quarantine = `${file}.corrupt-${now}`;
    let moved = false;
    try {
      fs.renameSync(file, quarantine);
      moved = true;
    } catch {
      // couldn't move it aside; still return the default (do not overwrite —
      // callers use writeAtomic, and the corruption is already logged)
    }
    opts.onCorrupt?.(
      `${path.basename(file)} was corrupt${
        moved ? ` and moved to ${path.basename(quarantine)}` : ""
      }: ${(e as Error).message}`,
    );
    return whenMissing();
  }
}
