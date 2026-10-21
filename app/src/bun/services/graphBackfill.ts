import * as path from "node:path";
import { MEMORY_SERVER, MEMORY_WRITE_TOOL } from "../../shared/memory";
import type { GraphBackfillStatus } from "../../shared/knowledgeGraph";
import { readJsonAtomic, writeJsonAtomic } from "./atomicJson";
import { isIngestSafeTool } from "./ingestPolicy";

/** One-off "connect the existing knowledge to the graph" pass. Knowledge that
 *  predates the graph conventions has `entities:` lists at best — no entity
 *  pages (so no types, aliases or CRM ids) and no [[links]]. A hidden
 *  background agent run fixes that once per workspace; every doc it writes or
 *  edits goes through the review queue like an ingest run's would. */

/** Bump to re-run the pass everywhere (e.g. after the conventions change). */
export const GRAPH_BACKFILL_VERSION = 1;
/** Failed runs retry automatically up to this many times, then wait for a
 *  manual start — never an endless loop of paid runs. */
export const MAX_BACKFILL_ATTEMPTS = 3;

export type GraphBackfillState = {
  version: number;
  status: "done" | "failed" | "stopped" | "empty";
  attempts: number;
  finishedAt: string;
  reviewCount?: number;
  error?: string;
};

const stateFile = (wsPath: string) =>
  path.join(wsPath, ".monad", "graph-backfill.json");

export function readBackfillState(wsPath: string): GraphBackfillState | null {
  return readJsonAtomic<GraphBackfillState | null>(
    stateFile(wsPath),
    () => null,
  );
}

export function writeBackfillState(
  wsPath: string,
  state: GraphBackfillState,
): void {
  writeJsonAtomic(stateFile(wsPath), state);
}

/** Should the launch loop start the pass for this workspace? Not after a
 *  success, an empty brain, or a deliberate stop at the current version. */
export function backfillDue(state: GraphBackfillState | null): boolean {
  if (!state || state.version < GRAPH_BACKFILL_VERSION) return true;
  return state.status === "failed" && state.attempts < MAX_BACKFILL_ATTEMPTS;
}

export function backfillStatus(
  state: GraphBackfillState | null,
  running: boolean,
): GraphBackfillStatus {
  if (running) return { state: "running" };
  if (!state || state.version < GRAPH_BACKFILL_VERSION)
    return { state: "pending" };
  return {
    state: state.status,
    finishedAt: state.finishedAt,
    ...(state.reviewCount !== undefined && { reviewCount: state.reviewCount }),
    ...(state.error && { error: state.error }),
  };
}

/** knowledge/ subtrees the pass must never write: archived originals, the
 *  auto-captured daily logs (hash-idempotent machine output), and the
 *  working-memory snapshot (injected into every prompt). */
const READ_ONLY = ["originals/", "notes/daily/", "working-memory.md"];

/** Tools the pass may use without a dialog: memory recall (never the
 *  working-memory write), workspace-scoped reads, and Write/Edit confined to
 *  knowledge/ minus the read-only parts above. No shell — linking needs none.
 *  CRM lookups fall through to the workspace's always-allow list. */
export function isGraphBackfillSafeTool(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
): boolean {
  if (toolName.startsWith(`mcp__${MEMORY_SERVER}__`))
    return toolName !== MEMORY_WRITE_TOOL;
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep")
    return isIngestSafeTool(toolName, input, workspacePath);
  if (toolName !== "Write" && toolName !== "Edit") return false;
  if (!isIngestSafeTool(toolName, input, workspacePath, KNOWLEDGE_ONLY))
    return false;
  const rel = path
    .relative(
      path.join(workspacePath, "knowledge"),
      path.resolve(workspacePath, String(input.file_path)),
    )
    .split(path.sep)
    .join("/");
  return !READ_ONLY.some((p) => rel === p || rel.startsWith(p));
}

const KNOWLEDGE_ONLY = new Set(["knowledge"]);

export function buildGraphBackfillPrompt(): string {
  return `One-off maintenance task: connect this workspace's EXISTING knowledge base to the knowledge graph. Work silently and finish with a short report. Do not process inbox/ and do not create new topic documents.

The graph is built from markdown conventions:
- a doc's \`entities:\` frontmatter lists the canonical names of the people, companies, projects and products it is about;
- inline [[Canonical Name]] wikilinks;
- one page per recurring entity at knowledge/entities/<kebab-name>.md.

Steps:
1. Survey: call memory_entities (limit 200) to see the names already referenced, and Glob knowledge/**/*.md. Skip knowledge/originals/, knowledge/notes/daily/, knowledge/working-memory.md and INDEX.md (you may read the daily logs as sources, never edit them).
2. Pick one canonical name per real-world entity. Merge variants (e.g. "Acme", "ACME Ltd", "Acme GmbH") under the most complete official name and keep the rest as aliases. A trading name and the legal company behind it may be separate entities linked via \`related:\`.
3. For each doc, Edit it so that:
   - its \`entities:\` frontmatter lists every person/company/project/product it is substantively about, by canonical name (add missing frontmatter fields only — never drop existing ones);
   - the first meaningful mention of each such entity in the body becomes [[Canonical Name]] (or [[Canonical Name|text as written]]). Change nothing else: no rewording, no reformatting, no summarising.
4. Create knowledge/entities/<kebab-name>.md for every entity that appears in two or more docs, or is central on its own (a client, prospect, supplier, partner, key person, or a project/product we build). Format:
   ---
   type: person | company | project | product | other   (product = software, tools, services)
   aliases: [other names]
   crm: <record id>        # only if the twenty CRM tools are available AND you found the record; otherwise omit
   related: [Other Canonical Name, …]
   ---
   # Canonical Name

   One paragraph: who/what it is and how it relates to us.

   ## Key facts
   - YYYY-MM-DD — fact, linked to its source doc as [[doc-file-slug]]

   Use ONLY facts stated in the knowledge docs (or the CRM). Never invent or guess; leave a field out rather than speculate. If a page already exists, update it instead of creating another.
5. Add one line per new entity page to knowledge/INDEX.md under an "## entities/" heading: \`entities/<file>.md\` — one-sentence summary — [type].
6. Report: entity pages created/updated, docs linked, merges made, anything ambiguous for a human to check. All your changes go to the user's review queue.`;
}
