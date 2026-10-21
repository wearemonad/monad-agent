import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where the Claude CLI keeps a workspace's session JSONLs, resolved exactly
 *  the way the SDK resolves it: the config dir honours CLAUDE_CONFIG_DIR, the
 *  cwd is realpath'd (symlinks) and NFC-normalised on macOS, and folder names
 *  longer than 200 chars are truncated with a hash suffix. Any drift from the
 *  SDK here means Monad silently reads the wrong folder (search, memory
 *  indexing, empty-session cleanup, tag recovery) for affected workspaces. */

const MAX_DIR_NAME = 200;

export function claudeConfigDir(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  ).normalize("NFC");
}

/** The cwd as the CLI records it: symlinks resolved, NFC on macOS. */
export function canonicalCwd(cwd: string): string {
  let resolved = cwd;
  try {
    resolved = fs.realpathSync(cwd);
  } catch {
    // missing folder — encode the path as given, like the SDK does
  }
  return process.platform === "darwin" ? resolved.normalize("NFC") : resolved;
}

/** Java-style 32-bit string hash — the SDK's suffix for long folder names. */
function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** How the CLI names a project's session folder under <config>/projects. */
export function encodeProjectDir(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= MAX_DIR_NAME) return encoded;
  return `${encoded.slice(0, MAX_DIR_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

export function claudeProjectDir(cwd: string): string {
  return path.join(
    claudeConfigDir(),
    "projects",
    encodeProjectDir(canonicalCwd(cwd)),
  );
}

export function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** A tag line is tiny; anything longer can't be one and is skipped unbuffered
 *  (tool results can put megabytes on a single line). */
const MAX_TAG_LINE = 4096;

/** The value of the LAST `{"type":"tag"}` entry anywhere in a session JSONL
 *  ("" = cleared), or null when the file has no tag entry / can't be read.
 *  Streams the file so multi-MB transcripts never sit in memory whole. The
 *  SDK only looks for the tag in the last 64 KB — this is the fallback for
 *  threads whose tag was pushed out of that window by a long run. */
export async function lastTagInFile(file: string): Promise<string | null> {
  let last: string | null = null;
  const consider = (line: string) => {
    if (!line.includes('"type":"tag"')) return;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "tag" && typeof entry.tag === "string")
        last = entry.tag;
    } catch {
      // partial / foreign line — not a tag entry
    }
  };
  try {
    const decoder = new TextDecoder();
    let carry = "";
    let skipping = false;
    for await (const chunk of Bun.file(file).stream()) {
      const text = decoder.decode(chunk, { stream: true });
      let start = 0;
      while (start <= text.length) {
        const nl = text.indexOf("\n", start);
        const piece = nl === -1 ? text.slice(start) : text.slice(start, nl);
        if (!skipping) {
          carry += piece;
          if (carry.length > MAX_TAG_LINE) {
            carry = "";
            skipping = true;
          }
        }
        if (nl === -1) break;
        if (!skipping) consider(carry);
        carry = "";
        skipping = false;
        start = nl + 1;
      }
    }
    if (!skipping) consider(carry + decoder.decode());
  } catch {
    return null;
  }
  return last;
}

const MESSAGE_MARKERS = ['"type":"user"', '"type":"assistant"'];

/** True when the session JSONL holds at least one real message (same rule as
 *  AgentService's jsonlHasMessages), streamed and stopping at the first hit.
 *  Needed because the SDK derives `firstPrompt` from the first 64 KB only —
 *  and the CLI writes a message's content BEFORE its "type" key, so a huge
 *  first message leaves no firstPrompt even though the thread is real. */
export async function sessionHasMessages(file: string): Promise<boolean> {
  const longest = Math.max(...MESSAGE_MARKERS.map((m) => m.length));
  try {
    const decoder = new TextDecoder();
    let tail = "";
    for await (const chunk of Bun.file(file).stream()) {
      // Keep a marker-sized overlap so one split across chunks still matches.
      const text = tail + decoder.decode(chunk, { stream: true });
      if (MESSAGE_MARKERS.some((m) => text.includes(m))) return true;
      tail = text.slice(-longest);
    }
  } catch {
    // unreadable — the caller treats it as "no messages" (not listed)
  }
  return false;
}

/** The session's entrypoint from its first lines ("sdk-ts", "sdk-cli", "cli",
 *  …), or null when none is recorded in the head. Monad's sessions are always
 *  SDK-started; terminal Claude Code sessions ("cli") never need a tag scan. */
export async function sessionEntrypoint(file: string): Promise<string | null> {
  try {
    const head = await Bun.file(file).slice(0, 65_536).text();
    return head.match(/"entrypoint":"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** True when a scheduled run's transcript shows it DELIVERED its output: a
 *  successful Write/Edit into the workspace's outbox/, or a successful
 *  gmail_create_draft. Used to tell "failed late, after the briefing was
 *  saved" (a success — don't retry, don't delete) from a run that died before
 *  producing anything. The CLI's synthetic "API Error: …" assistant text is
 *  not a tool call, so it never counts. */
export function transcriptDelivered(
  jsonl: string,
  workspacePath: string,
): boolean {
  // The agent may address the workspace by its given or its resolved path.
  const outboxDirs = [
    path.join(workspacePath, "outbox") + path.sep,
    path.join(canonicalCwd(workspacePath), "outbox") + path.sep,
  ];
  const inOutbox = (target: string) => {
    const abs = path.resolve(workspacePath, target);
    return outboxDirs.some((dir) => abs.startsWith(dir));
  };
  const candidates = new Set<string>();
  const failed = new Set<string>();
  const succeeded = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.includes("tool_use") && !line.includes("tool_result")) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") {
        const name = String(block.name ?? "");
        const target = block.input?.file_path;
        const delivers =
          name.endsWith("gmail_create_draft") ||
          ((name === "Write" || name === "Edit") &&
            typeof target === "string" &&
            inOutbox(target));
        if (delivers && block.id) candidates.add(block.id);
      } else if (block?.type === "tool_result" && block.tool_use_id) {
        (block.is_error ? failed : succeeded).add(block.tool_use_id);
      }
    }
  }
  for (const id of candidates) {
    if (succeeded.has(id) && !failed.has(id)) return true;
  }
  return false;
}

/** transcriptDelivered for a session on disk; false when unreadable. */
export function sessionDelivered(
  workspacePath: string,
  sessionId: string,
): boolean {
  try {
    return transcriptDelivered(
      fs.readFileSync(sessionFilePath(workspacePath, sessionId), "utf8"),
      workspacePath,
    );
  } catch {
    return false;
  }
}
