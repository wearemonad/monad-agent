import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MEMORY_SERVER,
  WORKING_MEMORY_SECTIONS,
  type MemoryHit,
  type WorkingMemorySection,
} from "../../shared/memory";
import type { EntityProfile, EntitySummary } from "./knowledgeGraph";
import type { MemoryIndexService } from "./MemoryIndexService";
import {
  applyWorkingMemoryOp,
  loadWorkingMemory,
  saveWorkingMemory,
  workingMemoryTemplate,
  type WorkingMemoryOp,
} from "./workingMemory";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const err = (message: string) => ({
  content: [{ type: "text" as const, text: `Error: ${message}` }],
  isError: true,
});

/** How many leading/trailing exchanges memory_session returns as "bookends"
 *  (the goal and the resolution), plus the window around a match. */
const BOOKEND = 3;
const MATCH_WINDOW = 2;

export type MemoryToolDeps = {
  index: MemoryIndexService;
  /** Freshen the index before reading (incremental — cheap when unchanged). */
  sync: () => Promise<void>;
};

/** One search hit rendered with its citation line — source · date · heading —
 *  so the model can quote and cite instead of paraphrasing from memory. */
export function formatHit(hit: MemoryHit, n: number): string {
  const where =
    hit.sourceType === "knowledge"
      ? `knowledge/${hit.sourcePath}`
      : `past conversation "${hit.heading || hit.sourcePath}" (session ${hit.sourcePath})`;
  const heading =
    hit.sourceType === "knowledge" && hit.heading ? ` · ${hit.heading}` : "";
  const about = hit.entities?.length
    ? ` · about: ${hit.entities.join(", ")}`
    : "";
  const weak =
    hit.confidence === "weak" ? " · WEAK match — verify before citing" : "";
  return `[${n}] ${where}${hit.date ? ` · ${hit.date}` : ""}${heading}${about}${weak}\n${hit.body}`;
}

const kpath = (p: string) => `knowledge/${p}`;

/** One entity's profile: identity, CRM link, its docs and its neighbors. */
export function formatEntity(e: EntityProfile): string {
  const lines: string[] = [];
  const head = [
    `Entity: ${e.name}${e.type ? ` (${e.type})` : ""}`,
    e.page ? `page ${kpath(e.page)}` : "no page yet",
    e.crmId ? `CRM id: ${e.crmId}` : "",
  ].filter(Boolean);
  lines.push(head.join(" · "));
  if (e.aliases.length) lines.push(`Also known as: ${e.aliases.join(", ")}`);
  if (e.summary) lines.push(`Summary: ${e.summary}`);
  lines.push(
    `Last mentioned: ${e.lastMentioned || "unknown"} · ${e.docs.length} document(s)`,
  );
  if (e.docs.length) {
    lines.push("", "Documents (newest first):");
    for (const d of e.docs.slice(0, 25))
      lines.push(`- ${kpath(d.path)} · ${d.date} · "${d.title}"`);
    if (e.docs.length > 25) lines.push(`- …and ${e.docs.length - 25} more`);
  }
  if (e.related.length) {
    lines.push("", "Related:");
    for (const r of e.related.slice(0, 20))
      lines.push(
        `- ${r.name}${r.type ? ` (${r.type})` : ""} — ${
          r.rel === "related"
            ? "linked directly"
            : `co-mentioned in ${r.count} doc(s)`
        }`,
      );
  }
  lines.push(
    "",
    `Read the page/docs above for details${e.crmId ? "; query the CRM with the CRM id for live status" : ""}. Cite the files you use.`,
  );
  return lines.join("\n");
}

export function formatEntityList(list: EntitySummary[]): string {
  if (list.length === 0)
    return "No entities match. Entities come from `entities:` frontmatter, [[wikilinks]] and pages in knowledge/entities/.";
  return [
    `${list.length} entit${list.length === 1 ? "y" : "ies"}:`,
    ...list.map(
      (e) =>
        `- ${e.name}${e.type ? ` (${e.type})` : ""} · ${e.mentions} doc(s) · last mentioned ${e.lastMentioned || "unknown"}${e.crmId ? ` · CRM id: ${e.crmId}` : ""}${e.page ? "" : " · no page yet"}`,
    ),
  ].join("\n");
}

export function formatResults(hits: MemoryHit[], query: string): string {
  if (hits.length === 0) {
    return `No memory matches for "${query}". The brain has no record of this — say so plainly rather than guessing. (Knowledge docs and past Monad conversations were searched.)`;
  }
  const lines = hits.map((h, i) => formatHit(h, i + 1));
  if (hits.every((h) => h.confidence === "weak")) {
    return `No strong match for "${query}" — treat the brain as having no reliable record of this. The nearest content is listed below as leads only; do NOT present it as an answer without verifying.\n\n${lines.join("\n\n")}`;
  }
  return `${hits.length} match(es), best first. Cite the source line when using one; treat WEAK matches as leads, not evidence.\n\n${lines.join("\n\n")}`;
}

/** In-process MCP server for memory recall. Read-only in Phase 1 (search +
 *  session context); the curated memory_remember write tool arrives with the
 *  working-memory snapshot. Auto-allowed like Read/Grep — no dialogs. */
export function buildMemoryToolsServer(
  workspacePath: string,
  deps: MemoryToolDeps,
) {
  return createSdkMcpServer({
    name: MEMORY_SERVER,
    version: "1.0.0",
    instructions:
      "Long-term memory over this workspace: knowledge/ docs AND past Monad conversations, searchable by meaning (not just keywords). Use memory_search FIRST for any question about prior work, decisions, clients, or facts — before saying something isn't known. Cite the source lines it returns. Use memory_session to read more of a specific past conversation a hit came from. Use memory_remember when the user reveals a durable fact, preference, or open decision worth having in every future session.\n\n" +
      "Knowledge graph: for a question about a specific person, company or project ('brief me on Acme', 'who is Jane'), call memory_entity — it returns the entity's page, every doc linked to it, related entities and its CRM id in one call. Use memory_entities to list entities (by type, or not mentioned in N days). When you WRITE knowledge docs, keep the graph connected: list the people/companies/projects a doc is about in its `entities:` frontmatter using their canonical names, link them inline as [[Canonical Name]], and give each recurring entity one page at knowledge/entities/<kebab-name>.md (frontmatter: type — person, company, project, product (software/tools/services) or other; aliases; crm — the CRM record id when known) that you update rather than duplicate.",
    tools: buildMemoryTools(workspacePath, deps),
  });
}

/** Tool definitions, exported separately so tests can drive the handlers. */
export function buildMemoryTools(workspacePath: string, deps: MemoryToolDeps) {
  return [
    tool(
      "memory_search",
      "Search long-term memory — the knowledge base and past conversations — by meaning and keywords. Returns matching excerpts with their source (file or session), date, and heading so you can cite them. Returns an explicit no-match message when nothing is found; never invent a recollection.",
      {
        query: z
          .string()
          .describe(
            "What to look for — natural language works (matches by meaning, not just exact words)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Max results (default 8)"),
        scope: z
          .enum(["knowledge", "session"])
          .optional()
          .describe(
            "Restrict to knowledge docs or past conversations (default: both)",
          ),
      },
      async ({ query, limit, scope }) => {
        const q = query.trim();
        if (q.length < 2) return err("query is too short.");
        try {
          await deps.sync();
          const hits = await deps.index.search(workspacePath, q, {
            limit,
            scope,
          });
          return text(formatResults(hits, q));
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
      },
    ),
    tool(
      "memory_session",
      "Read a past conversation's context: the opening exchanges (the goal), optionally the part matching a query with surrounding exchanges, and the closing exchanges (the resolution). Use after memory_search returned a session hit worth exploring.",
      {
        session_id: z
          .string()
          .describe("The session id from a memory_search conversation hit"),
        query: z
          .string()
          .optional()
          .describe(
            "Focus term: also include the best-matching exchange with surrounding context",
          ),
      },
      async ({ session_id, query }) => {
        try {
          await deps.sync();
          const chunks = deps.index.sessionChunks(
            workspacePath,
            session_id.trim(),
          );
          if (chunks.length === 0) {
            return err(
              `No indexed conversation with session id '${session_id}'.`,
            );
          }
          const parts: string[] = [];
          const title = chunks[0].heading || session_id;
          parts.push(
            `Conversation "${title}" · ${chunks[0].date} · ${chunks.length} exchange(s)`,
          );
          const shown = new Set<number>();
          const render = (label: string, from: number, to: number) => {
            const lines: string[] = [];
            for (
              let i = Math.max(0, from);
              i < Math.min(chunks.length, to);
              i++
            ) {
              if (shown.has(i)) continue;
              shown.add(i);
              lines.push(`(${i + 1}/${chunks.length}) ${chunks[i].body}`);
            }
            if (lines.length)
              parts.push(`--- ${label} ---\n${lines.join("\n\n")}`);
          };
          render("opening", 0, BOOKEND);
          if (query?.trim()) {
            const q = query.trim().toLowerCase();
            const at = chunks.findIndex((c) =>
              c.body.toLowerCase().includes(q),
            );
            if (at !== -1)
              render(
                `around match for "${query.trim()}"`,
                at - MATCH_WINDOW,
                at + MATCH_WINDOW + 1,
              );
          }
          render("ending", chunks.length - BOOKEND, chunks.length);
          return text(parts.join("\n\n"));
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
      },
    ),
    tool(
      "memory_remember",
      "Persist a durable fact into working memory — the capped snapshot injected at the start of EVERY future session. Judgment rules: (1) declarative facts, not instructions to yourself — 'User prefers concise emails' ✓, 'Always write concise emails' ✗ (imperatives get re-read as directives later and override future requests); (2) nothing that will be stale within a week — no task progress, file counts, or 'X is done' (that belongs in knowledge/ docs); (3) the snapshot in your system prompt shows current entries and capacity — replace a superseded fact instead of adding a contradicting one; (4) near the cap, consolidate first (replace/remove), then add. Writes apply from the NEXT session, not this one.",
      {
        action: z
          .enum(["add", "replace", "remove"])
          .describe("add a new entry, replace a superseded one, or remove one"),
        section: z
          .enum(
            WORKING_MEMORY_SECTIONS as unknown as [
              WorkingMemorySection,
              ...WorkingMemorySection[],
            ],
          )
          .describe(
            "active-threads = ongoing work; key-facts = durable facts/preferences; pending-decisions = open questions awaiting a call",
          ),
        text: z
          .string()
          .optional()
          .describe("The entry text (add/replace). One declarative sentence."),
        old_text: z
          .string()
          .optional()
          .describe("Unique fragment of the existing entry to replace/remove"),
      },
      async ({ action, section, text: entry, old_text }) => {
        try {
          if ((action === "add" || action === "replace") && !entry?.trim()) {
            return err("text is required for add/replace.");
          }
          if (
            (action === "replace" || action === "remove") &&
            !old_text?.trim()
          ) {
            return err("old_text is required for replace/remove.");
          }
          const op = {
            action,
            section,
            text: entry ?? "",
            old_text: old_text ?? "",
          } as WorkingMemoryOp;
          const current =
            loadWorkingMemory(workspacePath) || workingMemoryTemplate();
          const result = applyWorkingMemoryOp(current, op);
          if (!result.ok) return err(result.error);
          if (result.content !== current)
            saveWorkingMemory(workspacePath, result.content);
          return text(result.message);
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
      },
    ),
    tool(
      "memory_entity",
      "Look up one person, company, project or other entity in the knowledge graph: its page, aliases, CRM id, every knowledge doc linked to it (newest first), and related entities. Use for 'what do we know about X' / 'brief me on X' — one call instead of several searches. Accepts any known name or alias.",
      {
        name: z
          .string()
          .describe(
            "Entity name or alias, e.g. 'Acme GmbH', 'Acme', 'Jane Doe'",
          ),
      },
      async ({ name }) => {
        const q = name.trim();
        if (q.length < 2) return err("name is too short.");
        try {
          await deps.sync();
          const graph = deps.index.graph(workspacePath);
          const profile = graph.entity(q);
          if (profile) return text(formatEntity(profile));
          const near = graph.suggest(q);
          return text(
            `No entity named "${q}" in the knowledge graph.${
              near.length ? ` Did you mean: ${near.join(", ")}?` : ""
            } Entities come from \`entities:\` frontmatter, [[wikilinks]] and pages in knowledge/entities/ — use memory_search for free-text recall.`,
          );
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
      },
    ),
    tool(
      "memory_entities",
      "List entities in the knowledge graph with how many docs mention them and when they were last mentioned. Filter by type (person, company, project…) or find stale relationships with not_mentioned_since_days (e.g. 60 → entities nobody has written about in two months).",
      {
        type: z
          .string()
          .optional()
          .describe("Only this entity type, e.g. 'company' or 'person'"),
        not_mentioned_since_days: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only entities whose latest mention is older than this"),
        sort: z
          .enum(["mentions", "recent", "stale"])
          .optional()
          .describe(
            "mentions = most-linked first (default); recent / stale = by last mention",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max entities (default 50)"),
      },
      async ({ type, not_mentioned_since_days, sort, limit }) => {
        try {
          await deps.sync();
          return text(
            formatEntityList(
              deps.index.graph(workspacePath).entities({
                type,
                notMentionedSinceDays: not_mentioned_since_days,
                sort,
                limit,
              }),
            ),
          );
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
      },
    ),
  ];
}
