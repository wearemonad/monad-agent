import * as fs from "node:fs";
import * as path from "node:path";
import {
  deleteSession,
  getSessionMessages,
  listSessions,
  renameSession,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ArtifactType,
  ChatItem,
  ContentHit,
  SessionSummary,
} from "../../shared/ipc";
import { summarize } from "./PermissionBroker";
import {
  applyArtifactUpdate,
  artifactOpFromToolName,
  stripOuterFence,
} from "../../shared/artifacts";
import { readArtifact } from "./artifactTools";
import { DRAFT_EMAIL_TOOL, parseEmailDraftInput } from "../../shared/email";
import { GENERATE_IMAGE_TOOL, parseImageToolResult } from "../../shared/images";
import {
  forgetSessionKind,
  forgetSessionOwner,
  forgetSessionOwners,
  readSessionKinds,
  readSessionOwners,
  recordSessionOwners,
  type SessionOwnerEntry,
} from "./sessionMeta";
import {
  canonicalCwd,
  claudeProjectDir,
  lastTagInFile,
  sessionEntrypoint,
  sessionHasMessages,
} from "./sessionFiles";

export { encodeProjectDir } from "./sessionFiles";

/** The CLI keyword behind the composer's Ultrathink level, appended to the
 *  turn's prompt by AgentService — stripped again when history replays, so
 *  the user sees what they typed. */
export const ULTRATHINK_SUFFIX = "\n\nultrathink";

function withoutUltrathink(text: string): string {
  return text.endsWith(ULTRATHINK_SUFFIX)
    ? text.slice(0, -ULTRATHINK_SUFFIX.length)
    : text;
}

/** Tag value marking sessions created by Monad for a given workspace. */
export const monadTag = (workspaceId: string) => `monad:${workspaceId}`;

/** Upper bound handed to the SDK. The Monad filter runs AFTER listing, so a
 *  small limit would let hidden ingest/memory-review runs and terminal
 *  sessions in the same folder push real threads off the list. A limit (vs
 *  none) keeps the SDK's batched reader, which opens files 32 at a time. */
const LIST_LIMIT = 100_000;

/** One entry of the SDK's session listing. */
type Listed = Awaited<ReturnType<typeof listSessions>>[number];

/** True when an SDK firstPrompt (≤~200 chars, "…"-truncated) is one of the
 *  given job prompts. Used to recognise scheduled briefings that predate the
 *  per-session kind stamp. */
export function matchesJobPrompt(
  firstPrompt: string | undefined,
  prompts: string[],
): boolean {
  if (!firstPrompt) return false;
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const fp = norm(firstPrompt);
  const truncated = fp.endsWith("…") ? fp.slice(0, -1).trimEnd() : null;
  return prompts.some((p) => {
    const jp = norm(p);
    if (!jp) return false;
    return jp === fp || (truncated !== null && jp.startsWith(truncated));
  });
}

/** First conversational-text match for `query` in a session JSONL, as a short
 *  ±-context snippet. Only user/assistant text blocks count — tool payloads
 *  and metadata lines would drown the results in noise. */
export function extractSnippet(jsonl: string, query: string): string | null {
  const q = query.toLowerCase();
  for (const line of jsonl.split("\n")) {
    if (!line.includes("{")) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type !== "user" && msg.type !== "assistant") continue;
    const content = msg.message?.content;
    const texts: string[] =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content
              .filter((b: any) => b?.type === "text" && b.text)
              .map((b: any) => b.text)
          : [];
    for (const text of texts) {
      const at = text.toLowerCase().indexOf(q);
      if (at === -1) continue;
      if (text.startsWith("<")) continue; // injected system/reminder payloads
      const start = Math.max(0, at - 60);
      const end = Math.min(text.length, at + query.length + 60);
      return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
    }
  }
  return null;
}

/** Read-only, workspace-scoped view over the SDK's persisted sessions.
 *
 *  Scoping is belt-and-braces: `dir` restricts to the workspace folder, and the
 *  Monad tag filter hides sessions other apps (terminal Claude Code, etc.)
 *  created in that same folder. Nothing here mutates foreign history. */
export class SessionStore {
  /** sessionId → `size:mtime` + whether the file holds a real message, for
   *  owned sessions the SDK reported without a firstPrompt (see isGhost). */
  private messageCheck = new Map<string, { fp: string; has: boolean }>();

  async list(
    cwd: string,
    workspaceId: string,
    /** Prompts of the workspace's briefing jobs — scheduled briefings from
     *  before threads were kind-stamped are recognised by their prompt. */
    briefingPrompts: string[] = [],
  ): Promise<SessionSummary[]> {
    try {
      const sessions = await listSessions({ dir: cwd, limit: LIST_LIMIT });
      const owned = await this.ownedSessions(cwd, workspaceId, sessions);
      const resolvedCwd = canonicalCwd(cwd);
      const ghosts = await this.ghosts(
        cwd,
        sessions.filter((s) => owned.has(s.sessionId)),
      );
      // Background-created threads (briefings, meeting prep) carry a kind so
      // the UI can badge them; their titles are code-composed via customTitle.
      const kinds = readSessionKinds(cwd);
      return (
        sessions
          .filter((s) => owned.has(s.sessionId))
          .filter((s) => !s.cwd || s.cwd === cwd || s.cwd === resolvedCwd)
          // Ghost threads — files holding only CLI metadata (a run that
          // died/was stopped before anything was persisted): nothing to open.
          .filter((s) => !ghosts.has(s.sessionId))
          .map((s) => ({
            sessionId: s.sessionId,
            title:
              s.customTitle ??
              s.summary ??
              s.firstPrompt?.slice(0, 60) ??
              "Untitled",
            updatedAt: s.lastModified
              ? new Date(s.lastModified).toISOString()
              : undefined,
            kind:
              kinds[s.sessionId] ??
              (matchesJobPrompt(s.firstPrompt, briefingPrompts)
                ? ("briefing" as const)
                : undefined),
          }))
          .filter((s) => s.sessionId)
      );
    } catch {
      return [];
    }
  }

  /** Owned sessions whose file holds no real message. A firstPrompt from the
   *  SDK proves there is one; its absence usually means a ghost — but the SDK
   *  looks only at the first 64 KB, and a huge first message (an enormous
   *  paste) pushes its "type" key past that, so absence is confirmed against
   *  the file itself (streamed, stops at the first message; cached by
   *  size:mtime). */
  private async ghosts(cwd: string, sessions: Listed[]): Promise<Set<string>> {
    const ghosts = new Set<string>();
    const dir = claudeProjectDir(cwd);
    for (const s of sessions) {
      if (s.firstPrompt) continue;
      const fp = `${s.fileSize ?? 0}:${s.lastModified}`;
      let known = this.messageCheck.get(s.sessionId);
      if (known?.fp !== fp) {
        known = {
          fp,
          has: await sessionHasMessages(path.join(dir, `${s.sessionId}.jsonl`)),
        };
        this.messageCheck.set(s.sessionId, known);
      }
      if (!known.has) ghosts.add(s.sessionId);
    }
    return ghosts;
  }

  /** Which listed sessions are this workspace's Monad threads.
   *
   *  The SDK reports a session's tag from the last 64 KB of its JSONL only,
   *  and current CLIs no longer re-append a tag written from outside the
   *  process — so after a long run (a briefing, a tool-heavy chat) the tag
   *  falls out of that window and the thread would vanish. Ownership is
   *  therefore decided as: an explicit tail tag wins; otherwise the recorded
   *  owner (.monad/session-owners.json, written when the run starts);
   *  otherwise a one-time scan of the whole file for its last tag entry,
   *  whose result is cached. Terminal (non-SDK) sessions are never scanned. */
  private async ownedSessions(
    cwd: string,
    workspaceId: string,
    sessions: Listed[],
  ): Promise<Set<string>> {
    const mine = monadTag(workspaceId);
    const owners = readSessionOwners(cwd);
    const dir = claudeProjectDir(cwd);
    const owned = new Set<string>();
    const updates: Record<string, SessionOwnerEntry> = {};
    let recovered = 0;
    // Sequential on purpose: only cache misses get here, and a first launch
    // over a large folder shouldn't open hundreds of streams at once.
    for (const s of sessions) {
      if (s.tag) {
        if (s.tag === mine) owned.add(s.sessionId);
        continue;
      }
      const known = owners[s.sessionId];
      if (known?.owner) {
        if (known.owner === workspaceId) owned.add(s.sessionId);
        continue;
      }
      const fp = `${s.fileSize ?? 0}:${s.lastModified}`;
      if (known && known.fp === fp) continue; // cached negative, file unchanged
      const file = path.join(dir, `${s.sessionId}.jsonl`);
      const entrypoint = await sessionEntrypoint(file);
      let owner: string | null = null;
      if (!entrypoint || entrypoint.startsWith("sdk-")) {
        const tag = await lastTagInFile(file);
        if (tag?.startsWith("monad:")) owner = tag.slice("monad:".length);
      }
      updates[s.sessionId] = owner ? { owner } : { owner: null, fp };
      if (owner === workspaceId) {
        owned.add(s.sessionId);
        recovered++;
      }
    }
    if (Object.keys(updates).length) recordSessionOwners(cwd, updates);
    if (recovered) {
      console.info(
        `[sessions] recovered ${recovered} thread(s) whose tag fell outside the SDK's tail window (${cwd})`,
      );
    }
    // Entries for sessions whose file is gone (deleted elsewhere).
    const listed = new Set(sessions.map((s) => s.sessionId));
    forgetSessionOwners(
      cwd,
      (id) => !listed.has(id) && !fs.existsSync(path.join(dir, `${id}.jsonl`)),
    );
    return owned;
  }

  /** Set a custom title on a session (shown in the sidebar and ⌘K search). */
  async rename(
    cwd: string,
    sessionId: string,
    title: string,
  ): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed) return false;
    try {
      await renameSession(sessionId, trimmed, { dir: cwd });
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a session file. Scoped to the workspace dir so foreign history is untouched. */
  async remove(cwd: string, sessionId: string): Promise<boolean> {
    try {
      await deleteSession(sessionId, { dir: cwd });
      forgetSessionKind(cwd, sessionId);
      forgetSessionOwner(cwd, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /** Sessions eligible for memory indexing — Monad-tagged only (hidden ingest
   *  and background runs never pollute recall) — with their JSONL paths. */
  async listForIndex(
    cwd: string,
    workspaceId: string,
  ): Promise<{ sessionId: string; title: string; jsonlPath: string }[]> {
    const dir = claudeProjectDir(cwd);
    return (await this.list(cwd, workspaceId)).map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      jsonlPath: path.join(dir, `${s.sessionId}.jsonl`),
    }));
  }

  /** Full-text search inside this workspace's saved conversations. Scans the
   *  session JSONL files directly (no index — fine at hundreds of sessions);
   *  candidate sessions come from list(), so the Monad tag filter still applies. */
  async searchContent(
    cwd: string,
    workspaceId: string,
    query: string,
    limit = 12,
  ): Promise<ContentHit[]> {
    const q = query.trim();
    if (q.length < 3) return [];
    const dir = claudeProjectDir(cwd);
    const hits: ContentHit[] = [];
    for (const session of await this.list(cwd, workspaceId)) {
      if (hits.length >= limit) break;
      let raw: string;
      try {
        raw = fs.readFileSync(
          path.join(dir, `${session.sessionId}.jsonl`),
          "utf8",
        );
      } catch {
        continue;
      }
      const snippet = extractSnippet(raw, q);
      if (snippet)
        hits.push({
          sessionId: session.sessionId,
          title: session.title,
          snippet,
        });
    }
    return hits;
  }

  /** Replay a persisted session as ChatItems (same model the live stream
   *  renders to), plus the thread's last context footprint for the meter. */
  async history(
    cwd: string,
    sessionId: string,
  ): Promise<{ items: ChatItem[]; contextTokens: number }> {
    const items: ChatItem[] = [];
    let contextTokens = 0;
    try {
      const messages = await getSessionMessages(sessionId, { dir: cwd });
      contextTokens = lastContextTokens(messages as unknown[]);
      // Artifact tool calls whose result errored render as generic tool rows;
      // successful ones become artifact cards. Results arrive in later
      // messages, so collect the error'd ids up front.
      const erroredToolUse = new Set<string>();
      for (const msg of messages as any[]) {
        const content = (msg.message ?? msg)?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === "tool_result" && block.is_error)
            erroredToolUse.add(block.tool_use_id);
        }
      }
      // Version reconstruction: fold create/update/rewrite inputs in order.
      // An update whose base is unknown (artifact created in an earlier,
      // separate session) falls back to the current on-disk content.
      const contentById = new Map<string, string>();
      const kindById = new Map<string, { type: ArtifactType; title: string }>();
      // Successful generate_image calls: their images arrive in the result.
      const imageToolUses = new Set<string>();
      for (const msg of messages as any[]) {
        const m = msg.message ?? msg;
        const role = m?.role ?? msg.type;
        const content = m?.content;
        if (typeof content === "string") {
          if (isVisibleReplayText(content)) {
            items.push(
              role === "user"
                ? { type: "user", text: withoutUltrathink(content) }
                : { type: "assistant", text: content },
            );
          }
          continue;
        }
        for (const block of content ?? []) {
          // Same guard as the string branch: system-injected payloads
          // (<system-reminder>, <command-…>) arrive in array form too and must
          // not replay as the user's own words.
          if (block.type === "text" && isVisibleReplayText(block.text)) {
            items.push(
              role === "user"
                ? { type: "user", text: withoutUltrathink(block.text) }
                : { type: "assistant", text: block.text },
            );
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            items.push({ type: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            const op = artifactOpFromToolName(block.name);
            const artifactId =
              typeof block.input?.id === "string" ? block.input.id : "";
            if (op && artifactId && !erroredToolUse.has(block.id)) {
              const artifact = this.replayArtifactOp(
                cwd,
                op,
                artifactId,
                block.input,
                contentById,
                kindById,
              );
              if (artifact) {
                items.push(artifact);
                continue;
              }
            }
            if (
              block.name === GENERATE_IMAGE_TOOL &&
              !erroredToolUse.has(block.id)
            ) {
              imageToolUses.add(block.id);
              continue;
            }
            if (
              block.name === DRAFT_EMAIL_TOOL &&
              !erroredToolUse.has(block.id)
            ) {
              const draft = parseEmailDraftInput(block.input);
              if (draft) {
                items.push({ type: "email-draft", draft });
                continue;
              }
            }
            items.push({
              type: "tool",
              toolUseId: block.id,
              name: block.name,
              inputSummary: summarize(block.name, block.input),
              pending: false,
            });
          } else if (block.type === "tool_result") {
            if (imageToolUses.has(block.tool_use_id)) {
              for (const img of parseImageToolResult(block.content)) {
                items.push({ type: "image", ...img });
              }
              continue;
            }
            const prior = items.find(
              (i) => i.type === "tool" && i.toolUseId === block.tool_use_id,
            );
            if (prior && prior.type === "tool") {
              prior.output =
                typeof block.content === "string"
                  ? block.content.slice(0, 2000)
                  : Array.isArray(block.content)
                    ? block.content
                        .map((c: any) => (c?.type === "text" ? c.text : ""))
                        .join("\n")
                        .slice(0, 2000)
                    : "";
              prior.isError = !!block.is_error;
            }
          }
        }
      }
    } catch (e) {
      items.push({
        type: "error",
        text: `Could not load session: ${String(e)}`,
      });
    }
    return { items, contextTokens };
  }

  /** One artifact tool_use → an artifact ChatItem with the post-op content,
   *  or null when it can't be reconstructed (renders as a generic tool row). */
  private replayArtifactOp(
    cwd: string,
    op: "create" | "update" | "rewrite",
    artifactId: string,
    input: any,
    contentById: Map<string, string>,
    kindById: Map<string, { type: ArtifactType; title: string }>,
  ): ChatItem | null {
    if (op === "create") {
      if (typeof input?.content !== "string" || typeof input?.type !== "string")
        return null;
      kindById.set(artifactId, {
        type: input.type,
        title: String(input.title ?? artifactId),
      });
      contentById.set(artifactId, stripOuterFence(input.content));
    } else {
      // update/rewrite may target an artifact created in an earlier session —
      // seed kind/content from disk when this session didn't create it.
      if (!kindById.has(artifactId)) {
        const disk = readArtifact(cwd, artifactId);
        if (!disk) return null;
        kindById.set(artifactId, { type: disk.type, title: disk.title });
        if (!contentById.has(artifactId))
          contentById.set(artifactId, disk.content);
      }
      if (op === "rewrite") {
        if (typeof input?.content !== "string") return null;
        contentById.set(artifactId, stripOuterFence(input.content));
        if (typeof input?.title === "string" && input.title.trim()) {
          kindById.set(artifactId, {
            ...kindById.get(artifactId)!,
            title: input.title.trim(),
          });
        }
      } else {
        const base = contentById.get(artifactId) ?? "";
        const result = applyArtifactUpdate(
          base,
          String(input?.old_str ?? ""),
          String(input?.new_str ?? ""),
        );
        // A non-applying update (base drifted) keeps the prior content —
        // better a stale version than a broken one.
        if (result.ok) contentById.set(artifactId, result.content);
      }
    }
    const kind = kindById.get(artifactId)!;
    return {
      type: "artifact",
      artifactId,
      artifactType: kind.type,
      title: kind.title,
      op,
      content: contentById.get(artifactId) ?? "",
    };
  }
}

/** Replayed text worth showing: non-empty and not a system-injected payload
 *  (\<system-reminder\>, \<command-…\> blocks start with "<"). */
function isVisibleReplayText(t: unknown): t is string {
  return typeof t === "string" && !!t.trim() && !t.trim().startsWith("<");
}

/** The thread's current context footprint, from its persisted messages: the
 *  LAST top-level (non-sidechain) assistant message's usage, summed the same
 *  way the live "usage" stream event is — so a reopened thread's context
 *  meter resumes exactly where the stream left it instead of showing 0.
 *  Subagents run in their own windows (isSidechain) and are skipped. */
export function lastContextTokens(messages: unknown[]): number {
  let tokens = 0;
  for (const msg of messages as any[]) {
    if (msg?.type !== "assistant" || msg?.isSidechain) continue;
    const u = msg.message?.usage;
    if (!u) continue;
    tokens =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.output_tokens ?? 0);
  }
  return tokens;
}
