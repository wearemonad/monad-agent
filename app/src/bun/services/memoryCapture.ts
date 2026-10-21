import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { chunkSessionJsonl } from "./MemoryIndexService";

/** Capture-everything, the cheap way: after each interactive run, the last
 *  user↔assistant exchange is condensed (no LLM — verbatim excerpts search
 *  BETTER than paraphrases, and the cost is zero) and appended to a dated
 *  daily log under a marked auto-captured section. Idempotent via a content
 *  hash embedded in the file. Months later, memory_search finds the exact
 *  conversation a decision came from, cited by date. */

export type CapturedExchange = { body: string; hash: string };

/** Condense the final exchange of a session JSONL. Returns null when the
 *  session has no visible conversational exchange (tool-only runs). */
export function condenseLastExchange(
  jsonl: string,
  fileDate: string,
): CapturedExchange | null {
  const chunks = chunkSessionJsonl(jsonl, fileDate);
  const last = chunks[chunks.length - 1];
  if (!last) return null;
  const body = last.body
    .replace(/^User: /m, "User asked: ")
    .replace(/^Assistant: /m, "Agent answered: ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return {
    body,
    hash: createHash("sha256").update(body).digest("hex").slice(0, 12),
  };
}

export function dailyLogRelPath(now: Date): string {
  return path.join("notes", "daily", `${localDate(now)}.md`);
}

function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Append one captured exchange to today's daily log (creating it with the
 *  workspace frontmatter convention on first write). The content hash marker
 *  makes re-capture of the same exchange a no-op. Returns the knowledge/-
 *  relative path when something was written, null when skipped as duplicate. */
export function appendCapture(
  workspacePath: string,
  sessionId: string,
  exchange: CapturedExchange,
  now = new Date(),
): { relPath: string; created: boolean } | null {
  const rel = dailyLogRelPath(now);
  const full = path.join(workspacePath, "knowledge", rel);
  let existing = "";
  try {
    existing = fs.readFileSync(full, "utf8");
  } catch {
    // first capture of the day
  }
  const marker = `<!-- cap:${exchange.hash} -->`;
  if (existing.includes(marker)) return null;
  const date = localDate(now);
  const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const created = !existing;
  const header = created
    ? `---\nsource: auto-capture\ningested: ${date}\ntags: [daily-log, auto-captured]\nentities: []\n---\n\n# Daily log — ${date}\n\n## Auto-captured\n`
    : "";
  const entry = `\n${hm} · session ${sessionId} ${marker}\n\n${exchange.body}\n`;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, header + entry);
  return { relPath: rel, created };
}

/** How many interactive runs between background memory-review passes. The
 *  Hermes default: frequent enough to catch preferences while they're fresh,
 *  rare enough that the token cost stays negligible next to the chat itself. */
export const MEMORY_REVIEW_INTERVAL = 10;

/** Prompt for the hidden review run. It sees the working-memory snapshot in
 *  its system prompt (every run does), reads the recent daily logs, and may
 *  ONLY call memory tools + workspace-scoped read tools — its writes are
 *  memory_remember or nothing, and the review queue diffs the result. */
export function buildReviewPrompt(dates: string[]): string {
  return [
    `Memory review pass. Read the auto-captured daily log(s): ${dates
      .map((d) => `knowledge/notes/daily/${d}.md`)
      .join(", ")} (skip any that don't exist).`,
    "Look ONLY for durable signals about the user or the business: revealed preferences, working style, standing facts, decisions made or newly pending. Compare against the WORKING MEMORY snapshot in your context — record genuinely new facts with memory_remember, replace superseded ones, and leave everything else alone.",
    "Rules: declarative facts, not instructions; nothing that will be stale in a week; no task progress. Most passes should save at most one or two entries.",
    "If nothing merits saving, reply exactly: Nothing to save.",
  ].join("\n");
}

/** Persisted per-workspace counter driving the review cadence. */
export function bumpReviewCounter(stateFile: string): number {
  let state: { runsSinceReview?: number } = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    // missing/corrupt — restart the count rather than fail
  }
  const n = (state.runsSinceReview ?? 0) + 1;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, runsSinceReview: n }));
  return n;
}

export function resetReviewCounter(stateFile: string): void {
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    // fine — write fresh
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, runsSinceReview: 0 }));
}
