import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectDir } from "./sessionFiles";

/** Test helpers: a throwaway CLAUDE_CONFIG_DIR + workspace folder, and
 *  session JSONLs shaped like the CLI writes them (compact JSON, one entry
 *  per line) so the real SDK listSessions reads them. */

export function withTempClaudeHome(): {
  workspace: string;
  restore: () => void;
} {
  const prior = process.env.CLAUDE_CONFIG_DIR;
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "monad-sessions-")),
  );
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  // realpath'd: /var → /private/var on macOS, as the CLI records it
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    restore: () => {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prior;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Line = Record<string, unknown>;

export function userLine(
  sessionId: string,
  cwd: string,
  text: string,
  entrypoint = "sdk-ts",
): Line {
  return {
    // Key order as the CLI writes it: content BEFORE "type" — which is why a
    // huge first message pushes "type":"user" past the SDK's 64 KB head.
    parentUuid: null,
    isSidechain: false,
    message: { role: "user", content: text },
    type: "user",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
    sessionId,
    entrypoint,
    version: "2.1.285",
  };
}

export function assistantLine(
  sessionId: string,
  cwd: string,
  text: string,
): Line {
  return {
    parentUuid: null,
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "text", text }] },
    type: "assistant",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
    sessionId,
  };
}

/** The CLI re-appends its generated title after every turn — the SDK needs
 *  some title (custom, ai, last prompt, or first prompt) to list a session. */
export const aiTitleLine = (sessionId: string, aiTitle: string): Line => ({
  type: "ai-title",
  aiTitle,
  sessionId,
});

export const tagLine = (sessionId: string, tag: string): Line => ({
  type: "tag",
  tag,
  sessionId,
});

/** ~bytes of assistant transcript, split over lines like real tool output. */
export function filler(sessionId: string, cwd: string, bytes: number): Line[] {
  const lines: Line[] = [];
  for (let n = 0; n < bytes; n += 8_000) {
    lines.push(assistantLine(sessionId, cwd, "x".repeat(8_000)));
  }
  return lines;
}

/** Write a session JSONL where the SDK will look for `cwd`'s sessions. */
export function writeSession(
  cwd: string,
  sessionId: string,
  lines: Line[],
  mtime?: Date,
): string {
  const dir = claudeProjectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}
