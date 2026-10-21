import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { format } from "node:util";

/** The app's own log, where macOS expects it (Console.app lists it too). */
export const LOG_DIR = path.join(os.homedir(), "Library/Logs/Monad");
export const LOG_FILE = path.join(LOG_DIR, "monad.log");

/** Rotate past this size, keeping monad.log + .1 + .2 (≤ ~15 MB total). */
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

/** Secret-shaped strings that must never land in a file colleagues send
 *  around: Anthropic/OpenAI keys, bearer tokens, Google access tokens. */
const SECRETS =
  /\b(sk-ant-[\w-]{8,}|sk-[\w-]{20,}|ya29\.[\w.-]{10,})|(Bearer\s+)[\w.~+/=-]{10,}/g;

export function redactSecrets(s: string): string {
  return s.replace(SECRETS, (_m, key, bearer) =>
    bearer ? `${bearer}[redacted]` : `${key.slice(0, 6)}…[redacted]`,
  );
}

/** Mirror console output into LOG_FILE. A Finder-launched app's stdout goes
 *  nowhere, so without this every `[scheduler] …` / `[webview] …` line is
 *  lost the moment it's printed. Logging must never break the app: every
 *  file error is swallowed and the original console call still runs. */
export function installAppLog(
  file: string = LOG_FILE,
  maxBytes: number = MAX_BYTES,
): () => void {
  let size = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    return () => {}; // no writable log dir — console stays as it was
  }
  const write = (level: string, args: unknown[]) => {
    try {
      const line = `${new Date().toISOString()} [${level}] ${redactSecrets(format(...args))}\n`;
      const bytes = Buffer.byteLength(line);
      if (size + bytes > maxBytes) {
        rotate(file);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += bytes;
    } catch {
      // a full disk must not take the app down with it
    }
  };
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  const originals = levels.map((level) => console[level]);
  for (const [i, level] of levels.entries()) {
    const original = originals[i].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level, args);
    };
  }
  // Uninstall — for tests, which must not leave console patched.
  return () => {
    for (const [i, level] of levels.entries()) console[level] = originals[i];
  };
}

function rotate(file: string): void {
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    try {
      fs.renameSync(from, `${file}.${i}`);
    } catch {
      // nothing at this slot yet
    }
  }
}
