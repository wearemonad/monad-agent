import { deleteSession, tagSession } from "@anthropic-ai/claude-agent-sdk";
import type {
  EffortLevel,
  McpServerConfig,
  SDKUserMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type {
  AgentStreamEvent,
  ArtifactOp,
  AuthMode,
  RunOptions,
} from "../../shared/ipc";
import type { AuthStrategy } from "../auth/AuthStrategy";
import { isClaudeLoginError } from "../../shared/authErrors";
import type { PermissionBroker } from "./PermissionBroker";
import { summarize } from "./PermissionBroker";
import { loadWorkspaceEnv } from "./envFile";
import { monadTag, ULTRATHINK_SUFFIX } from "./SessionStore";
import { sessionFilePath } from "./sessionFiles";
import { forgetSessionOwner, recordSessionOwner } from "./sessionMeta";
import { artifactOpFromToolName } from "../../shared/artifacts";
import { readArtifact } from "./artifactTools";
import { DRAFT_EMAIL_TOOL, parseEmailDraftInput } from "../../shared/email";
import type { EmailDraftData } from "../../shared/ipc";
import {
  backgroundPolicyHint,
  fileToolPathsInsideWorkspace,
  isIngestGovernedTool,
} from "./ingestPolicy";
import { MEMORY_WRITE_TOOL } from "../../shared/memory";
import { Effect, ManagedRuntime } from "effect";
import { type AgentSession, AgentSessions } from "./AgentSession";
import {
  BACKGROUND_STALL_MS,
  BackgroundRuns,
  type RunOutcome,
} from "./BackgroundRuns";
import {
  type LiveQuery,
  type LiveQueryFactory,
  type QueryFactory,
  sdkLiveQuery,
  sdkQuery,
} from "./sdkQuery";

/** Tools a scheduled (background) run may use without a permission dialog, even
 *  when not in the workspace's always-allow list. Interactive runs still prompt
 *  for these — the exemption is only for headless jobs the user configured.
 *  Gmail drafts qualify because they are never sent (a human reviews/sends) —
 *  scheduled jobs such as CRM status draft follow-ups this way. Skill qualifies
 *  because loading a skill only reads workspace-owned instructions — without
 *  it a scheduled "run the morning-briefing skill" job can't load the very
 *  skill it exists to run (the disabled-skill gate still runs first). */
const BACKGROUND_SAFE_TOOLS = new Set([
  "mcp__google__gmail_create_draft",
  "Skill",
]);

/** Tools that must ALWAYS go through the permission dialog, even when the
 *  workspace granted them always-allow: creating a calendar event can invite
 *  arbitrary external attendees (Google emails them — an outbound-communication
 *  side effect), so a human confirms every call. Background runs, which cannot
 *  show a dialog, are denied outright. */
const ALWAYS_PROMPT_TOOLS = new Set(["mcp__google__calendar_create_event"]);

/** Warm processes are cheap but not free — cap how many stay idle. The cap is
 *  soft for sessions mid-turn: parallel threads all keep streaming; only idle
 *  ones are evicted to make room. */
const MAX_LIVE_SESSIONS = 3;
export { BACKGROUND_STALL_MS };
/** Matches isTransientError ("timed out"), so the scheduler retries a stalled
 *  job quietly instead of reporting it as failed. */
export const STALL_ERROR = `Background run timed out — no activity for ${BACKGROUND_STALL_MS / 60_000} minutes.`;

/** True when session-JSONL content holds at least one real message. The CLI
 *  writes conversation lines as {"type":"user"|"assistant",...} — a file
 *  without any is pure metadata (ai-title, tag, mode…): the fork a resumed
 *  session leaves at boot, or a run killed before its first write. A content
 *  string merely CONTAINING these markers can only belong to a real message,
 *  so false positives are impossible in the direction that matters (we never
 *  delete a file that has them). Exported for tests. */
export function jsonlHasMessages(jsonl: string): boolean {
  return (
    jsonl.includes('"type":"user"') || jsonl.includes('"type":"assistant"')
  );
}

/** The skill a Skill-tool call is about, or "" when the call isn't one. The
 *  SDK has moved the parameter name around (`skill`, `command`, `name`), so
 *  read whichever string is present rather than pinning one spelling. */
export function skillNameOf(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName !== "Skill") return "";
  for (const key of ["skill", "command", "name"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      // Plugin skills arrive as "plugin:skill"; the workspace stores the bare name.
      return value.trim().split(":").pop()!.replace(/^\//, "");
    }
  }
  return "";
}

/** Permission decision for a background (headless) run. Ordering is the
 *  security boundary: the path-scoped policies run FIRST, because the
 *  workspace's always-allow list matches tool names only and must never
 *  override a path check — "Read is always allowed" has to mean "read this
 *  workspace", not "read any file on the machine". When an ingest policy is
 *  present, its verdict on the tools it governs (file tools + Bash) is final:
 *  a rejection there cannot be resurrected by a name-only grant. */
export function backgroundToolDecision(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
  isAlwaysAllowed: (toolName: string) => boolean,
  safeTools?: (toolName: string, input: Record<string, unknown>) => boolean,
): "background-safe" | "auto-allowed" | "deny" {
  if (ALWAYS_PROMPT_TOOLS.has(toolName)) return "deny"; // needs a human; none available
  if (safeTools) {
    if (safeTools(toolName, input)) return "background-safe";
    if (isIngestGovernedTool(toolName)) return "deny";
  }
  // Working memory is injected into every future system prompt; background
  // runs read untrusted content (inbox files, emails). A prompt-injected
  // memory write would persist across sessions — so headless runs may never
  // write memory unless their own safeTools list said so above.
  if (toolName === MEMORY_WRITE_TOOL) return "deny";
  if (BACKGROUND_SAFE_TOOLS.has(toolName)) return "background-safe";
  if (
    isAlwaysAllowed(toolName) &&
    fileToolPathsInsideWorkspace(toolName, input, workspacePath)
  ) {
    return "auto-allowed";
  }
  return "deny";
}

/** Whether an existing live session can serve the next interactive message.
 *  A session that has run a turn serves only its own thread; a prewarmed one
 *  serves the thread it was primed for ("" = a fresh thread). The model is
 *  deliberately NOT part of this decision — a mismatch is fixed in place with
 *  setModel(), so a prewarmed default-model session still serves a user whose
 *  picker says "sonnet". Provider changes need a new process (different env /
 *  executable), so auth identity must match. Exported for tests. */
export function canReuseLiveSession(
  s: {
    turnRunId: string | null;
    authId: string;
    sessionId: string;
    resumeOf: string;
  },
  next: { authId: string; resumeSessionId?: string },
): boolean {
  if (s.turnRunId !== null) return false;
  if (s.authId !== next.authId) return false;
  return (s.sessionId || s.resumeOf) === (next.resumeSessionId ?? "");
}

/** How the composer's run options map onto the Claude runtime. Effort,
 *  fast mode, ultracode and the 200k context cap are flag settings
 *  (switchable on a warm process between turns — 200k is an auto-compact
 *  window, so the conversation is compacted before it outgrows it);
 *  ultrathink is the CLI's per-turn prompt keyword. Exported for tests. */
export function claudeRunConfig(o: RunOptions | undefined): {
  effort?: EffortLevel;
  fastMode: boolean;
  ultracode: boolean;
  ultrathink: boolean;
  contextKey: "200k" | "1m";
} {
  const levels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
  const effort =
    o?.effort === "ultracode"
      ? "xhigh" // ultracode = xhigh effort + workflow orchestration
      : o?.effort === "ultrathink"
        ? "high" // plus the per-turn keyword
        : levels.find((l) => l === o?.effort);
  return {
    ...(effort ? { effort } : {}),
    fastMode: o?.speed === "fast",
    ultracode: o?.effort === "ultracode",
    ultrathink: o?.effort === "ultrathink",
    contextKey: o?.context === "200k" ? "200k" : "1m",
  };
}

/** Flag settings for a run config — the session-scoped layer the SDK takes
 *  at spawn (options.settings) and mid-session (applyFlagSettings). */
function flagSettings(cfg: ReturnType<typeof claudeRunConfig>) {
  return {
    ...(cfg.fastMode ? { fastMode: true } : {}),
    ...(cfg.ultracode ? { ultracode: true, enableWorkflows: true } : {}),
    ...(cfg.contextKey === "200k" ? { autoCompactWindow: CONTEXT_200K } : {}),
  };
}

const CONTEXT_200K = 200_000;

function flagsKey(cfg: ReturnType<typeof claudeRunConfig>): string {
  return `${cfg.effort ?? ""}|${cfg.fastMode}|${cfg.ultracode}|${cfg.contextKey}`;
}

/** One warm, streaming-input CLI process bound to a workspace thread. The
 *  process (and its MCP handshakes and session state) survives between
 *  messages, so follow-up turns skip the multi-second cold start that
 *  dominated perceived generation time. */
type LiveSession = {
  key: string; // unique per session — several may share a workspace (parallel threads)
  workspaceId: string;
  workspacePath: string;
  authId: string;
  /** Model the session currently generates with ("" = provider default). */
  model: string;
  /** Effort / fast / ultracode / context currently applied (see flagsKey). */
  flagsKey: string;
  /** Session id this process was primed to resume ("" = fresh thread). */
  resumeOf: string;
  /** SDK session id, known after init. */
  sessionId: string;
  /** Model display name from init, echoed on warm run-started events. */
  modelName?: string;
  query: LiveQuery | null;
  /** The process, its input and its timers (idle expiry, Stop fallback). */
  session: AgentSession;
  /** Turn in flight (null = idle). Also the runId content events map to. */
  turnRunId: string | null;
  lastRunId: string;
  /** Every runId this session served — for buffer/pending cleanup on death. */
  runIds: Set<string>;
  /** Current turn was stopped by the user; its late messages are swallowed. */
  abortedTurn: boolean;
  tagged: boolean;
  initSeen: boolean;
  // Timing (activity-log instrumentation)
  spawnAt: number;
  initAt: number;
  turnStartedAt: number;
  firstOutputAt: number | null;
  /** This turn paid the process boot (false for warm/prewarmed turns). */
  turnCold: boolean;
  // Cumulative totals from prior results — streaming-input results carry the
  // session running total, so per-turn numbers are deltas against these.
  costUsdTotal: number;
  numTurnsTotal: number;
};

/** Options an interactive run/prewarm needs to build its query plumbing. */
type InteractiveOpts = {
  workspaceId: string;
  workspacePath: string;
  resumeSessionId?: string;
  model?: string;
  /** Composer reasoning / context / speed picks (see claudeRunConfig). */
  runOptions?: RunOptions;
};

export class AgentService {
  /** Which provider each in-flight run uses — a "Failed to authenticate"
   *  from the subscription CLI means "sign in again", the same text from an
   *  API key does not. */
  private runAuth = new Map<string, AuthMode>();
  /** Warm interactive sessions, keyed by a per-session uuid. A workspace may
   *  hold several at once — one per thread the user is working in parallel. */
  private live = new Map<string, LiveSession>();
  /** Artifact tool calls awaiting their result, keyed by toolUseId. On success
   *  the artifact stream event is emitted instead of the generic tool pair;
   *  on error the generic pair is emitted so the failure stays visible. */
  private pendingArtifacts = new Map<
    string,
    {
      runId: string;
      op: ArtifactOp;
      artifactId: string;
      name: string;
      inputSummary: string;
    }
  >();
  /** Same held-back pattern for draft_email → the inline email card. */
  private pendingEmails = new Map<
    string,
    { runId: string; draft: EmailDraftData; name: string; inputSummary: string }
  >();
  /** One API turn streams several assistant messages sharing a message.id,
   *  each carrying the same usage totals — remember the last id per run so a
   *  "usage" event fires once per API call, not once per content block. */
  private lastUsageMsgId = new Map<string, string>();
  /** Per-run buffers coalescing stream deltas: the API emits deltas every few
   *  tokens, and forwarding each one over the webview RPC (plus a React
   *  render) would be ~100 messages/s. Flushed on a short timer, and always
   *  before the block's complete event so ordering is preserved. */
  private deltaBuffers = new Map<
    string,
    {
      text: string;
      thinking: string;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  /** Accumulate one streamed delta; schedule a flush. */
  private queueDelta(
    runId: string,
    kind: "text" | "thinking",
    text: string,
  ): void {
    let buf = this.deltaBuffers.get(runId);
    if (!buf) {
      buf = { text: "", thinking: "", timer: null };
      this.deltaBuffers.set(runId, buf);
    }
    buf[kind === "text" ? "text" : "thinking"] += text;
    buf.timer ??= setTimeout(() => this.flushDeltas(runId), 60);
  }

  private flushDeltas(runId: string): void {
    const buf = this.deltaBuffers.get(runId);
    if (!buf) return;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = null;
    if (buf.thinking)
      this.emit({ kind: "thinking-delta", runId, text: buf.thinking });
    if (buf.text) this.emit({ kind: "text-delta", runId, text: buf.text });
    buf.text = "";
    buf.thinking = "";
  }

  private dropDeltas(runId: string): void {
    const buf = this.deltaBuffers.get(runId);
    if (buf?.timer) clearTimeout(buf.timer);
    this.deltaBuffers.delete(runId);
  }

  constructor(
    private emit: (event: AgentStreamEvent) => void,
    private broker: PermissionBroker,
    private getAuth: () => AuthStrategy,
    /** Per-run MCP config: workspace .mcp.json servers (env-expanded) plus
     *  in-process servers like the workspace's Google tools. */
    private buildMcpServers: (
      workspaceId: string,
      workspacePath: string,
      env: Record<string, string>,
    ) => Record<string, McpServerConfig>,
    /** Workspace permission profile check (always-allow rules). */
    private isAlwaysAllowed: (workspaceId: string, toolName: string) => boolean,
    /** Fired when a session becomes visible (tagged) — refreshes the sidebar. */
    private onSessionsChanged: () => void = () => {},
    /** Per-workspace credentials entered in Settings (Keychain-backed). */
    private getAppEnv: (
      workspaceId: string,
    ) => Record<string, string> = () => ({}),
    /** Append-only per-workspace audit trail; must never throw. */
    private logActivity: (
      workspacePath: string,
      entry: { kind: string; detail: string; runId?: string },
    ) => void = () => {},
    /** Per-run cost bookkeeping (API-key mode); must never throw. */
    private onRunCost: (
      workspacePath: string,
      costUsd: number,
      turns: number,
    ) => void = () => {},
    /** Extra system-prompt content per run (the working-memory snapshot).
     *  Read once at query start — frozen for the process's lifetime, so a
     *  live session sees memory written before it booted; later writes land
     *  on the next cold start. */
    private getSystemPromptAppend: (
      workspaceId: string,
      workspacePath: string,
    ) => string = () => "",
    /** Skills the user switched off — denied even if the agent tries anyway.
     *  Checked per tool call, so toggles apply to live sessions immediately. */
    private isSkillDisabled: (
      workspaceId: string,
      skill: string,
    ) => boolean = () => false,
    /** Run plumbing: the app runtime's BackgroundRuns (each one-shot run an
     *  owned fiber with a silence timeout and exactly one outcome) and the
     *  SDK queries (one-shot and live) — all injectable for tests. */
    private oneShot: {
      query?: QueryFactory;
      liveQuery?: LiveQueryFactory;
      backgroundRuns?: BackgroundRuns["Service"];
      /** The app runtime's owner of live CLI processes (closed on quit). */
      sessions?: AgentSessions["Service"];
    } = {},
  ) {}

  /** Live sessions' processes. Without the app's runtime (some tests), a
   *  standalone one is built on first use. */
  private get sessions(): AgentSessions["Service"] {
    this.oneShot.sessions ??= ManagedRuntime.make(AgentSessions.layer).runSync(
      Effect.service(AgentSessions),
    );
    return this.oneShot.sessions;
  }

  /** One-shot background runs (ingest, scheduled jobs, memory review).
   *  Exclusive among THEMSELVES per workspace — two racing over knowledge/
   *  would conflict — but they don't block interactive chat threads (or vice
   *  versa): chats stream while ingest works, and everything an ingest writes
   *  lands in the review queue anyway. Without the app's runtime (some
   *  tests), a standalone one is built on first use. */
  private get backgroundRuns(): BackgroundRuns["Service"] {
    this.oneShot.backgroundRuns ??= ManagedRuntime.make(
      BackgroundRuns.layer,
    ).runSync(Effect.service(BackgroundRuns));
    return this.oneShot.backgroundRuns;
  }

  /** The live session serving a given thread of a workspace, if any.
   *  Identity mirrors canReuseLiveSession: the session's own id once a turn
   *  has run, the id it was primed to resume before that, "" = fresh. */
  private findLiveForThread(
    workspacePath: string,
    resumeSessionId?: string,
  ): LiveSession | undefined {
    for (const s of this.live.values()) {
      if (
        s.workspacePath === workspacePath &&
        (s.sessionId || s.resumeOf) === (resumeSessionId ?? "")
      ) {
        return s;
      }
    }
    return undefined;
  }

  startRun(opts: {
    workspaceId: string;
    workspacePath: string;
    prompt: string;
    /** Caller-supplied run id (the webview mints one so it can route stream
     *  events to the right thread before the RPC response lands). */
    runId?: string;
    resumeSessionId?: string;
    /** Model alias ("sonnet" | "opus" | "haiku") or full id; omit for default. */
    model?: string;
    /** Composer reasoning / context / speed picks (interactive runs). */
    runOptions?: RunOptions;
    /** Provider for this run; omit to use the app's default provider. */
    auth?: AuthStrategy;
    /** Scheduled/headless run: never shows permission dialogs — tools outside
     *  the workspace's always-allow list are denied instead. */
    background?: boolean;
    /** Extra per-run allowlist for background runs (e.g. ingest's
     *  workspace-scoped file tools). Ignored for interactive runs. */
    safeTools?: (toolName: string, input: Record<string, unknown>) => boolean;
    /** Skip the sidebar tag: the run's thread never appears in the UI (e.g.
     *  ingest, whose outcome surfaces via the review queue + notification). */
    hiddenSession?: boolean;
  }): string {
    const auth = opts.auth ?? this.getAuth();
    if (opts.background) {
      // One background run at a time per workspace: two of them would race
      // over knowledge/. Interactive chats don't block it — they stream in
      // parallel, and ingest's writes are trust-gated by the review queue.
      if (this.backgroundRuns.isBusy(opts.workspacePath)) {
        throw new Error(
          "A background run is already active in this workspace.",
        );
      }
      auth.validate(); // throw a friendly error before spawning anything
      const runId = opts.runId ?? randomUUID();
      this.runAuth.set(runId, auth.id);
      this.execute(runId, auth, opts);
      return runId;
    }
    // Interactive runs are scoped per THREAD, not per workspace — the user
    // may work several threads in parallel (and while background runs work).
    // Only a run already streaming into this same thread blocks a message.
    if (opts.resumeSessionId) {
      const s = this.findLiveForThread(
        opts.workspacePath,
        opts.resumeSessionId,
      );
      if (s && s.turnRunId !== null && !s.abortedTurn) {
        throw new Error("A run is already active in this thread.");
      }
    }
    return this.startInteractiveTurn(auth, opts);
  }

  /** Boot a live session before the user sends anything, so the first message
   *  of a thread pays API latency only. Best-effort: any obstacle (busy
   *  workspace, unusable auth, no CLI) makes this a silent no-op — prewarm
   *  must never surface an error the user didn't cause. */
  prewarm(opts: InteractiveOpts & { auth?: AuthStrategy }): void {
    try {
      const auth = opts.auth ?? this.getAuth();
      const existing = this.findLiveForThread(
        opts.workspacePath,
        opts.resumeSessionId,
      );
      if (existing) {
        if (
          canReuseLiveSession(existing, {
            authId: auth.id,
            resumeSessionId: opts.resumeSessionId,
          })
        ) {
          return; // already primed for this thread
        }
        if (existing.turnRunId !== null) return; // busy or settling — leave it
        this.disposeLive(existing.key); // idle but wrong auth — replace it
      }
      auth.validate();
      this.evictIdleOverflow();
      this.createLiveSession(auth, opts, null);
    } catch {
      // best-effort by contract
    }
  }

  abortRun(runId: string): boolean {
    if (this.backgroundRuns.stop(runId)) {
      this.broker.denyAllForRun(runId);
      return true;
    }
    for (const s of this.live.values()) {
      if (s.turnRunId !== runId || s.abortedTurn) continue;
      this.broker.denyAllForRun(runId);
      s.abortedTurn = true;
      this.dropDeltas(runId);
      // The UI is released immediately; the turn's result (which the CLI
      // still emits after the interrupt) is swallowed in handleLiveMessage.
      this.emit({
        kind: "run-error",
        runId,
        error: "Stopped by the user.",
        aborted: true,
      });
      this.logActivity(s.workspacePath, {
        kind: "run-error",
        detail: "stopped by user",
        runId,
      });
      const q = s.query;
      if (q) {
        // Keep the process warm — interrupt the turn, not the session. If the
        // turn never settles, the session retires the process instead.
        s.session.interrupt(() => q.interrupt());
      } else {
        this.disposeLive(s.key);
      }
      return true;
    }
    return false;
  }

  /** ————— live sessions (interactive) ————— */

  private startInteractiveTurn(
    auth: AuthStrategy,
    opts: InteractiveOpts & { prompt: string; runId?: string },
  ): string {
    const runId = opts.runId ?? randomUUID();
    const existing = this.findLiveForThread(
      opts.workspacePath,
      opts.resumeSessionId,
    );
    if (
      existing?.query &&
      canReuseLiveSession(existing, {
        authId: auth.id,
        resumeSessionId: opts.resumeSessionId,
      })
    ) {
      this.beginWarmTurn(existing, runId, opts);
      return runId;
    }
    // Only replace a session that is idle AND bound to this same thread (a
    // stale prewarm with the wrong auth). A busy session here can only be a
    // parallel fresh thread ("" identity) — leave it alone and boot another.
    if (existing && existing.turnRunId === null) {
      this.disposeLive(existing.key);
    }
    auth.validate(); // throw a friendly error before spawning anything
    this.evictIdleOverflow();
    this.createLiveSession(auth, opts, { runId, prompt: opts.prompt });
    return runId;
  }

  private beginWarmTurn(
    s: LiveSession,
    runId: string,
    opts: InteractiveOpts & { prompt: string },
  ): void {
    s.session.busy();
    s.turnRunId = runId;
    this.runAuth.set(runId, s.authId as AuthMode);
    s.runIds.add(runId);
    s.turnStartedAt = Date.now();
    s.firstOutputAt = null;
    s.abortedTurn = false;
    this.logActivity(opts.workspacePath, {
      kind: "run-started",
      detail: opts.prompt.replace(/\s+/g, " ").slice(0, 160),
      runId,
    });
    if (s.initSeen) {
      // A cold turn announces itself from the init message; warm turns have
      // no init, so the started event (which unblocks the UI's run plumbing)
      // is emitted here with the already-known session identity.
      if (!s.tagged) void this.tagLiveSession(s, 3);
      this.emit({
        kind: "run-started",
        runId,
        sessionId: s.sessionId,
        model: s.modelName,
      });
    }
    const wantModel = opts.model ?? "";
    const cfg = claudeRunConfig(opts.runOptions);
    void (async () => {
      try {
        if (wantModel !== s.model) {
          // Fixed in place: setModel keeps the warm process when the user
          // flips the picker between messages (same provider).
          await s.query!.setModel(wantModel || undefined);
          s.model = wantModel;
        }
        if (flagsKey(cfg) !== s.flagsKey) {
          // Same for effort / fast mode / ultracode / context. Booleans are
          // set explicitly — clearing fastMode with null leaves it on for the
          // rest of the session; null is right for effort and the window.
          await s.query!.applyFlagSettings({
            effortLevel: cfg.effort ?? null,
            fastMode: cfg.fastMode,
            ultracode: cfg.ultracode,
            enableWorkflows: cfg.ultracode ? true : null,
            autoCompactWindow: cfg.contextKey === "200k" ? CONTEXT_200K : null,
          });
          s.flagsKey = flagsKey(cfg);
        }
        this.sendPrompt(
          s,
          cfg.ultrathink ? opts.prompt + ULTRATHINK_SUFFIX : opts.prompt,
        );
      } catch (e) {
        this.logActivity(opts.workspacePath, {
          kind: "run-error",
          detail: friendly(e).slice(0, 200),
          runId,
        });
        this.emit({
          kind: "run-error",
          runId,
          error: friendly(e),
          ...(this.loginNeeded(runId, friendly(e)) ? { needsLogin: true } : {}),
        });
        s.abortedTurn = true; // suppress a second error from the loop teardown
        this.disposeLive(s.key);
      }
    })();
  }

  /** Hand a user message to the session's CLI. Input is never dropped: a
   *  session that is already closing refuses it, and the turn fails. */
  private sendPrompt(s: LiveSession, text: string): void {
    const sent = s.session.send({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    if (!sent) throw new Error("The session closed. Send the message again.");
  }

  private createLiveSession(
    auth: AuthStrategy,
    opts: InteractiveOpts,
    first: { runId: string; prompt: string } | null,
  ): void {
    const s: LiveSession = {
      key: randomUUID(),
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      authId: auth.id,
      model: opts.model ?? "",
      flagsKey: flagsKey(claudeRunConfig(opts.runOptions)),
      resumeOf: opts.resumeSessionId ?? "",
      sessionId: "",
      query: null,
      session: undefined as unknown as AgentSession, // assigned just below
      turnRunId: first?.runId ?? null,
      lastRunId: "",
      runIds: new Set(first ? [first.runId] : []),
      abortedTurn: false,
      tagged: false,
      initSeen: false,
      spawnAt: Date.now(),
      initAt: 0,
      turnStartedAt: Date.now(),
      firstOutputAt: null,
      turnCold: first !== null,
      costUsdTotal: 0,
      numTurnsTotal: 0,
    };
    this.live.set(s.key, s);
    const forget = () => {
      if (this.live.get(s.key) === s) this.live.delete(s.key);
    };
    s.session = this.sessions.open({
      open: (input, abort) => this.openLive(s, input, abort, auth, opts),
      onMessage: (msg) => this.handleLiveMessage(s, msg, opts),
      onClosing: forget,
      onEnd: (error) => {
        forget();
        void this.liveEnded(s, opts, error);
      },
    });
    if (first) {
      this.sendPrompt(
        s,
        claudeRunConfig(opts.runOptions).ultrathink
          ? first.prompt + ULTRATHINK_SUFFIX
          : first.prompt,
      );
      this.logActivity(opts.workspacePath, {
        kind: "run-started",
        detail: first.prompt.replace(/\s+/g, " ").slice(0, 160),
        runId: first.runId,
      });
    } else {
      // An unused prewarm reaps itself like any idle session.
      s.session.idle();
    }
  }

  /** Spawn the session's CLI: a streaming-input query reading `input`. */
  private async openLive(
    s: LiveSession,
    input: AsyncIterable<SDKUserMessage>,
    abort: AbortController,
    auth: AuthStrategy,
    opts: InteractiveOpts,
  ): Promise<LiveQuery> {
    // Local mode boots the Ollama server here; cloud modes have no hook.
    if (auth.prepare) await auth.prepare();
    const { env, mcpServers, promptAppend, authOpts } = this.prepareRun(
      auth,
      opts,
    );
    const cfg = claudeRunConfig(opts.runOptions);
    const flags = flagSettings(cfg);
    const q = (this.oneShot.liveQuery ?? sdkLiveQuery)({
      prompt: input,
      options: {
        cwd: opts.workspacePath,
        env,
        // Workspace isolation: ONLY the servers Monad passes explicitly.
        // User-level and claude.ai account connectors never leak in.
        mcpServers,
        strictMcpConfig: true,
        ...(authOpts.pathToClaudeCodeExecutable
          ? {
              pathToClaudeCodeExecutable: authOpts.pathToClaudeCodeExecutable,
            }
          : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(promptAppend ? { append: promptAppend } : {}),
        },
        // Live token streaming for the chat.
        includePartialMessages: true,
        settingSources: ["project"],
        ...(s.model ? { model: s.model } : {}),
        ...(cfg.effort ? { effort: cfg.effort } : {}),
        ...(Object.keys(flags).length ? { settings: flags } : {}),
        abortController: abort,
        ...(s.resumeOf ? { resume: s.resumeOf } : {}),
        canUseTool: this.makeCanUseTool(
          { ...opts, background: false },
          () => s.turnRunId ?? s.lastRunId,
        ),
      },
    });
    s.query = q;
    return q;
  }

  /** The session's process is gone: report the turn it took down (if any),
   *  then release everything the session held. */
  private async liveEnded(
    s: LiveSession,
    opts: InteractiveOpts,
    error: unknown,
  ): Promise<void> {
    const runId = s.turnRunId;
    if (runId && !s.abortedTurn) {
      // The turn in flight gets its one terminal event, however the process
      // went: killed, failed, or exited cleanly before the turn's result.
      const reason =
        error === undefined
          ? "The run ended without a result."
          : s.session.killed
            ? null
            : friendly(error);
      if (reason === null) {
        this.logActivity(opts.workspacePath, {
          kind: "run-error",
          detail: "stopped by user",
          runId,
        });
        this.emit({
          kind: "run-error",
          runId,
          error: "Stopped. There was an error during the run.",
          aborted: true,
        });
      } else {
        this.logActivity(opts.workspacePath, {
          kind: "run-error",
          detail: reason.slice(0, 200),
          runId,
        });
        this.emit({
          kind: "run-error",
          runId,
          error: reason,
          ...(this.loginNeeded(runId, reason) ? { needsLogin: true } : {}),
        });
      }
    } else if (error !== undefined && !s.session.killed && !s.session.closing) {
      // Idle process died on its own — nothing user-facing to report; the
      // next message simply cold-starts.
      this.logActivity(opts.workspacePath, {
        kind: "session",
        detail: `live session ended: ${friendly(error).slice(0, 120)}`,
      });
    }
    // Un-emitted deltas from a dead session must not fire into a later state.
    for (const id of s.runIds) {
      this.dropDeltas(id);
      this.lastUsageMsgId.delete(id);
    }
    // Settle any permission request still outstanding. Without this, a
    // session that dies abnormally leaves a live card that would still
    // mutate the allowlist if "always" is clicked.
    if (s.turnRunId) this.broker.denyAllForRun(s.turnRunId);
    // Release any held-back tool calls whose result never arrived.
    for (const [id, p] of this.pendingArtifacts) {
      if (s.runIds.has(p.runId)) this.pendingArtifacts.delete(id);
    }
    for (const [id, p] of this.pendingEmails) {
      if (s.runIds.has(p.runId)) this.pendingEmails.delete(id);
    }
    // A message-less session file (reaped prewarm fork, or a run killed
    // before its first write) is deleted, never surfaced as a thread.
    if (s.sessionId && this.cleanupEmptySession(s.workspacePath, s.sessionId)) {
      // removed — nothing to tag
    } else if (s.sessionId && !s.tagged && s.runIds.size > 0) {
      // Backstop so a thread whose session died mid-run still appears.
      await this.markOwned(s.workspaceId, s.workspacePath, s.sessionId, 1);
    }
  }

  private handleLiveMessage(
    s: LiveSession,
    msg: SDKMessage,
    opts: InteractiveOpts,
  ): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          s.sessionId = msg.session_id;
          s.modelName = msg.model;
          s.initSeen = true;
          s.initAt = Date.now();
          if (s.turnRunId) {
            // Tag only once a turn exists — tagging a prewarmed-but-unused
            // session would surface an empty thread in the sidebar.
            if (!s.tagged) void this.tagLiveSession(s, 3);
            if (!s.abortedTurn) {
              this.emit({
                kind: "run-started",
                runId: s.turnRunId,
                sessionId: s.sessionId,
                model: msg.model,
              });
            }
          }
        }
        break;
      case "stream_event":
      case "assistant":
      case "user": {
        if (s.abortedTurn) break; // post-Stop stragglers stay out of the chat
        const runId = s.turnRunId ?? s.lastRunId;
        if (!runId) break;
        if (
          s.firstOutputAt === null &&
          s.turnRunId &&
          msg.type !== "user" &&
          !msg.parent_tool_use_id
        ) {
          s.firstOutputAt = Date.now();
        }
        this.normalizeContent(runId, msg, opts.workspacePath);
        break;
      }
      case "result": {
        const runId = s.turnRunId;
        if (runId) this.flushDeltas(runId);
        // Re-tag at the end of every turn (see markOwned): the turn's output
        // may have pushed the init-time tag out of the SDK's tail window.
        // The owner record is written synchronously, before run-finished
        // triggers the sidebar refresh below.
        if (runId && s.sessionId) {
          void this.markOwned(s.workspaceId, s.workspacePath, s.sessionId, 2);
        }
        // Streaming-input results carry session-cumulative totals; per-turn
        // numbers are deltas (clamped — a /clear or crash may reset them).
        const costDelta = Math.max(
          0,
          (msg.total_cost_usd ?? 0) - s.costUsdTotal,
        );
        s.costUsdTotal = Math.max(s.costUsdTotal, msg.total_cost_usd ?? 0);
        const { delta: turnsDelta, total } = liveTurnsDelta(
          s.numTurnsTotal,
          msg.num_turns ?? 0,
        );
        s.numTurnsTotal = total;
        if (runId) {
          const now = Date.now();
          const timing = [
            s.turnCold ? `cold · init ${s.initAt - s.spawnAt}ms` : "warm",
            ...(s.firstOutputAt
              ? [`first output ${s.firstOutputAt - s.turnStartedAt}ms`]
              : []),
            `turn ${now - s.turnStartedAt}ms`,
          ].join(" · ");
          this.logActivity(s.workspacePath, {
            kind: "timing",
            detail: timing,
            runId,
          });
          if (!s.abortedTurn) {
            this.logActivity(s.workspacePath, {
              kind: "run-finished",
              detail: `${turnsDelta} turns${costDelta ? ` · $${costDelta.toFixed(3)}` : ""}`,
              runId,
            });
            if (costDelta) {
              this.onRunCost(s.workspacePath, costDelta, turnsDelta);
            }
            const error = resultError(msg);
            this.emit({
              kind: "run-finished",
              runId,
              sessionId: msg.session_id ?? s.sessionId,
              numTurns: turnsDelta,
              costUsd: costDelta || undefined,
              contextWindow: mainContextWindow(msg.modelUsage),
              ...(error ? { error } : {}),
              ...(this.loginNeeded(runId, error) ? { needsLogin: true } : {}),
            });
          }
        }
        this.endLiveTurn(s);
        break;
      }
    }
  }

  /** Only the subscription CLI can lose its login; everything else that
   *  says "authenticate" is a key problem the Settings page already covers. */
  private loginNeeded(runId: string, error: string): boolean {
    return (
      this.runAuth.get(runId) === "subscription-cli" &&
      isClaudeLoginError(error)
    );
  }

  /** Retire every idle warm process. After a fresh `claude auth login` the
   *  next message must start a CLI that reads the new credentials, not
   *  resume one that already gave up on the old ones. Sessions mid-turn are
   *  left alone (they end on their own). Returns how many were dropped. */
  dropIdleLiveSessions(): number {
    let n = 0;
    for (const s of [...this.live.values()]) {
      if (s.turnRunId !== null) continue;
      this.disposeLive(s.key);
      n++;
    }
    return n;
  }

  private endLiveTurn(s: LiveSession): void {
    s.session.settled();
    if (s.turnRunId) {
      s.lastRunId = s.turnRunId;
      this.lastUsageMsgId.delete(s.turnRunId);
      this.runAuth.delete(s.turnRunId);
    }
    s.turnRunId = null;
    s.abortedTurn = false;
    s.turnCold = false;
    s.session.idle();
  }

  /** Retire a live session: close its input so the CLI exits on its own, with
   *  a hard kill as backstop. Safe to call for a session mid-teardown. */
  private disposeLive(key: string): void {
    this.live.get(key)?.session.close();
  }

  /** Keep at most MAX_LIVE_SESSIONS warm processes: before creating another,
   *  drop the oldest idle one. Sessions mid-turn are never evicted. */
  private evictIdleOverflow(): void {
    while (this.live.size >= MAX_LIVE_SESSIONS) {
      let oldest: LiveSession | null = null;
      for (const s of this.live.values()) {
        if (s.turnRunId !== null) continue;
        if (!oldest || s.spawnAt < oldest.spawnAt) oldest = s;
      }
      if (!oldest) return; // everything is busy — nothing safe to evict
      this.disposeLive(oldest.key);
    }
  }

  /** Ghost prevention: a session file with no messages must not survive as a
   *  "thread". The CLI leaves such files in two ways — a prewarmed resume
   *  forks the parent's metadata (INCLUDING its Monad tag, which would
   *  surface an empty duplicate in the sidebar), and a killed run can flush
   *  metadata without ever writing a message. Returns true when the session
   *  was removed (so callers skip tagging); unreadable/missing files are left
   *  alone — never delete on uncertainty. */
  private cleanupEmptySession(
    workspacePath: string,
    sessionId: string,
  ): boolean {
    try {
      const raw = fs.readFileSync(
        sessionFilePath(workspacePath, sessionId),
        "utf8",
      );
      if (jsonlHasMessages(raw)) return false;
    } catch {
      return false;
    }
    void deleteSession(sessionId, { dir: workspacePath }).catch(() => {});
    forgetSessionOwner(workspacePath, sessionId);
    return true;
  }

  /** Mark a live session's thread as Monad-owned as soon as a turn exists,
   *  so it shows in the sidebar while the turn is still streaming. */
  private async tagLiveSession(
    s: LiveSession,
    attempts: number,
  ): Promise<void> {
    if (s.tagged || !s.sessionId) return;
    if (
      await this.markOwned(
        s.workspaceId,
        s.workspacePath,
        s.sessionId,
        attempts,
      )
    ) {
      s.tagged = true;
    }
    this.onSessionsChanged();
  }

  /** Mark a session as this workspace's Monad thread: record its owner in
   *  .monad/session-owners.json (what the sidebar trusts) and append the
   *  Monad tag to the session file (portable — what the SDK reports).
   *
   *  Called when the thread first appears AND again whenever a run or turn
   *  finishes. The SDK reads the tag from the last 64 KB of the JSONL only,
   *  and current CLIs no longer re-append a tag written from outside their
   *  process — a tag written once at start is pushed out of that window by
   *  any long run (a briefing, a tool-heavy chat). Re-tagging at the end
   *  keeps it in the window; the recorded owner keeps the thread listed even
   *  when it isn't. Tagging is retried because the CLI writes the session
   *  file asynchronously shortly after init. True once the tag is written. */
  private async markOwned(
    workspaceId: string,
    workspacePath: string,
    sessionId: string,
    attempts: number,
  ): Promise<boolean> {
    recordSessionOwner(workspacePath, sessionId, workspaceId);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await tagSession(sessionId, monadTag(workspaceId), {
          dir: workspacePath,
        });
        return true;
      } catch {
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return false;
  }

  /** ————— shared query plumbing ————— */

  /** Env, MCP servers and system-prompt append for a run. Failures in the
   *  memory snapshot must never block the run — a broken snapshot degrades
   *  to none. */
  private prepareRun(
    auth: AuthStrategy,
    opts: { workspaceId: string; workspacePath: string },
  ): {
    env: Record<string, string>;
    mcpServers: Record<string, McpServerConfig>;
    promptAppend: string;
    authOpts: ReturnType<AuthStrategy["sdkOptions"]>;
  } {
    const authOpts = auth.sdkOptions();
    // process.env < workspace .env (dev override) < Settings-entered credentials
    // (Keychain) < auth overrides (API key)
    const env = {
      ...(process.env as Record<string, string>),
      ...loadWorkspaceEnv(opts.workspacePath),
      ...this.getAppEnv(opts.workspaceId),
      ...(authOpts.env ?? {}),
    };
    // An auth strategy clears an inherited var by overriding it to "" —
    // drop those keys entirely so the subprocess never sees them (e.g. a
    // developer-shell ANTHROPIC_API_KEY silently billing API rates while the
    // UI says "subscription").
    for (const key of Object.keys(env)) {
      if (env[key] === "") delete env[key];
    }
    const mcpServers = this.buildMcpServers(
      opts.workspaceId,
      opts.workspacePath,
      env,
    );
    // Memory injection: the working-memory snapshot rides the system prompt so
    // a fresh session already knows active threads/facts/decisions.
    let promptAppend = "";
    try {
      promptAppend = this.getSystemPromptAppend(
        opts.workspaceId,
        opts.workspacePath,
      );
    } catch (e) {
      this.logActivity(opts.workspacePath, {
        kind: "memory",
        detail: `snapshot failed: ${String((e as Error).message).slice(0, 120)}`,
      });
    }
    return { env, mcpServers, promptAppend, authOpts };
  }

  /** The permission gate, shared by one-shot and live runs. getRunId is a
   *  thunk because a live session's runId changes per turn. */
  private makeCanUseTool(
    opts: {
      workspaceId: string;
      workspacePath: string;
      background?: boolean;
      safeTools?: (toolName: string, input: Record<string, unknown>) => boolean;
    },
    getRunId: () => string,
  ) {
    return async (toolName: string, input: Record<string, unknown>) => {
      const runId = getRunId();
      const log = (kind: string, detail: string) =>
        this.logActivity(opts.workspacePath, { kind, detail, runId });
      const summary = summarize(toolName, input);
      // A switched-off skill is off for every path into the run —
      // the system prompt asks the agent not to use it, this makes
      // sure it can't anyway (interactive and background alike).
      const skill = skillNameOf(toolName, input);
      if (skill && this.isSkillDisabled(opts.workspaceId, skill)) {
        log("skill-disabled", `${skill} · denied`);
        return {
          behavior: "deny" as const,
          message: `The "${skill}" skill is switched off in Monad's settings. Continue without it.`,
        };
      }
      if (opts.background) {
        const decision = backgroundToolDecision(
          toolName,
          input,
          opts.workspacePath,
          (t) => this.isAlwaysAllowed(opts.workspaceId, t),
          opts.safeTools,
        );
        if (decision !== "deny") {
          log("tool", `${toolName} · ${summary} · ${decision}`);
          return { behavior: "allow" as const, updatedInput: input };
        }
        log("background-denied", `${toolName} · ${summary}`);
        return {
          behavior: "deny" as const,
          // Policy-governed tools were refused for THIS input, not by name —
          // say what would pass, or the agent abandons the tool altogether.
          message:
            opts.safeTools && isIngestGovernedTool(toolName)
              ? backgroundPolicyHint(toolName)
              : `${toolName} is not in this workspace's always-allow list; background runs cannot ask for permission. Continue without it.`,
        };
      }
      // Interactive: always-allow is honored only when every path input
      // stays inside the workspace — an out-of-workspace path on an
      // always-allowed file tool falls through to the permission dialog
      // instead of silently passing (the grant is name-only). Tools with
      // outbound side effects (ALWAYS_PROMPT_TOOLS) always prompt.
      if (
        !ALWAYS_PROMPT_TOOLS.has(toolName) &&
        this.isAlwaysAllowed(opts.workspaceId, toolName) &&
        fileToolPathsInsideWorkspace(toolName, input, opts.workspacePath)
      ) {
        log("tool", `${toolName} · ${summary} · auto-allowed`);
        return { behavior: "allow" as const, updatedInput: input };
      }
      const allow = await this.broker.ask(
        runId,
        toolName,
        input,
        opts.workspaceId,
      );
      log(
        "permission",
        `${toolName} · ${summary} · ${allow ? "allowed" : "denied"} by user`,
      );
      return allow
        ? { behavior: "allow" as const, updatedInput: input }
        : {
            behavior: "deny" as const,
            message: "Denied by the user in Monad.",
          };
    };
  }

  /** ————— one-shot runs (background: ingest, scheduled, memory review) ————— */

  private execute(
    runId: string,
    auth: AuthStrategy,
    opts: {
      workspaceId: string;
      workspacePath: string;
      prompt: string;
      resumeSessionId?: string;
      model?: string;
      auth?: AuthStrategy;
      background?: boolean;
      safeTools?: (toolName: string, input: Record<string, unknown>) => boolean;
      hiddenSession?: boolean;
    },
  ): void {
    let sessionId = opts.resumeSessionId ?? "";
    // Tag the session as Monad-owned as soon as its id is known so the thread
    // shows up in the sidebar while the run is still streaming (the sidebar
    // filters to tagged sessions). Retried because the session file is written
    // asynchronously by the CLI shortly after init. Hidden runs start as
    // "tagged" so both this and the end-of-run backstop skip them entirely.
    let tagged = opts.hiddenSession === true;
    const tryTag = async (attempts: number): Promise<void> => {
      if (tagged || !sessionId) return;
      if (
        await this.markOwned(
          opts.workspaceId,
          opts.workspacePath,
          sessionId,
          attempts,
        )
      ) {
        tagged = true;
      }
      this.onSessionsChanged();
    };
    const log = (kind: string, detail: string) =>
      this.logActivity(opts.workspacePath, { kind, detail, runId });
    log(
      "run-started",
      `${opts.background ? "[scheduled] " : ""}${opts.prompt.replace(/\s+/g, " ").slice(0, 160)}`,
    );
    const startedAt = Date.now();
    let initAt = 0;
    let firstOutputAt = 0;
    const query = this.oneShot.query ?? sdkQuery;

    const open = async (signal: AbortSignal) => {
      // Local mode boots the Ollama server here; cloud modes have no hook.
      if (auth.prepare) await auth.prepare();
      const { env, mcpServers, promptAppend, authOpts } = this.prepareRun(
        auth,
        opts,
      );
      // The SDK takes a controller; the run's signal fires on Stop, on the
      // silence timeout and when the app quits.
      const abort = new AbortController();
      signal.addEventListener("abort", () => abort.abort(), { once: true });
      return query({
        prompt: opts.prompt,
        options: {
          cwd: opts.workspacePath,
          env,
          // Workspace isolation: ONLY the servers Monad passes explicitly.
          // User-level and claude.ai account connectors never leak in.
          mcpServers,
          strictMcpConfig: true,
          ...(authOpts.pathToClaudeCodeExecutable
            ? {
                pathToClaudeCodeExecutable: authOpts.pathToClaudeCodeExecutable,
              }
            : {}),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(promptAppend ? { append: promptAppend } : {}),
          },
          // Background runs skip live token streaming — their streams are
          // swallowed into panels/notifications anyway.
          ...(opts.background ? {} : { includePartialMessages: true }),
          settingSources: ["project"],
          ...(opts.model ? { model: opts.model } : {}),
          abortController: abort,
          ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
          canUseTool: this.makeCanUseTool(opts, () => runId),
        },
      });
    };

    const onMessage = async (msg: SDKMessage) => {
      const hadSession = !!sessionId;
      if (msg.type === "system" && msg.subtype === "init" && !initAt) {
        initAt = Date.now();
      }
      if (
        !firstOutputAt &&
        (msg.type === "assistant" || msg.type === "stream_event")
      ) {
        firstOutputAt = Date.now();
      }
      if (msg.type === "result") {
        // Narrowed to SDKResultMessage here — both the success and error
        // variants carry session_id/num_turns/total_cost_usd.
        // Re-tag BEFORE run-finished goes out (the webview refreshes the
        // sessions list on that event): the run's own output may have
        // pushed the init-time tag out of the SDK's tail window — see
        // markOwned. Hidden runs (ingest) are never tagged.
        sessionId = msg.session_id ?? sessionId;
        if (!opts.hiddenSession && sessionId) {
          if (
            await this.markOwned(
              opts.workspaceId,
              opts.workspacePath,
              sessionId,
              2,
            )
          ) {
            tagged = true;
          }
        }
        log(
          "timing",
          [
            `cold · init ${initAt ? initAt - startedAt : 0}ms`,
            ...(firstOutputAt
              ? [`first output ${firstOutputAt - startedAt}ms`]
              : []),
            `run ${Date.now() - startedAt}ms`,
          ].join(" · "),
        );
        log(
          "run-finished",
          `${msg.num_turns ?? 0} turns${msg.total_cost_usd ? ` · $${msg.total_cost_usd.toFixed(3)}` : ""}`,
        );
        if (msg.total_cost_usd) {
          this.onRunCost(
            opts.workspacePath,
            msg.total_cost_usd,
            msg.num_turns ?? 0,
          );
        }
        return; // run-finished is the outcome's to emit — see onOutcome
      }
      sessionId = this.normalize(runId, sessionId, msg, opts.workspacePath);
      if (!hadSession && sessionId) void tryTag(3);
    };

    /** The run's one terminal event, then cleanup. BackgroundRuns has
     *  already freed the workspace slot, so an owner reacting to the event
     *  (ingest chaining queued files) can start the next run right away. */
    const onOutcome = async (outcome: RunOutcome<SDKMessage>) => {
      const fail = (error: string, detail = error.slice(0, 200)) => {
        log("run-error", detail);
        this.emit({
          kind: "run-error",
          runId,
          error,
          ...(this.loginNeeded(runId, error) ? { needsLogin: true } : {}),
        });
      };
      switch (outcome._tag) {
        case "Finished":
          sessionId = this.normalize(
            runId,
            sessionId,
            outcome.result,
            opts.workspacePath,
          );
          break;
        case "Failed":
          fail(friendly(outcome.cause));
          break;
        case "EndedWithoutResult":
          // Still reported, or the run's owner (scheduler, ingest) waits for
          // an end that never comes — its job stays stamped as ran and is
          // never retried.
          fail("The run ended without a result.");
          break;
        case "TimedOut":
          // Retryable: the scheduler's transient matcher accepts STALL_ERROR.
          fail(STALL_ERROR);
          break;
        case "Stopped":
          log("run-error", "stopped by user");
          this.emit({
            kind: "run-error",
            runId,
            error: "Stopped by the user.",
            aborted: true,
          });
          break;
        case "Interrupted":
          // The app is quitting. No event: persisted scheduler state and
          // orphan recovery pick the run up on next launch.
          log("run-error", "interrupted — app quit");
          break;
      }
      this.runAuth.delete(runId);
      // Un-emitted deltas from a dead run must not fire into a later state.
      this.dropDeltas(runId);
      this.lastUsageMsgId.delete(runId);
      // Settle any permission request still outstanding for this run. Without
      // this, a run that dies abnormally (SDK crash, subprocess exit) leaves a
      // live card that would still mutate the allowlist if "always" is clicked.
      this.broker.denyAllForRun(runId);
      // Release any held-back tool calls whose result never arrived (run ended
      // mid-tool) so these maps don't grow unbounded across aborts.
      for (const [id, p] of this.pendingArtifacts) {
        if (p.runId === runId) this.pendingArtifacts.delete(id);
      }
      for (const [id, p] of this.pendingEmails) {
        if (p.runId === runId) this.pendingEmails.delete(id);
      }
      // A message-less session (run died before its first write) is deleted
      // rather than surfaced as an empty thread.
      if (
        sessionId &&
        this.cleanupEmptySession(opts.workspacePath, sessionId)
      ) {
        // removed — nothing to tag
      } else if (sessionId && !tagged) {
        // Backstop for aborted/errored runs so their threads still appear.
        await this.markOwned(
          opts.workspaceId,
          opts.workspacePath,
          sessionId,
          1,
        );
      }
    };

    this.backgroundRuns.start({
      runId,
      workspacePath: opts.workspacePath,
      open,
      onMessage,
      onOutcome,
    });
  }

  /** Translate raw SDK messages into AgentStreamEvents. Returns the session id.
   *  Used by one-shot runs; live sessions handle system/result themselves and
   *  route content through normalizeContent. */
  private normalize(
    runId: string,
    sessionId: string,
    msg: SDKMessage,
    workspacePath: string,
  ): string {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          sessionId = msg.session_id;
          this.emit({
            kind: "run-started",
            runId,
            sessionId,
            model: msg.model,
          });
        }
        break;
      case "result": {
        this.flushDeltas(runId);
        // An API/network failure inside the CLI is NOT thrown — it arrives as
        // a result with is_error (or a non-success subtype). Carry it on the
        // event so background owners don't treat a dead run as delivered.
        const error = resultError(msg);
        this.emit({
          kind: "run-finished",
          runId,
          sessionId: msg.session_id ?? sessionId,
          numTurns: msg.num_turns ?? 0,
          costUsd: msg.total_cost_usd,
          contextWindow: mainContextWindow(msg.modelUsage),
          ...(error ? { error } : {}),
          ...(this.loginNeeded(runId, error) ? { needsLogin: true } : {}),
        });
        break;
      }
      default:
        this.normalizeContent(runId, msg, workspacePath);
    }
    return sessionId;
  }

  /** The content-bearing message types (deltas, complete blocks, tool
   *  results) — shared verbatim between one-shot and live runs. */
  private normalizeContent(
    runId: string,
    msg: SDKMessage,
    workspacePath: string,
  ): void {
    switch (msg.type) {
      case "stream_event": {
        // Partial-message deltas (includePartialMessages). Top-level text and
        // thinking only — subagent streams (parent_tool_use_id) and tool-input
        // deltas are noise at chat granularity.
        if (msg.parent_tool_use_id) break;
        const ev = msg.event;
        if (ev?.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta" && ev.delta.text) {
            this.queueDelta(runId, "text", ev.delta.text);
          } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
            this.queueDelta(runId, "thinking", ev.delta.thinking);
          }
        }
        break;
      }
      case "assistant":
        // Complete blocks follow their own deltas — flush so the live tail is
        // current before the authoritative text/thinking event replaces it.
        this.flushDeltas(runId);
        // Context accounting: input + cache + output of the latest top-level
        // API call is the conversation's current footprint in the model's
        // context window. Subagents run in their own windows — skip them.
        if (
          !msg.parent_tool_use_id &&
          msg.message?.usage &&
          this.lastUsageMsgId.get(runId) !== msg.message.id
        ) {
          this.lastUsageMsgId.set(runId, msg.message.id);
          const u = msg.message.usage;
          this.emit({
            kind: "usage",
            runId,
            contextTokens:
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0) +
              (u.output_tokens ?? 0),
          });
        }
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            this.emit({ kind: "text", runId, text: block.text });
          } else if (block.type === "thinking" && block.thinking) {
            this.emit({ kind: "thinking", runId, text: block.thinking });
          } else if (block.type === "tool_use") {
            const op = artifactOpFromToolName(block.name);
            // The SDK types tool input as `{}` (it is whatever the tool's own
            // schema says), so the id is narrowed rather than asserted.
            const artifactId =
              typeof block.input === "object" &&
              block.input !== null &&
              "id" in block.input &&
              typeof block.input.id === "string"
                ? block.input.id
                : "";
            if (op && artifactId) {
              // Held back until the result arrives: success becomes an
              // artifact event, failure falls back to the generic pair.
              this.pendingArtifacts.set(block.id, {
                runId,
                op,
                artifactId,
                name: block.name,
                inputSummary: summarize(block.name, block.input),
              });
              continue;
            }
            if (block.name === DRAFT_EMAIL_TOOL) {
              const draft = parseEmailDraftInput(block.input);
              if (draft) {
                this.pendingEmails.set(block.id, {
                  runId,
                  draft,
                  name: block.name,
                  inputSummary: summarize(block.name, block.input),
                });
                continue;
              }
            }
            this.emit({
              kind: "tool-call",
              runId,
              toolUseId: block.id,
              name: block.name,
              inputSummary: summarize(block.name, block.input),
            });
          }
        }
        break;
      case "user": {
        // A user message's content is `string | ContentBlockParam[]`; the
        // string form is plain prompt text and carries no tool results.
        const content = msg.message?.content;
        for (const block of typeof content === "string"
          ? []
          : (content ?? [])) {
          if (block.type === "tool_result") {
            const pendingEmail = this.pendingEmails.get(block.tool_use_id);
            if (pendingEmail) {
              this.pendingEmails.delete(block.tool_use_id);
              if (!block.is_error) {
                this.emit({
                  kind: "email-draft",
                  runId,
                  draft: pendingEmail.draft,
                });
                continue;
              }
              this.emit({
                kind: "tool-call",
                runId,
                toolUseId: block.tool_use_id,
                name: pendingEmail.name,
                inputSummary: pendingEmail.inputSummary,
              });
            }
            const pending = this.pendingArtifacts.get(block.tool_use_id);
            if (pending) {
              this.pendingArtifacts.delete(block.tool_use_id);
              const saved = block.is_error
                ? null
                : readArtifact(workspacePath, pending.artifactId);
              if (saved) {
                this.emit({
                  kind: "artifact",
                  runId,
                  artifactId: pending.artifactId,
                  artifactType: saved.type,
                  title: saved.title,
                  op: pending.op,
                  content: saved.content,
                });
                continue;
              }
              // Error (or the file vanished): surface as a normal tool call.
              this.emit({
                kind: "tool-call",
                runId,
                toolUseId: block.tool_use_id,
                name: pending.name,
                inputSummary: pending.inputSummary,
              });
            }
            this.emit({
              kind: "tool-result",
              runId,
              toolUseId: block.tool_use_id,
              output: renderToolResult(block.content),
              isError: !!block.is_error,
            });
          }
        }
        break;
      }
    }
  }
}

/** The main loop's usage entry — modelUsage covers every model the query
 *  touched (subagents, compaction…); the main loop is the entry with the
 *  largest input flow. */
function mainContextWindow(
  modelUsage:
    | Record<
        string,
        {
          inputTokens: number;
          cacheReadInputTokens: number;
          contextWindow?: number;
        }
      >
    | undefined,
): number | undefined {
  let best: { flow: number; contextWindow?: number } | null = null;
  for (const u of Object.values(modelUsage ?? {})) {
    const flow = u.inputTokens + u.cacheReadInputTokens;
    if (!best || flow > best.flow) {
      best = { flow, contextWindow: u.contextWindow };
    }
  }
  return best?.contextWindow || undefined;
}

/** Per-turn count from a streaming-input result's num_turns. It is
 *  documented less precisely than cost — treat it as cumulative when it only
 *  ever grows, and fall back to the raw value when it resets (per-turn
 *  emitter, /clear, crash). A result with num_turns 0 is skipped: since SDK
 *  0.3.274 queued background-task completions share one model call and all
 *  but the last of their results are empty with num_turns 0 — counting that
 *  as a reset made the next real turn report the whole session's turns.
 *  Exported for tests. */
export function liveTurnsDelta(
  priorTotal: number,
  rawTurns: number,
): { delta: number; total: number } {
  if (rawTurns === 0) return { delta: 0, total: priorTotal };
  return {
    delta: rawTurns >= priorTotal ? rawTurns - priorTotal : rawTurns,
    total: rawTurns,
  };
}

/** The `content` of a tool_result block, pulled out of the SDK's own user
 *  message type rather than restated here — if the SDK reshapes it, this fails
 *  to compile instead of silently drifting. Derived from the direct dependency
 *  so it does not reach into @anthropic-ai/sdk, which is only transitive. */
type ToolResultContent = Extract<
  Extract<SDKUserMessage["message"]["content"], readonly unknown[]>[number],
  { type: "tool_result" }
>["content"];

function renderToolResult(content: ToolResultContent): string {
  if (typeof content === "string") return content.slice(0, 2000);
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
      .join("\n")
      .slice(0, 2000);
  }
  return "";
}

/** The failure text of an errored SDK result, or "" for a real success. */
export function resultError(msg: SDKResultMessage): string {
  if (msg.subtype !== "success") {
    const detail = (msg.errors ?? []).filter(Boolean).join("; ");
    return detail || msg.subtype;
  }
  if (!msg.is_error) return "";
  return msg.result || "The run ended in error.";
}

function friendly(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  if (/not found|ENOENT/i.test(s)) {
    return `${s}\nHint: check the Claude CLI install or switch auth mode in Settings.`;
  }
  if (/ECONNREFUSED|connection refused|fetch failed/i.test(s)) {
    return `${s}\nHint: if you're using local models, make sure Ollama is running (Settings → Providers).`;
  }
  return s;
}
