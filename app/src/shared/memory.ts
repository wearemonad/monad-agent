// Shared memory-system contract (bun process + webview + workspace template).

/** Name of the in-process MCP server exposing memory tools. */
export const MEMORY_SERVER = "memory";

/** Always-allow rule covering every memory tool. Read-mostly by design: the
 *  only writing tool (memory_remember) is capped and confined to
 *  knowledge/working-memory.md, the same trust story as the artifact tools. */
export const MEMORY_ALLOW_RULE = `mcp__${MEMORY_SERVER}__*`;

/** Full tool name of the one memory tool that WRITES. Background runs process
 *  untrusted content (inbox files, emails) and working memory lands in every
 *  future system prompt — a poisoned entry would persist across sessions. So
 *  this tool is denied in ALL background runs unless a run's own safeTools
 *  explicitly allows it (the curated memory-review run does); the always-allow
 *  rule above must never resurrect it there. */
export const MEMORY_WRITE_TOOL = `mcp__${MEMORY_SERVER}__memory_remember`;

/** Where a search hit came from — knowledge base doc or a past conversation. */
export type MemorySourceType = "knowledge" | "session";

/** One recalled chunk, always with its citation metadata (source · date ·
 *  heading) so answers can cite instead of paraphrasing from nothing. */
export type MemoryHit = {
  sourceType: MemorySourceType;
  /** knowledge/-relative doc path, or the session id for conversations. */
  sourcePath: string;
  /** Section heading (knowledge) or session title (conversations). */
  heading: string;
  /** YYYY-MM-DD the content was written/ingested. */
  date: string;
  body: string;
  score: number;
  /** "weak": semantic-only match below the strong-similarity line — a lead
   *  worth checking, not evidence. Absolute cosine can't cleanly separate
   *  related from unrelated across content types, so borderline hits are
   *  labeled instead of hidden. */
  confidence: "strong" | "weak";
  /** Knowledge-graph entities the source doc is about (knowledge hits only),
   *  so the model sees WHO/WHAT an excerpt concerns even when the body only
   *  says "the client". */
  entities?: string[];
};

/** Character budget for knowledge/working-memory.md — the always-injected
 *  snapshot. Small on purpose: a memory file allowed to grow forever stops
 *  being memory and becomes a junk drawer (the cap IS the retrieval strategy). */
export const WORKING_MEMORY_CHAR_LIMIT = 2_500;

/** Workspace-relative path of the working-memory snapshot. */
export const WORKING_MEMORY_PATH = "knowledge/working-memory.md";

/** Fixed sections of the working-memory file. Kept as an ordered list so the
 *  tool schema, the file template, and the parser can never disagree. */
export const WORKING_MEMORY_SECTIONS = [
  "active-threads",
  "key-facts",
  "pending-decisions",
] as const;
export type WorkingMemorySection = (typeof WORKING_MEMORY_SECTIONS)[number];

export const WORKING_MEMORY_SECTION_TITLES: Record<
  WorkingMemorySection,
  string
> = {
  "active-threads": "Active threads",
  "key-facts": "Key facts",
  "pending-decisions": "Pending decisions",
};
