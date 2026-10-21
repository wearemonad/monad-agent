// Shared contract between the bun main process and the webview.
// The webview never sees raw SDK message types — only these.

import type { GraphBackfillStatus, KnowledgeGraphView } from "./knowledgeGraph";

export type AgentStreamEvent =
  | { kind: "run-started"; runId: string; sessionId: string; model?: string }
  | { kind: "text"; runId: string; text: string }
  | { kind: "thinking"; runId: string; text: string }
  /** Incremental slice of the assistant text/thinking block currently being
   *  streamed. The UI accumulates these into a live tail; the complete
   *  "text"/"thinking" event that follows is authoritative and REPLACES the
   *  accumulated buffer (so a dropped delta can never corrupt the transcript). */
  | { kind: "text-delta"; runId: string; text: string }
  | { kind: "thinking-delta"; runId: string; text: string }
  | {
      kind: "tool-call";
      runId: string;
      toolUseId: string;
      name: string;
      inputSummary: string;
    }
  | {
      kind: "tool-result";
      runId: string;
      toolUseId: string;
      output: string;
      isError: boolean;
    }
  | {
      kind: "artifact";
      runId: string;
      artifactId: string;
      artifactType: ArtifactType;
      title: string;
      op: ArtifactOp;
      /** Full post-op content — the UI never applies diffs itself. */
      content: string;
    }
  | { kind: "email-draft"; runId: string; draft: EmailDraftData }
  /** An image the agent generated. `path` is where the agent's harness left
   *  it (Codex's generated_images folder); the webview loads it via
   *  readChatImage and the user saves a copy only if they want one. */
  | { kind: "image"; runId: string; path: string; name: string }
  /** Token accounting after each top-level assistant API call. contextTokens
   *  is the size of the conversation in the model's context right now (input +
   *  cache + output of the latest call); the UI accumulates them into the
   *  thread's "total processed" figure. Emitted once per API call. */
  | {
      kind: "usage";
      runId: string;
      contextTokens: number;
    }
  | {
      kind: "run-finished";
      runId: string;
      sessionId: string;
      numTurns: number;
      costUsd?: number;
      /** Context-window size of the main-loop model (from the SDK's result
       *  modelUsage); the UI falls back to 200k until a run has finished. */
      contextWindow?: number;
      /** Set when the SDK's result reported the run ended in error (API
       *  connection failure, max turns, …) instead of a real answer. One-shot
       *  runs only: the CLI reports these as a result, not a thrown error, so
       *  background owners (scheduler) can tell a failed run from a finished
       *  one and retry instead of announcing success. */
      error?: string;
      /** The error is the Claude CLI's own login being gone (OAuth refresh
       *  failed) — the chat offers a sign-in instead of a dead-end message. */
      needsLogin?: boolean;
    }
  | {
      kind: "run-error";
      runId: string;
      error: string;
      /** True when the user stopped the run — a deliberate end, not a failure
       *  (the scheduler must not retry an aborted job). */
      aborted?: boolean;
      /** See run-finished.needsLogin. */
      needsLogin?: boolean;
    };

/** Renderable artifact kinds (v1 — React components are a later addition). */
export type ArtifactType = "html" | "svg" | "mermaid" | "markdown";

export type ArtifactOp = "create" | "update" | "rewrite";

/** An email the agent drafted for the inline card (draft_email tool). The
 *  agent only PRESENTS drafts — every Gmail/outbox action is a human click. */
export type EmailDraftData = {
  to: string;
  cc?: string;
  subject: string;
  /** 1–4 alternatives with short labels, e.g. "Brief and clean". */
  variants: { label: string; body: string }[];
};

export type PermissionRequest = {
  requestId: string;
  runId: string;
  toolName: string;
  inputSummary: string;
  input: unknown;
};

/** What produced a thread. Absent = a normal interactive chat. Recorded by the
 *  scheduler in `.monad/session-meta.json` so the UI can badge these threads
 *  and their titles can be composed in code (no tokens spent on titling). */
export type SessionKind = "briefing" | "scheduled" | "meeting-prep";

export type SessionSummary = {
  sessionId: string;
  title: string;
  updatedAt?: string;
  messageCount?: number;
  kind?: SessionKind;
  /** "codex" for OpenAI threads; absent for Claude-runtime threads (Anthropic
   *  and Ollama). A thread can only continue on its own runtime. */
  runtime?: "codex";
  /** Provider + model an OpenAI thread last ran with (Codex threads only) —
   *  what the picker switches back to when the thread is reopened. */
  provider?: OpenAIProviderId;
  model?: string;
};

/** A workspace skill, parsed from .claude/skills/<name>/SKILL.md frontmatter. */
export type SkillInfo = {
  name: string;
  description: string;
  /** Deactivated skills are hidden from the UI and denied to the agent. */
  enabled: boolean;
  /** App-scaffolded skills can be switched off but never deleted. */
  system: boolean;
  /** Frontmatter `disable-model-invocation: true` — the agent never loads or
   *  invokes it on its own; it runs only as a user "/name" command. */
  manualOnly: boolean;
  /** Frontmatter `user-invocable: false` — hidden from the gallery and the
   *  "/" palette (model-triggered only). Settings still lists it. */
  userInvocable: boolean;
};

/** Default Gmail label that routes an email into the brain, used whenever a
 *  workspace hasn't configured its own trigger labels. */
export const GMAIL_INGEST_LABEL = "Monad";

export type DriveInfo = {
  email: string;
  /** Drive folders synced into inbox/. Empty/absent = connected but nothing
   *  selected yet. Legacy single-folder links are migrated into this on load. */
  folders?: DriveFolder[];
  /** Walk subfolders of every selected folder too. Off for links that predate
   *  multi-folder sync, so upgrading never widens what an existing brain pulls. */
  recursive?: boolean;
  /** Stamped once per sync run — all selected folders sync together. */
  lastSync?: string;
  /** Gmail labels that route an email into inbox/ (any match pulls it).
   *  Absent/empty = the default GMAIL_INGEST_LABEL. */
  gmailLabels?: string[];
  /** Set when Google reported the stored grant dead (expired/revoked): the
   *  Keychain token is gone but the link (folders, labels) is kept so a
   *  reconnect restores it. Carries the user-facing reason. */
  needsReconnect?: string;
};

export type ScheduledJob = {
  id: string;
  name: string;
  prompt: string;
  hour: number;
  minute: number;
  /** Days of week, 0=Sunday … 6=Saturday. */
  days: number[];
  enabled: boolean;
  /** Last local day the job was STARTED (attempt guard: keeps a tick from
   *  firing it twice). Cleared when the attempt fails so catch-up retries. */
  lastRunDate?: string; // YYYY-MM-DD
  /** Last local day a run actually finished successfully. */
  lastSuccessDate?: string; // YYYY-MM-DD
  /** Local day the job was added. A job added after its time is stamped
   *  lastRunDate=today so it waits for its next occurrence — this tells that
   *  stamp apart from a real attempt (log status, Settings "next" label). */
  addedDate?: string; // YYYY-MM-DD
};

/** When an enabled job next fires (local time), or null when disabled / no
 *  days. A time at or before `now` means it is due right now (catch-up).
 *  Mirrors the scheduler's isJobDue: right weekday, time reached, and not
 *  already stamped for that day. */
export function nextJobRun(job: ScheduledJob, now: Date): Date | null {
  if (!job.enabled || !job.days.length) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const at = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + offset,
      job.hour,
      job.minute,
    );
    if (!job.days.includes(at.getDay())) continue;
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    if (key === job.lastRunDate) continue;
    return at;
  }
  return null;
}

/** Briefing jobs get their own thread kind (and per-job Settings knobs);
 *  every other job is a plain "scheduled" run. Shared because both the
 *  scheduler (thread stamping) and Settings (knob visibility) need it. */
export function jobKind(job: ScheduledJob): SessionKind {
  return /briefing/i.test(job.name) || /briefing/i.test(job.prompt)
    ? "briefing"
    : "scheduled";
}

/** "New inbox file → extra instruction" rule, folded into the ingest run. */
export type InboxTrigger = {
  id: string;
  /** Case-insensitive filename match: "*.vtt"-style extension or substring. */
  match: string;
  /** Extra instruction for the ingest run when a captured file matches. */
  prompt: string;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  active: boolean;
  drive?: DriveInfo;
  /** Local folder mirrored into inbox/ (zero-OAuth capture path). */
  watchFolder?: string;
  /** Tool names (or prefix patterns ending in *) auto-approved without a dialog. */
  alwaysAllow: string[];
  jobs: ScheduledJob[];
  /** Event triggers: new inbox file → extra ingest instruction. */
  inboxTriggers: InboxTrigger[];
  /** Auto-run a background meeting-prep brief ~1h before calendar events. */
  meetingPrep?: boolean;
  /** The briefing's "🎯 Suggested focus" section. Absent = on; false = the
   *  briefing skips the top-3-recommended-actions section. */
  briefingFocus?: boolean;
  /** Soft monthly API-cost budget (USD); overruns surface as a health issue. */
  budgetUsd?: number;
  /** Skill names the user switched off in Settings → Skills. */
  disabledSkills: string[];
};

/** Aggregated per-run costs (from .monad/costs.jsonl). */
export type CostSummary = {
  thisMonthUsd: number;
  lastMonthUsd: number;
  allTimeUsd: number;
  runsThisMonth: number;
};

/** A full-text hit inside a session's saved conversation. */
export type ContentHit = {
  sessionId: string;
  title: string;
  snippet: string;
};

/** Staleness/coverage stats for the knowledge base. */
export type BrainHealth = {
  totalDocs: number;
  byFolder: { folder: string; count: number }[];
  /** Newest doc mtime — a proxy for "last ingest". */
  lastIngestMs?: number;
  /** Oldest untouched docs, most stale first. */
  stalest: { path: string; mtimeMs: number }[];
};

/** A knowledge doc an ingest run added/updated, awaiting the user's accept/reject. */
export type ReviewItem = {
  /** knowledge/-relative doc path. */
  path: string;
  change: "new" | "updated";
  queuedAt: string; // ISO
  /** An update whose pre-run version was kept: reject restores it instead
   *  of trashing the whole doc. */
  revertible?: boolean;
  /** Entity pages this doc's ingest created/updated. They aren't reviewed on
   *  their own — they follow this doc's accept/reject (titles, for display). */
  linked?: string[];
};

/** One problem found by the proactive health checks (launch + daily). */
export type HealthIssue = {
  workspaceId: string;
  workspaceName: string;
  /** What's broken: a connector name, "google", "drive-sync", "watch-folder". */
  source: string;
  message: string;
};

/** What `claude auth status --json` reports about the user's CLI login
 *  (subscription mode rides that login; API-key mode never looks at it). */
export type ClaudeAuthStatus = {
  loggedIn: boolean;
  email?: string;
  /** "claude.ai" (subscription) or "console" (API billing). */
  method?: string;
  /** Why the status could not be read (CLI missing, bad JSON, timeout). */
  error?: string;
};

export type DriveFolder = { id: string; name: string };

export type InboxFile = { name: string; size: number; mtimeMs: number };

/** Whether a background ingest run is active in the current workspace, and
 *  how the last finished one went (cleared when the next run starts). */
export type IngestStatus = {
  active: boolean;
  files: string[];
  last?: IngestOutcome;
};

/** The result of a finished ingest run. "Finished" alone can't tell the user
 *  anything — a run that couldn't read its file also finishes cleanly — so the
 *  outcome is derived from what's left in inbox/, not the agent's say-so. */
export type IngestOutcome = {
  status: "ok" | "partial" | "failed" | "stopped";
  /** Knowledge docs the run queued for review. */
  reviewCount: number;
  /** Requested files still sitting in inbox/ after the run. */
  leftover: string[];
  /** The agent's closing message (why files were skipped, what it filed). */
  summary?: string;
  /** Run error, when status is "failed" because the run itself errored. */
  error?: string;
};

/** A background run (ingest, scheduled job, meeting prep) occupying the active
 *  workspace's run slot — surfaced in the composer with an abort affordance.
 *  sessionId (absent until the run's session exists, and always for ingest,
 *  which has no thread) lets the sidebar mark the thread being worked on. */
export type BackgroundRunInfo = {
  runId: string;
  label: string;
  sessionId?: string;
};

export type McpServerInfo = {
  name: string;
  kind: "stdio" | "http";
  detail: string;
  /** ${VARS} with no usable value anywhere (Keychain, .env, process env). */
  missingEnv: string[];
  /** Every ${VAR} the config references, with where its value comes from.
   *  "app" = entered in Settings (Keychain, per machine); "env-file" = developer
   *  .env/process override; "missing" = needs a value. */
  envVars: { name: string; source: "app" | "env-file" | "missing" }[];
};

export type OutboxFile = { name: string; size: number; mtimeMs: number };

/** In-app preview of an outbox file. `markdown` renders as text/markdown,
 *  `pdf`/`image` carry base64 in `content`, `binary` has no inline preview
 *  (too large or an unrenderable format) — open it with the default app. */
export type OutboxPreview = {
  kind: "markdown" | "pdf" | "image" | "binary";
  /** UTF-8 text for markdown, base64 for pdf/image, empty for binary. */
  content: string;
  mime?: string;
};

/** A Gmail draft of the workspace's connected account, reviewable in-app. */
export type GmailDraft = {
  id: string;
  to: string;
  cc?: string;
  subject: string;
  snippet: string;
  body: string;
};

export type KnowledgeDoc = { path: string; size: number; mtimeMs: number };

export type DriveEvent = {
  workspaceId: string;
  status:
    | "connecting"
    | "connected"
    | "syncing"
    | "synced"
    | "error"
    | "disconnected";
  detail?: string;
};

/** Providers served by the Claude Agent SDK runtime. Only these can be the
 *  default provider: background work (ingest, scheduled jobs, memory review)
 *  depends on Claude-runtime features — skills, Monad's in-process tools and
 *  per-tool permission gating. */
export type AuthMode = "subscription-cli" | "api-key" | "local-ollama";

/** Providers served by OpenAI's Codex harness: the user's installed, ChatGPT-
 *  signed-in `codex` CLI, or the Codex runtime billed to an OpenAI API key. */
export type OpenAIProviderId = "openai-subscription" | "openai-api-key";

/** A provider is something the user can switch on independently; every
 *  enabled provider contributes its models to the composer's picker. The
 *  default provider is used when a run names no provider (background runs). */
export type ProviderId = AuthMode | OpenAIProviderId;

export const PROVIDER_IDS: ProviderId[] = [
  "subscription-cli",
  "api-key",
  "openai-subscription",
  "openai-api-key",
  "local-ollama",
];

export const AUTH_MODES: AuthMode[] = [
  "subscription-cli",
  "api-key",
  "local-ollama",
];

export function isOpenAIProvider(
  id: ProviderId | null | undefined,
): id is OpenAIProviderId {
  return id === "openai-subscription" || id === "openai-api-key";
}

/** Per-message model controls from the composer (reasoning, context, speed).
 *  Each runtime honours what it supports and ignores the rest. */
export type RunOptions = {
  /** Reasoning level. Claude: low | medium | high | xhigh | max | ultracode |
   *  ultrathink. OpenAI: low | medium | high | xhigh | max | ultra. */
  effort?: string;
  /** Claude only: "200k" caps the context window (1M is the default). */
  context?: "200k" | "1m";
  /** Claude fast mode / OpenAI's fast service tier. */
  speed?: "standard" | "fast";
};

/** Is the Codex CLI signed in (ChatGPT or API key), per `codex login status`? */
export type CodexAuthStatus = {
  loggedIn: boolean;
  /** "ChatGPT" or "API key" when signed in. */
  method?: string;
  /** Set when the CLI couldn't be found or run. */
  error?: string;
};

/** Will this model fit in the Mac's unified memory? */
export type LocalModelFit = "good" | "tight" | "too-big";

/** A model installed in the local Ollama library. */
export type LocalModel = {
  /** Ollama tag, e.g. "qwen3.5:35b" — passed as the run's model id. */
  id: string;
  sizeGb: number;
  /** e.g. "35B" when Ollama reports it. */
  paramSize?: string;
  fit: LocalModelFit;
  fitHint: string;
};

/** A curated model the user can download from the Settings panel. */
export type RecommendedModel = {
  id: string;
  label: string;
  blurb: string;
  downloadGb: number;
  minRamGb: number;
  installed: boolean;
  fit: LocalModelFit;
  fitHint: string;
};

export type OllamaStatus = {
  installed: boolean;
  running: boolean;
  totalRamGb: number;
  /** Installed models (empty unless running). */
  models: LocalModel[];
  recommended: RecommendedModel[];
};

export type SettingsView = {
  appVersion: string;
  channel: string;
  updatesConfigured: boolean;
  /** Runtime versions shown in the About dialog. */
  bunVersion: string;
  electrobunVersion: string;
  osVersion: string;
  /** Provider used for runs that name none (background jobs, ingest). */
  authMode: AuthMode;
  /** Providers switched on in Settings → Providers (always ⊇ {authMode}). */
  enabledProviders: ProviderId[];
  hasApiKey: boolean;
  claudeBinaryPath: string; // override, or "" when auto-detected
  resolvedClaudePath: string; // what auto-detection found, or ""
  hasOpenAIApiKey: boolean;
  codexBinaryPath: string; // override, or "" when auto-detected
  resolvedCodexPath: string; // what auto-detection found, or ""
  /** Default Ollama model for local-mode runs ("" = none chosen yet). */
  localModel: string;
  googleClientId: string;
  hasGoogleClientSecret: boolean;
  /** App ships a built-in Google client — users just click Connect. */
  googleClientBuiltIn: boolean;
};

// Rendered message model — used for both live chat and loaded history.
export type ChatItem =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  /** Extended-thinking block — collapsed into the activity accordion in the UI. */
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      toolUseId: string;
      name: string;
      inputSummary: string;
      output?: string;
      isError?: boolean;
      pending: boolean;
    }
  | { type: "error"; text: string }
  | { type: "info"; text: string }
  /** The Claude CLI's login expired mid-run — rendered as a sign-in card
   *  (browser + paste-code flow) so the user can recover without a terminal. */
  | { type: "login-needed"; text: string }
  | {
      type: "artifact";
      artifactId: string;
      artifactType: ArtifactType;
      title: string;
      op: ArtifactOp;
      /** Full content as of this op (lets history replay rebuild the version list). */
      content: string;
    }
  | { type: "email-draft"; draft: EmailDraftData }
  | { type: "image"; path: string; name: string };

/** console.* level forwarded from the webview to the bun process. */
export type WebviewLogLevel = "log" | "info" | "warn" | "error" | "debug";

export type MonadRPC = {
  bun: {
    requests: {
      startRun: {
        params: {
          prompt: string;
          /** Client-generated run id: the webview mints it BEFORE the request
           *  so stream events (which can arrive before this response resolves)
           *  can be routed to the thread that started the run. */
          runId?: string;
          resumeSessionId?: string;
          model?: string;
          /** Provider the picked model belongs to; omit for the default one. */
          provider?: ProviderId;
          runOptions?: RunOptions;
        };
        response: { runId: string } | { error: string };
      };
      abortRun: { params: { runId: string }; response: { ok: boolean } };
      /** Pre-warm: boot the active workspace's agent session before the user
       *  sends, so the first message pays API latency only. resumeSessionId
       *  primes a reopened thread; omit it for a fresh one. Best-effort — the
       *  response is always ok, failures just mean no warm start. */
      prewarm: {
        params: {
          resumeSessionId?: string;
          model?: string;
          provider?: ProviderId;
          runOptions?: RunOptions;
        };
        response: { ok: boolean };
      };
      respondPermission: {
        // always=true (with allow) also adds the tool to the workspace's alwaysAllow list
        params: { requestId: string; allow: boolean; always?: boolean };
        response: { ok: boolean };
      };
      listSessions: { params: {}; response: { sessions: SessionSummary[] } };
      listAllSessions: {
        params: {};
        response: { byWorkspace: Record<string, SessionSummary[]> };
      };
      getSessionHistory: {
        params: { sessionId: string };
        response: {
          items: ChatItem[];
          /** The thread's last context footprint (from its persisted usage),
           *  so the context meter resumes instead of resetting to 0. */
          contextTokens?: number;
        };
      };
      /** Set a custom title on a persisted session (SDK renameSession). */
      renameSession: {
        params: { sessionId: string; title: string };
        response: { ok: boolean };
      };
      /** Delete a persisted session file (SDK deleteSession). */
      deleteSession: {
        params: { sessionId: string };
        response: { ok: boolean };
      };

      /** Skills available in the active workspace (for discoverability UI). */
      listSkills: { params: {}; response: { skills: SkillInfo[] } };
      /** Switch a skill on/off for a workspace (hidden from UI + denied to the agent). */
      setSkillEnabled: {
        params: { workspaceId: string; skill: string; enabled: boolean };
        response: { ok: boolean };
      };
      /** Delete a user-imported skill — its folder moves to the macOS Trash.
       *  App-scaffolded (system) skills are refused. */
      deleteSkill: {
        params: { workspaceId: string; skill: string };
        response: { ok: boolean; error?: string };
      };
      /** Reveal a skill's SKILL.md in the Finder — the edit path: skills are
       *  plain files, edited in any editor (or by the agent), never in-app. */
      revealSkill: {
        params: { workspaceId: string; skill: string };
        response: { ok: boolean };
      };

      /** Save arbitrary text (e.g. a chat message) into the knowledge base as a note. */
      rememberText: {
        params: { text: string; title?: string };
        response: { path?: string; error?: string };
      };

      listWorkspaces: { params: {}; response: { workspaces: WorkspaceInfo[] } };
      setActiveWorkspace: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      addWorkspace: {
        // path from a prior pickFolder; create a new folder when `create` is set
        // (templateId picks a brain template from the gallery; default "generic")
        params: {
          path?: string;
          create?: { parentDir: string; name: string; templateId?: string };
        };
        response: { workspace?: WorkspaceInfo; error?: string };
      };
      removeWorkspace: { params: { id: string }; response: { ok: boolean } };
      /** Unregister AND move the workspace folder to the system Trash.
       *  `confirmName` must equal the workspace's name — the handler re-checks
       *  it, so a mis-wired caller cannot delete by id alone. Recoverable by
       *  design: Trash, never an unlink. */
      deleteWorkspace: {
        params: { id: string; confirmName: string };
        response: { ok: boolean; error?: string };
      };
      renameWorkspace: {
        params: { id: string; name: string };
        response: { ok: boolean };
      };
      pickFolder: {
        // opens the native chooser; resolves with the picked path (or none on cancel)
        params: { startingFolder?: string };
        response: { path?: string };
      };
      /** Native file chooser (single file), e.g. a skill-pack or brain zip. */
      pickFile: { params: {}; response: { path?: string } };

      /** Zip the workspace's .claude/skills into destDir (skill-pack export). */
      exportSkills: {
        params: { workspaceId: string; destDir: string };
        response: { path?: string; error?: string };
      };
      /** Import skills from a zip, a folder, or a git URL; existing names are skipped. */
      importSkills: {
        params: { workspaceId: string; source: string };
        response: { added: string[]; skipped: string[]; error?: string };
      };
      /** Zip the whole brain minus secrets (.env), state (.monad) and originals. */
      exportWorkspace: {
        params: { workspaceId: string; destDir: string };
        response: { path?: string; error?: string };
      };
      /** Unzip an exported brain and register it; amber env rows flag needed keys. */
      importWorkspace: {
        params: { zipPath: string; parentDir: string; name: string };
        response: { workspace?: WorkspaceInfo; error?: string };
      };

      /** Last proactive health-check results (cached; checks run on launch + daily). */
      listHealth: { params: {}; response: { issues: HealthIssue[] } };
      /** Re-run the health checks now. */
      runHealthCheck: { params: {}; response: { issues: HealthIssue[] } };

      /** Reveal the workspace's append-only activity log in Finder. */
      revealActivity: {
        params: { workspaceId: string };
        response: { ok: boolean };
      };

      /** recheck=true re-probes what's cached in memory (the Claude CLI path)
       *  before answering — that's what the Providers refresh button sends. */
      getSettings: { params: { recheck?: boolean }; response: SettingsView };
      updateSettings: {
        params: {
          authMode?: AuthMode;
          enabledProviders?: ProviderId[];
          claudeBinaryPath?: string | null;
          codexBinaryPath?: string | null;
          localModel?: string | null;
          googleClientId?: string | null;
          apiKey?: string; // write-only
          openaiApiKey?: string; // write-only
          googleClientSecret?: string; // write-only
        };
        response: SettingsView;
      };
      /** Readiness of one provider (defaults to the app's default provider). */
      testAuth: {
        params: { provider?: ProviderId };
        response: { ok: boolean; message: string };
      };
      /** Is the Claude Code CLI signed in, and as whom? */
      claudeAuthStatus: { params: {}; response: ClaudeAuthStatus };
      /** Begin `claude auth login`: opens the browser sign-in page and
       *  returns its URL (for a "copy link" fallback). The CLI then waits
       *  for the code the page shows, sent via claudeLoginSubmitCode. */
      claudeLoginStart: {
        params: {};
        response: { ok: boolean; url?: string; error?: string };
      };
      /** Hand the pasted authorization code to the waiting CLI and wait for
       *  it to finish; on success warm sessions are dropped so the next
       *  message runs with the fresh credentials. */
      claudeLoginSubmitCode: {
        params: { code: string };
        response: { ok: boolean; email?: string; error?: string };
      };
      /** Abandon an in-progress sign-in (kills the waiting CLI). */
      claudeLoginCancel: { params: {}; response: { ok: boolean } };
      /** Is the Codex CLI signed in, and how? */
      codexAuthStatus: { params: {}; response: CodexAuthStatus };
      /** Run `codex login`: the CLI opens the ChatGPT sign-in page itself and
       *  finishes on its own localhost callback. Resolves once it exits. */
      codexLogin: {
        params: {};
        response: { ok: boolean; status: CodexAuthStatus; error?: string };
      };

      /** Local model (Ollama) state: install/running, installed models with
       *  RAM-fit verdicts, and the curated download list. */
      ollamaStatus: { params: {}; response: OllamaStatus };
      /** Launch the Ollama server and wait until it answers. */
      ollamaStart: { params: {}; response: { ok: boolean; error?: string } };
      /** Download a model; progress streams via the ollamaPullProgress message. */
      ollamaPull: {
        params: { model: string };
        response: { started: boolean; error?: string };
      };
      /** Open an https:// URL in the default browser (e.g. the Ollama download page). */
      openUrl: { params: { url: string }; response: { ok: boolean } };
      updateCheck: {
        params: {};
        response: { version: string; updateAvailable: boolean; error: string };
      };
      /** Download the available update; progress streams via updateStatus. */
      updateDownload: { params: {}; response: { started: boolean } };
      /** Install the downloaded update and relaunch the app. */
      updateInstall: { params: {}; response: { started: boolean } };
      /** Reveal ~/Library/Logs/Monad (the app log) in Finder. */
      revealLogs: { params: {}; response: { ok: boolean } };
      /** Zip logs + scheduler state + recent workspace activity onto the
       *  Desktop and reveal it in Finder. */
      exportDiagnostics: {
        params: {};
        response: { ok: boolean; path?: string; error?: string };
      };

      driveConnect: {
        params: { workspaceId: string };
        response: { started: boolean };
      };
      driveDisconnect: {
        params: { workspaceId: string };
        response: { ok: boolean };
      };
      driveListFolders: {
        params: { workspaceId: string };
        response: { folders: DriveFolder[]; error?: string };
      };
      driveSetFolders: {
        params: {
          workspaceId: string;
          folders: DriveFolder[];
          recursive: boolean;
        };
        response: { ok: boolean };
      };
      driveSetGmailLabels: {
        params: { workspaceId: string; labels: string[] };
        response: { ok: boolean };
      };
      gmailListLabels: {
        params: { workspaceId: string };
        response: { labels: string[]; error?: string };
      };
      driveSync: {
        params: { workspaceId: string };
        response: { started: boolean };
      };

      ingestFiles: {
        params: { files: { name: string; base64: string }[] };
        /** queued: an ingest was already running — the files are saved to
         *  inbox/ and chain into a follow-up run when it finishes. */
        response: {
          copied: string[];
          runId?: string;
          queued?: boolean;
          error?: string;
        };
      };
      listInbox: { params: {}; response: { files: InboxFile[] } };
      /** Is a background ingest run active in the current workspace? */
      ingestStatus: { params: {}; response: IngestStatus };
      /** Stop the active workspace's ingest run (deliberate abort, not an
       *  error — partial writes still land in the review queue). */
      stopIngest: { params: {}; response: { ok: boolean } };
      /** Any background run (ingest/scheduled/prep) in the active workspace. */
      backgroundStatus: {
        params: {};
        response: { run: BackgroundRunInfo | null };
      };
      ingestInbox: {
        params: {};
        response: { runId?: string; queued?: boolean; error?: string };
      };
      revealInbox: { params: {}; response: { ok: boolean } };
      /** Remove one inbox file (moved to the macOS Trash, recoverable). */
      deleteInboxFile: {
        params: { name: string };
        response: { ok: boolean; error?: string };
      };
      /** Remove ALL inbox files (each moved to the macOS Trash, recoverable). */
      clearInbox: {
        params: {};
        response: { removed: number; error?: string };
      };

      /** Fetch a web page, save a readable extract to inbox/, start an ingest run. */
      ingestUrl: {
        params: { url: string };
        response: {
          saved?: string;
          runId?: string;
          queued?: boolean;
          error?: string;
        };
      };

      /** Set (or clear, with no path) the workspace's watched local folder. */
      setWatchFolder: {
        params: { workspaceId: string; path?: string };
        response: { ok: boolean; error?: string };
      };

      /** Knowledge docs recent ingest runs added/updated, awaiting review. */
      listReview: { params: {}; response: { items: ReviewItem[] } };
      /** Accept keeps the doc and clears the entry; reject moves it to the Trash
       *  (same machinery as "forget") and drops its INDEX line. */
      resolveReview: {
        params: { path: string; action: "accept" | "reject" };
        response: { ok: boolean; error?: string };
      };

      /** Create a real Gmail draft from the inline email card (human click).
       *  Falls back to an outbox/ file when no Google account is connected. */
      emailCreateDraft: {
        params: { to: string; cc?: string; subject: string; body: string };
        response: { draftId?: string; outboxFile?: string; error?: string };
      };

      /** Reveal an artifact file (workspace artifacts/ folder) in Finder. */
      revealArtifact: { params: { id: string }; response: { ok: boolean } };
      /** Open an artifact file with the default app (browser for .html). */
      openArtifact: { params: { id: string }; response: { ok: boolean } };

      listOutbox: { params: {}; response: { files: OutboxFile[] } };
      readOutbox: { params: { name: string }; response: OutboxPreview };
      archiveOutbox: { params: { name: string }; response: { ok: boolean } };
      revealOutbox: { params: {}; response: { ok: boolean } };
      /** Open an outbox file with the default app (Preview for .pdf, …). */
      openOutbox: { params: { name: string }; response: { ok: boolean } };

      /** Gmail drafts of the connected account — review and send without leaving the app. */
      gmailListDrafts: {
        params: { workspaceId: string };
        response: { drafts: GmailDraft[]; error?: string };
      };
      gmailSendDraft: {
        params: { workspaceId: string; draftId: string };
        response: { ok: boolean; error?: string };
      };
      gmailDeleteDraft: {
        params: { workspaceId: string; draftId: string };
        response: { ok: boolean; error?: string };
      };

      /** Renderer-reported window focus — gates "quiet when focused"
       *  notifications (a user watching the app doesn't need a banner). */
      setAppFocused: {
        params: { focused: boolean };
        response: { ok: boolean };
      };

      /** Full-text search inside saved conversations (⌘K upgrade). */
      searchSessions: {
        params: { query: string };
        response: { hits: ContentHit[] };
      };

      /** Aggregated run costs for a workspace. */
      costSummary: { params: { workspaceId: string }; response: CostSummary };
      /** Soft monthly budget; omit budgetUsd to clear. */
      setBudget: {
        params: { workspaceId: string; budgetUsd?: number };
        response: { ok: boolean };
      };

      /** Knowledge staleness/coverage stats for the active workspace. */
      brainHealth: { params: {}; response: BrainHealth };
      /** Overwrite a knowledge doc (in-app editing); ensures an INDEX line exists. */
      writeKnowledge: {
        params: { path: string; content: string };
        response: { ok: boolean; error?: string };
      };

      /** Save a pasted image/file as transient chat context (not ingest).
       *  Returns the absolute path for the agent to Read. */
      saveChatAttachment: {
        params: { name: string; base64: string };
        response: { path?: string; error?: string };
      };
      /** A generated image shown in the chat, as a data URL. Only files in
       *  Codex's generated_images folder are served. */
      readChatImage: {
        params: { path: string };
        response: { dataUrl?: string; error?: string };
      };
      /** Open a generated image with the default app (Preview). */
      openChatImage: { params: { path: string }; response: { ok: boolean } };
      /** Save a copy of a generated image into a folder the user picks
       *  (revealed in Finder afterwards). Cancel → no savedPath. */
      saveChatImage: {
        params: { path: string };
        response: { savedPath?: string; error?: string };
      };
      /** Native file chooser for the composer's + button (the webview has
       *  no file-input support). Any file type; picked files are copied into
       *  the workspace's attachments like pasted ones, at most `max` taken.
       *  dataUrl is a preview thumbnail, set for images only. */
      pickChatFiles: {
        params: { max: number };
        response: {
          files: { name: string; path: string; dataUrl?: string }[];
          /** Why some picks were dropped (over the limit, too large…). */
          error?: string;
        };
      };

      addInboxTrigger: {
        params: { workspaceId: string; match: string; prompt: string };
        response: { ok: boolean; error?: string };
      };
      removeInboxTrigger: {
        params: { workspaceId: string; triggerId: string };
        response: { ok: boolean };
      };
      setMeetingPrep: {
        params: { workspaceId: string; enabled: boolean };
        response: { ok: boolean };
      };
      /** Toggle the briefing's "🎯 Suggested focus" section. */
      setBriefingFocus: {
        params: { workspaceId: string; enabled: boolean };
        response: { ok: boolean };
      };

      listKnowledge: {
        params: {};
        response: { docs: KnowledgeDoc[]; index: string };
      };
      /** workspaceId: read from that workspace instead of the active one. */
      readKnowledge: {
        params: { path: string; workspaceId?: string };
        response: { content: string };
      };
      forgetKnowledge: {
        params: { path: string };
        response: { ok: boolean; error?: string };
      };
      revealKnowledge: {
        params: { path: string; workspaceId?: string };
        response: { ok: boolean };
      };
      /** One workspace's knowledge graph (synced first). Always scoped to the
       *  named workspace — each has its own index, nothing is shared. */
      knowledgeGraph: {
        params: { workspaceId: string; includeDocs: boolean };
        response: KnowledgeGraphView & { backfill: GraphBackfillStatus };
      };
      /** Start (or re-run) the one-off pass that links existing knowledge
       *  into the graph. Its changes land in the review queue. */
      graphBackfillStart: {
        params: { workspaceId: string };
        response: { ok: boolean; error?: string };
      };

      mcpList: {
        params: { workspaceId: string };
        response: { servers: McpServerInfo[] };
      };
      mcpAdd: {
        params: {
          workspaceId: string;
          server: {
            name: string;
            kind: "stdio" | "http";
            command?: string;
            url?: string;
            envLines?: string;
            bearerEnvVar?: string;
          };
        };
        response: { ok: boolean; error?: string };
      };
      mcpRemove: {
        params: { workspaceId: string; name: string };
        response: { ok: boolean };
      };
      mcpTest: {
        params: { workspaceId: string; name: string };
        response: { ok: boolean; message: string };
      };
      /** Store a credential value for this workspace in the macOS Keychain (write-only). */
      wsEnvSet: {
        params: { workspaceId: string; name: string; value: string };
        response: { ok: boolean; error?: string };
      };
      wsEnvClear: {
        params: { workspaceId: string; name: string };
        response: { ok: boolean };
      };

      setAlwaysAllow: {
        params: { workspaceId: string; alwaysAllow: string[] };
        response: { ok: boolean };
      };

      addJob: {
        params: {
          workspaceId: string;
          job: Omit<ScheduledJob, "id" | "lastRunDate">;
        };
        response: { ok: boolean };
      };
      removeJob: {
        params: { workspaceId: string; jobId: string };
        response: { ok: boolean };
      };
      toggleJob: {
        params: { workspaceId: string; jobId: string };
        response: { ok: boolean };
      };
    };
    messages: {
      /** Webview console.* / errors, forwarded so frontend logs reach the
       *  terminal — Electrobun has no working inspector for the native
       *  WKWebView (no isInspectable; the docked one crashes on close). */
      webviewLog: { level: WebviewLogLevel; text: string };
    };
  };
  webview: {
    requests: {};
    messages: {
      streamEvent: AgentStreamEvent;
      permissionRequest: PermissionRequest;
      workspaceChanged: { id: string };
      workspacesUpdated: { workspaces: WorkspaceInfo[] };
      driveEvent: DriveEvent;
      updateStatus: { status: string; message: string; progress?: number };
      /** Open the full-screen settings page (native menu Settings… / ⌘,). */
      openSettings: { section?: string };
      /** Open the in-app About dialog (native menu About Monad). */
      showAbout: {};
      /** Start a fresh thread (native menu File → New Thread / ⌘N). */
      newThread: {};
      /** View → Actual Size / Zoom In / Zoom Out (⌘0 / ⌘+ / ⌘−). */
      zoomCommand: { direction: "in" | "out" | "reset" };
      inboxChanged: { files: InboxFile[] };
      /** A background ingest run started or finished in the active workspace. */
      ingestChanged: IngestStatus;
      /** A background run (any kind) started or finished in the active workspace. */
      backgroundChanged: { run: BackgroundRunInfo | null };
      outboxChanged: { files: OutboxFile[] };
      /** The ingest review queue changed (a run finished, or an item was resolved). */
      reviewChanged: { items: ReviewItem[] };
      /** Proactive health checks finished (launch + daily + manual). */
      healthChanged: { issues: HealthIssue[] };
      /** The Claude CLI login changed (a sign-in finished, or a status
       *  check found it gone) — sign-in cards and Settings refresh. */
      claudeAuthChanged: ClaudeAuthStatus;
      /** An in-app sign-in finished on its own — the CLI's browser tab
       *  completed through its local callback, no code needed. */
      claudeLoginFinished: { ok: boolean; email?: string; error?: string };
      /** A background (scheduled) run finished — refresh the sessions list. */
      sessionsChanged: {};
      /** Streaming progress for an ollamaPull download. */
      ollamaPullProgress: {
        model: string;
        status: string;
        percent?: number;
        done?: boolean;
        error?: string;
      };
    };
  };
};
