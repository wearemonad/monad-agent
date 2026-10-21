import * as fs from "node:fs";
import * as path from "node:path";

/** Which tools a background ingest run may use without a permission dialog.
 *
 *  Background runs can't prompt, so ingest gets a scoped allowlist instead:
 *  file tools whose every path stays inside the workspace, plus a narrow set
 *  of shell commands the ingest skill needs (ls/mv/textutil…). This is safe
 *  because (a) the run's cwd is the workspace, (b) paths outside it are
 *  rejected, (c) writes are confined to the content subtrees — never the
 *  executable agent config (.mcp.json, .claude/, CLAUDE.md) — and (d) the
 *  review queue diffs knowledge/ after the run so every written doc still
 *  passes through the user's accept/reject.
 */

/** Tools whose inputs carry paths; missing path keys default to the cwd. */
const FILE_TOOL_PATH_KEYS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Glob: ["path"],
  Grep: ["path"],
};

const WRITE_TOOLS = new Set(["Write", "Edit"]);

/** The only subtrees an ingest run may write into. Everything else in the
 *  workspace root — .mcp.json, .claude/, CLAUDE.md, skills — is executable
 *  agent config: a prompt-injected write there becomes code execution on the
 *  next run. */
const WRITE_SUBTREES = new Set(["knowledge", "inbox", "artifacts"]);

/** First words the ingest skill legitimately runs. No network, no deletion. */
const SAFE_BASH_COMMANDS = new Set([
  "ls",
  "mv",
  "cp",
  "mkdir",
  "cat",
  "head",
  "wc",
  "file",
  "textutil",
  "echo",
]);

/** Shell metacharacters that could smuggle a second command, a redirect, or an
 *  expansion escaping the workspace (`~` expands to $HOME, so `cat ~/x` would
 *  dodge the absolute-path check). `&&` and `;` sequences are handled by
 *  splitting first; a lone `&` or pipe is rejected. `*` stays allowed: relative
 *  globs expand against the cwd (the workspace), and absolute ones fail the
 *  path check. */
const BASH_META = /[;|&`$<>(){}\n\\~]/;

/** Told to the agent when a background run's tool call falls outside this
 *  policy. A bare "not allowed" reads as "shell is off entirely" and the agent
 *  gives up on files it could have converted (a .docx needs textutil) — this
 *  spells out what WILL pass so it retries with a narrower call. */
export function backgroundPolicyHint(toolName: string): string {
  if (toolName === "Bash")
    return `That shell command is outside the background-run policy, but simpler commands are allowed — retry. Allowed: ${[...SAFE_BASH_COMMANDS].join(", ")}, with workspace-relative paths, one command per call or chained with && / ;. Not allowed: pipes, redirects, $(…), ~, .., cd, paths outside the workspace, or dotfiles/CLAUDE.md.`;
  return `${toolName} on that path is outside the background-run policy: paths must stay inside the workspace, never touch dotfiles or CLAUDE.md, and writes may only go into this run's content folders. Retry with an allowed path.`;
}

/** Tools whose safety the ingest policy decides authoritatively. When the
 *  policy rejects one of these, a name-only always-allow grant must NOT
 *  resurrect it — the grant carries no path scope. */
export function isIngestGovernedTool(toolName: string): boolean {
  return toolName === "Bash" || toolName in FILE_TOOL_PATH_KEYS;
}

export function isIngestSafeTool(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
  writeSubtrees: ReadonlySet<string> = WRITE_SUBTREES,
): boolean {
  if (toolName === "Bash")
    return isSafeBash(String(input.command ?? ""), workspacePath);
  const pathKeys = FILE_TOOL_PATH_KEYS[toolName];
  if (!pathKeys) return false;
  for (const key of pathKeys) {
    const value = input[key];
    if (value === undefined || value === null || value === "") {
      // Missing path defaults to the cwd — fine for search tools, but a
      // write tool with no explicit target is malformed: reject.
      if (WRITE_TOOLS.has(toolName)) return false;
      continue;
    }
    if (typeof value !== "string" || !insideWorkspace(value, workspacePath))
      return false;
    if (isProtectedTarget(value, workspacePath)) return false;
    if (
      WRITE_TOOLS.has(toolName) &&
      !inWriteSubtree(value, workspacePath, writeSubtrees)
    )
      return false;
  }
  return true;
}

/** Scheduled jobs (briefing, CRM status, meeting prep) deliver into outbox/
 *  and artifacts/ — never knowledge/: unlike ingest, a scheduled run's writes
 *  do not pass through the review queue, and its inputs include untrusted
 *  email/CRM content, so the brain itself stays read-only to it. */
const SCHEDULED_WRITE_SUBTREES = new Set(["outbox", "artifacts"]);

/** Which tools a scheduled background run may use without a permission dialog:
 *  the same workspace-contained file tools and safe shell subset as ingest,
 *  with writes confined to outbox/ + artifacts/. Because this list makes the
 *  run's verdict on file tools and Bash final (backgroundToolDecision), a
 *  name-only always-allow grant can no longer widen a scheduled run's file or
 *  shell access beyond it — deliberate: these runs read untrusted content. */
export function isScheduledSafeTool(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
): boolean {
  return isIngestSafeTool(
    toolName,
    input,
    workspacePath,
    SCHEDULED_WRITE_SUBTREES,
  );
}

/** For always-allowed tools in agent runs: true when every path input stays
 *  inside the workspace (or the tool carries no path inputs at all). Used to
 *  path-scope the name-only always-allow list — "Read is auto-allowed" must
 *  mean "read this workspace", not "read any file on the machine". */
export function fileToolPathsInsideWorkspace(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
): boolean {
  const pathKeys = FILE_TOOL_PATH_KEYS[toolName];
  if (!pathKeys) return true;
  for (const key of pathKeys) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue; // defaults to cwd
    if (typeof value !== "string" || !insideWorkspace(value, workspacePath))
      return false;
  }
  return true;
}

function isSafeBash(command: string, workspacePath: string): boolean {
  if (!command.trim()) return false;
  // Permit `mkdir -p x && mv y x` / `ls inbox; cat a.md` style sequences;
  // validate each segment alone. A `;` inside quotes splits mid-quote and
  // leaves an unterminated quote, which rejects — stricter, never looser.
  for (const segment of command.split(/&&|;/)) {
    if (!isSafeBashSegment(segment.trim(), workspacePath)) return false;
  }
  return true;
}

function isSafeBashSegment(segment: string, workspacePath: string): boolean {
  if (!segment || BASH_META.test(segment) || segment.includes(".."))
    return false;
  const tokens = splitShellWords(segment);
  if (!tokens || tokens.length === 0) return false;
  // Agents habitually prefix `cd "<workspace>" &&`. Changing into the root is
  // a no-op (it is already the cwd), so allow exactly that — any other target
  // would re-base the relative paths every later segment was checked against.
  if (tokens[0] === "cd")
    return (
      tokens.length === 2 &&
      realResolve(path.resolve(workspacePath, tokens[1])) ===
        realResolve(path.resolve(workspacePath))
    );
  if (!SAFE_BASH_COMMANDS.has(tokens[0])) return false;
  return tokens.slice(1).every((t) => isSafeBashArg(t, workspacePath));
}

/** Split on whitespace honoring quote grouping, the way bash will. Stripping
 *  quotes per-token is NOT safe — `""/etc/passwd` strips to a token that
 *  dodges naive checks while bash still opens /etc/passwd — so tokens are
 *  built by consuming quoted groups; an unterminated quote rejects the whole
 *  segment. Quotes only group spaces here (metacharacters and backslash are
 *  rejected before tokenizing). */
function splitShellWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(current);
  return words;
}

function isSafeBashArg(token: string, workspacePath: string): boolean {
  if (token.startsWith("-")) {
    // Bare flags carry no path. `--flag=VALUE` values are checked as paths:
    // containment always; the protected-config check only when the value is
    // path-shaped or names an existing file (so `--suffix=.bak` passes but
    // `--files0-from=.mcp.json` does not).
    const eq = token.indexOf("=");
    if (eq === -1) return true;
    const value = token.slice(eq + 1);
    if (!value) return true;
    if (!insideWorkspace(value, workspacePath)) return false;
    const pathShaped =
      value.includes("/") || fs.existsSync(path.resolve(workspacePath, value));
    return !(pathShaped && isProtectedTarget(value, workspacePath));
  }
  // Every plain argument is resolved against the workspace and must stay
  // inside it — no `startsWith("/")` special-casing for the boundary check.
  return (
    insideWorkspace(token, workspacePath) &&
    !isProtectedTarget(token, workspacePath)
  );
}

/** Paths the ingest run must never touch, read or write: the workspace's
 *  executable agent config. Writing .mcp.json registers a server Monad itself
 *  spawns on the next run; .claude/ holds settings/hooks/skills; CLAUDE.md is
 *  injected into every prompt. Any dotfile segment is denied wholesale. */
function isProtectedTarget(p: string, workspacePath: string): boolean {
  const rel = path.relative(
    path.resolve(workspacePath),
    path.resolve(workspacePath, p),
  );
  if (!rel || rel.startsWith("..")) return false; // root/outside: handled elsewhere
  if (rel.toLowerCase() === "claude.md") return true;
  return rel.split(path.sep).some((segment) => segment.startsWith("."));
}

function inWriteSubtree(
  p: string,
  workspacePath: string,
  writeSubtrees: ReadonlySet<string>,
): boolean {
  const rel = path.relative(
    path.resolve(workspacePath),
    path.resolve(workspacePath, p),
  );
  if (!rel || rel.startsWith("..")) return false;
  const segments = rel.split(path.sep);
  return segments.length >= 2 && writeSubtrees.has(segments[0]);
}

function insideWorkspace(p: string, workspacePath: string): boolean {
  const root = realResolve(path.resolve(workspacePath));
  const target = realResolve(path.resolve(workspacePath, p));
  return target === root || target.startsWith(root + path.sep);
}

/** Resolve symlinks through the deepest existing ancestor so a symlink dropped
 *  into inbox/ (via Drive sync, a watched folder, a zip) can't point path
 *  resolution outside the workspace. Non-existent tails (e.g. a Write target)
 *  are re-joined onto the resolved ancestor. */
function realResolve(p: string): string {
  let current = p;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current)
        return suffix.length ? path.join(current, ...suffix) : current;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
