import { create } from "zustand";
import { deriveArtifacts, type ArtifactState } from "../shared/artifacts";
import {
  keepIfEqual,
  keepListIfEqual,
  keepRecordIfEqual,
} from "./lib/keepIfEqual";
import type { SectionId } from "./threadGroups";
import type {
  AgentStreamEvent,
  BackgroundRunInfo,
  ChatItem,
  ClaudeAuthStatus,
  DriveEvent,
  HealthIssue,
  InboxFile,
  IngestStatus,
  OllamaStatus,
  OutboxFile,
  PermissionRequest,
  ProviderId,
  ReviewItem,
  RunOptions,
  SessionChanges,
  SessionSummary,
  SettingsView,
  SidebarSnapshot,
  SkillInfo,
  WorkspaceInfo,
} from "../shared/ipc";

const PINNED_KEY = "monad-pinned-sessions";
const UNREAD_KEY = "monad-unread-sessions";
const COLLAPSED_SECTIONS_KEY = "monad-collapsed-thread-sections";
const SIDEBAR_COLLAPSED_KEY = "monad-sidebar-collapsed";

function loadIds(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
}

/** Unread survives restarts (localStorage, like pins): a briefing that ran
 *  overnight still shows its dot in the morning. */
function saveUnread(ids: string[]) {
  localStorage.setItem(UNREAD_KEY, JSON.stringify(ids));
}

export type RunState = "idle" | "running";

const RUN_OPTIONS_KEY = "monad-run-options";

function loadRunOptions(): Record<string, RunOptions> {
  try {
    const parsed = JSON.parse(localStorage.getItem(RUN_OPTIONS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export type { ArtifactState } from "../shared/artifacts";

/** Everything that belongs to ONE conversation Thread. Every Thread —
 *  visible or not — lives in `threads[id]`; the one on screen is just
 *  `activeThreadId`, so switching Threads changes one value. Streaming text
 *  has its own fields, so `items` (the structure) keeps its identity while
 *  deltas arrive. */
export type ThreadState = {
  items: ChatItem[];
  streamingText: string;
  streamingThinking: string;
  runState: RunState;
  activeRunId: string | null;
  resumeSessionId: string | null;
  contextUsage: { tokens: number; processed: number; window: number | null };
  statusLine: string;
  /** SDK-reported model id of the run in flight — shown in the composer only
   *  when it isn't just the picked model resolved (see isPickedModel). */
  runModel: string | null;
  composerDraft: string;
  artifacts: Record<string, ArtifactState>;
  activeArtifact: { id: string; version: number } | null;
  artifactPanelOpen: boolean;
  /** History is in (or the Thread is new). False while it loads: the chat
   *  shows a skeleton, and stream events wait in `pending`. */
  loaded: boolean;
  /** Stream events that arrived before the history, replayed on top of it. */
  pending: AgentStreamEvent[];
  /** A stream batch went missing while this Thread's run streamed: its
   *  transcript is reloaded from disk once the run ends. */
  stale: boolean;
  /** Transcript scroll position to restore on reopen (PR 5). */
  scrollOffset: number | null;
};

/** Client-side unique id (thread keys, run ids). crypto.randomUUID needs a
 *  secure context, which a custom-scheme webview may not be — so roll one. */
export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Idle, loaded Threads kept in memory besides the active one and any with
 *  a run in flight. An evicted Thread just loads again on the next open. */
const IDLE_THREADS_MAX = 20;

/** When each Thread was last on screen (a counter, not a clock) — only
 *  eviction reads it, so it stays out of the store: a switch then changes
 *  nothing but activeThreadId. */
const lastUsed = new Map<string, number>();
let useClock = 0;
const touch = (id: string) => void lastUsed.set(id, ++useClock);

function emptyThread(
  window: number | null,
  resumeSessionId: string | null = null,
  loaded = true,
): ThreadState {
  return {
    items: [],
    streamingText: "",
    streamingThinking: "",
    runState: "idle",
    activeRunId: null,
    resumeSessionId,
    // Window size survives — same model until the user changes it.
    contextUsage: { tokens: 0, processed: 0, window },
    statusLine: "",
    runModel: null,
    composerDraft: "",
    artifacts: {},
    activeArtifact: null,
    artifactPanelOpen: false,
    loaded,
    pending: [],
    stale: false,
    scrollOffset: null,
  };
}

/** The Thread on screen. Always present: every action that changes
 *  `activeThreadId` puts a Thread there. */
export function activeThread(s: {
  threads: Record<string, ThreadState>;
  activeThreadId: string;
}): ThreadState {
  return s.threads[s.activeThreadId];
}

/** Read the visible Thread: `useActiveThread((t) => t.items)`. */
export function useActiveThread<T>(selector: (t: ThreadState) => T): T {
  return useStore((s) => selector(activeThread(s)));
}

/** Read any Thread by id (undefined once it's evicted or deleted). */
export function useThread<T>(
  id: string,
  selector: (t: ThreadState | undefined) => T,
): T {
  return useStore((s) => selector(s.threads[id]));
}

type MonadState = {
  /** Id of the Thread on screen (a key of `threads`). */
  activeThreadId: string;
  /** Every Thread in memory: the active one, any with a run in flight, and
   *  up to IDLE_THREADS_MAX recently used idle ones. */
  threads: Record<string, ThreadState>;
  /** runId → thread key: routes every stream event to the thread that
   *  started the run, wherever the user is looking now. */
  runThreads: Record<string, string>;
  /** sessionId → runId for every run in flight (any thread) — the sidebar's
   *  spinner/needs-input source. */
  runningSessions: Record<string, string>;
  permissionQueue: PermissionRequest[];
  sessions: SessionSummary[];
  /** Threads for every workspace, keyed by workspace id (sidebar tree). */
  allSessions: Record<string, SessionSummary[]>;
  searchQuery: string;
  /** Search term to highlight in the open conversation — set when a thread is
   *  opened from a ⌘K content hit, cleared on normal opens/new chats. */
  highlightTerm: string | null;
  /** Model alias for new runs; "" = the provider's own default. Persisted locally. */
  model: string;
  /** Provider the picked model belongs to; null = the app's default provider. */
  modelProvider: ProviderId | null;
  /** Reasoning / context / speed picks per model, keyed by choiceKey —
   *  unset fields fall back to the model's defaults. Persisted locally. */
  runOptions: Record<string, RunOptions>;
  /** Skills in the active workspace (discoverability UI). */
  skills: SkillInfo[];
  /** Session ids the user pinned to the top of the thread list (persisted locally). */
  pinnedSessions: string[];
  /** Session ids with finished activity the user hasn't looked at yet — a run
   *  (interactive-in-another-thread or background) ended there since it was
   *  last open. The sidebar shows a dot; opening the thread clears it.
   *  Persisted locally so overnight briefings keep their dot. */
  unreadSessions: string[];
  /** Sidebar thread sections the user collapsed ("pinned", "briefings";
   *  persisted locally, like pins). */
  collapsedSections: SectionId[];
  workspaces: WorkspaceInfo[];
  settingsOpen: boolean;
  /** Section shown by the full-screen settings page. */
  settingsSection: string;
  /** The New workspace dialog in Settings → Workspaces; in the store so the
   *  sidebar's workspace picker can open it. */
  newWorkspaceOpen: boolean;
  settings: SettingsView | null;
  updateStatus: { status: string; message: string; progress?: number } | null;
  /** Latest drive status per workspace id, for the settings UI. */
  driveStatus: Record<string, DriveEvent>;
  inboxFiles: InboxFile[];
  /** Background ingest run in the active workspace (Inbox panel + composer). */
  ingest: IngestStatus;
  /** ANY background run (ingest/scheduled/prep) occupying the active
   *  workspace's run slot — composer busy label + abort target. */
  backgroundRun: BackgroundRunInfo | null;
  outboxFiles: OutboxFile[];
  /** Knowledge docs recent ingest runs added/updated, awaiting accept/reject. */
  reviewItems: ReviewItem[];
  /** Proactive health-check results (empty = all good). */
  healthIssues: HealthIssue[];
  /** Last known Claude CLI login (null until something asked). Sign-in cards
   *  and Settings read it; a finished in-app sign-in pushes the new value. */
  claudeAuth: ClaudeAuthStatus | null;
  /** Result of the latest in-app sign-in that finished without a pasted
   *  code (seq increments so the same result can be delivered twice). */
  claudeLoginResult: {
    seq: number;
    ok: boolean;
    email?: string;
    error?: string;
  } | null;
  knowledgeOpen: boolean;
  /** About dialog (opened from the native app menu). */
  aboutOpen: boolean;
  /** Doc to auto-open when the knowledge modal opens (clickable citations). */
  knowledgeInitialPath: string | null;
  /** Knowledge doc paths (relative to knowledge/), for linkifying citations. */
  knowledgePaths: string[];
  /** Local model (Ollama) state: installed models + RAM-fit verdicts. */
  ollama: OllamaStatus | null;
  /** Active model downloads keyed by Ollama tag (errors stick until retried). */
  pulls: Record<string, { status: string; percent?: number; error?: string }>;
  /** Sidebar hidden (⌘B / the chevron in the sidebar header). The width itself
   *  is owned by the resizable panel group, not this store. */
  sidebarCollapsed: boolean;
  /** Bumped whenever a Gmail draft is created/sent outside the Outbox panel,
   *  so the panel knows to re-fetch its drafts list. */
  gmailDraftsBump: number;

  /** Append an item to the visible Thread's transcript. */
  push: (item: ChatItem) => void;
  applyEvent: (e: AgentStreamEvent) => void;
  /** Apply a batch of stream events (one streamBatch) to whichever Threads
   *  they belong to, in a single store update. Returns the sessions whose
   *  Thread missed a batch and whose run just ended — reload them. */
  applyEvents: (batch: AgentStreamEvent[]) => string[];
  /** A stream batch went missing: every Thread with a run in flight may be
   *  short of events, so each reloads from disk when its run ends. */
  markStreamsStale: () => void;
  /** Forget a Thread's transcript so the next open reloads it from disk. */
  invalidateThread: (sessionId: string) => void;
  /** Bind a freshly minted runId to the active thread, BEFORE the startRun
   *  RPC goes out — stream events may beat the response back. */
  registerRun: (runId: string) => void;
  /** Forget a session's thread state (delete flow): stashed snapshot dropped,
   *  and if it is the open thread, a fresh chat replaces it. */
  dropThreadForSession: (sessionId: string) => void;
  /** Register the callback that pre-warms the agent session for the thread
   *  being opened (null = a fresh thread). Set by rpc; best-effort. */
  setPrewarmHandler: (fn: (resumeSessionId: string | null) => void) => void;
  applyDriveEvent: (e: DriveEvent) => void;
  enqueuePermission: (req: PermissionRequest) => void;
  removePermission: (requestId: string) => void;
  newChat: () => void;
  /** Show a Thread that's already in memory (loaded or loading) — no RPC,
   *  no copying: only activeThreadId changes. False when it isn't in memory. */
  switchToThread: (sessionId: string) => boolean;
  /** Show a Thread that isn't in memory yet, straight away and unloaded
   *  (skeleton) — its history is fetched by the caller (openHistory). */
  startThreadLoad: (sessionId: string) => void;
  /** Store a Thread's history under it (shown only if it's still the one on
   *  screen); events that arrived meanwhile replay on top. A Thread not in
   *  memory at all is created and shown. */
  openHistory: (
    sessionId: string,
    items: ChatItem[],
    contextTokens?: number,
  ) => void;
  /** The history fetch failed: drop the unloaded Thread (a fresh one takes
   *  its place if it was on screen). */
  abandonThreadLoad: (sessionId: string) => void;
  setSessions: (s: SessionSummary[]) => void;
  setAllSessions: (s: Record<string, SessionSummary[]>) => void;
  /** Targeted sidebar update pushed by bun: only the Thread rows that
   *  changed (upserted or removed), per workspace. */
  applySessionChanges: (changes: SessionChanges[]) => void;
  /** Every sidebar list at once (mount and workspace switch only). */
  applySidebarSnapshot: (snap: SidebarSnapshot) => void;
  setSearchQuery: (q: string) => void;
  setHighlightTerm: (term: string | null) => void;
  setModel: (m: string, provider?: ProviderId | null) => void;
  setRunOptions: (key: string, patch: RunOptions) => void;
  setComposerDraft: (t: string) => void;
  setSkills: (s: SkillInfo[]) => void;
  togglePin: (sessionId: string) => void;
  toggleSection: (id: SectionId) => void;
  /** Clear a thread's unread dot (the user is looking at it now). */
  markRead: (sessionId: string) => void;
  setWorkspaces: (w: WorkspaceInfo[]) => void;
  setRun: (state: RunState, runId?: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: string) => void;
  /** Open the settings page straight at one section (deep links from the UI). */
  openSettingsAt: (section: string) => void;
  setNewWorkspaceOpen: (open: boolean) => void;
  setSettings: (s: SettingsView) => void;
  setUpdateStatus: (
    u: { status: string; message: string; progress?: number } | null,
  ) => void;
  setInbox: (files: InboxFile[]) => void;
  setIngest: (status: IngestStatus) => void;
  setBackgroundRun: (run: BackgroundRunInfo | null) => void;
  setOutbox: (files: OutboxFile[]) => void;
  setReview: (items: ReviewItem[]) => void;
  setHealth: (issues: HealthIssue[]) => void;
  setClaudeAuth: (status: ClaudeAuthStatus | null) => void;
  setClaudeLoginResult: (r: {
    ok: boolean;
    email?: string;
    error?: string;
  }) => void;
  setKnowledgeOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  openKnowledgeAt: (path: string) => void;
  setKnowledgePaths: (paths: string[]) => void;
  openArtifact: (id: string, version?: number) => void;
  closeArtifactPanel: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  bumpGmailDrafts: () => void;
  setOllama: (status: OllamaStatus | null) => void;
  applyPullProgress: (p: {
    model: string;
    status: string;
    percent?: number;
    done?: boolean;
    error?: string;
  }) => void;
};

const bySession = (r: SessionSummary) => r.sessionId;

/** Thread lists by workspace id, unchanged rows and lists kept. */
function keepSessionsByWorkspace(
  prev: Record<string, SessionSummary[]>,
  next: Record<string, SessionSummary[]>,
): Record<string, SessionSummary[]> {
  return keepRecordIfEqual(prev, next, (p, n) =>
    keepListIfEqual(p, n, bySession),
  );
}

/** Upsert/remove Thread rows, newest first (the sidebar's order). */
export function applyRowChanges(
  rows: SessionSummary[],
  change: SessionChanges,
): SessionSummary[] {
  const drop = new Set([
    ...change.remove,
    ...change.upsert.map((r) => r.sessionId),
  ]);
  return [...change.upsert, ...rows.filter((r) => !drop.has(r.sessionId))].sort(
    (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
}

/** The store's starting point: one fresh Thread, on screen. */
function initialThreads(): Pick<MonadState, "threads" | "activeThreadId"> {
  const id = uid();
  return { activeThreadId: id, threads: { [id]: emptyThread(null) } };
}

/** Set by rpc.ts at init (kept out of state to avoid a circular import):
 *  opening a thread — fresh or resumed — boots its agent session early so the
 *  first message skips the CLI cold start. */
let prewarmHandler: (resumeSessionId: string | null) => void = () => {};

function threadIdFor(
  s: Pick<MonadState, "threads">,
  sessionId: string,
): string | undefined {
  return Object.entries(s.threads).find(
    ([, t]) => t.resumeSessionId === sessionId,
  )?.[0];
}

/** `threads` with the memory bound applied: Threads no one can reopen
 *  (never got a session, no run) go, then the least recently used idle
 *  loaded ones beyond IDLE_THREADS_MAX. The active Thread, Threads with a
 *  run in flight and Threads still loading stay. Same object back when
 *  nothing goes. */
function settleThreads(
  threads: Record<string, ThreadState>,
  activeId: string,
): Record<string, ThreadState> {
  const drop: string[] = [];
  const idle: string[] = [];
  for (const [id, t] of Object.entries(threads)) {
    if (id === activeId || t.runState === "running" || !t.loaded) continue;
    if (!t.resumeSessionId) drop.push(id);
    else idle.push(id);
  }
  idle.sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
  drop.push(...idle.slice(0, Math.max(0, idle.length - IDLE_THREADS_MAX)));
  if (!drop.length) return threads;
  const out = { ...threads };
  for (const id of drop) {
    delete out[id];
    lastUsed.delete(id);
  }
  return out;
}

/** Make `id` the Thread on screen. */
function activate(
  s: MonadState,
  id: string,
  threads: Record<string, ThreadState> = s.threads,
): Pick<MonadState, "threads" | "activeThreadId"> {
  touch(s.activeThreadId); // in use until now
  touch(id);
  return { activeThreadId: id, threads: settleThreads(threads, id) };
}

/** Patch the visible Thread. */
function patchActive(
  s: MonadState,
  patch: Partial<ThreadState>,
): Pick<MonadState, "threads"> {
  const t = activeThread(s);
  return { threads: { ...s.threads, [s.activeThreadId]: { ...t, ...patch } } };
}

/** The context window to carry into a new Thread (same model until the user
 *  changes it). */
const carriedWindow = (s: MonadState) =>
  activeThread(s)?.contextUsage.window ?? null;

/** Pure per-thread event reducer — the same transitions whether the thread is
 *  on screen (top-level state) or stashed in `threads`. Cross-thread effects
 *  (permission queue, running-session bookkeeping) live in applyEvent. */
function reduceThread(
  t: ThreadState,
  e: AgentStreamEvent,
): Partial<ThreadState> {
  switch (e.kind) {
    case "run-started":
      // adopt the session id immediately so the thread highlights in the
      // sidebar and follow-ups resume the same session
      return {
        activeRunId: e.runId || t.activeRunId,
        statusLine: e.model ? "" : "running",
        runModel: e.model || null,
        resumeSessionId: e.sessionId || t.resumeSessionId,
      };
    case "text-delta":
      return { streamingText: t.streamingText + e.text };
    case "thinking-delta":
      return { streamingThinking: t.streamingThinking + e.text };
    case "text":
      // Authoritative complete block — replaces the streamed tail.
      return {
        items: [...t.items, { type: "assistant", text: e.text }],
        streamingText: "",
      };
    case "thinking":
      return {
        items: [...t.items, { type: "thinking", text: e.text }],
        streamingThinking: "",
      };
    case "tool-call":
      return {
        items: [
          ...t.items,
          {
            type: "tool",
            toolUseId: e.toolUseId,
            name: e.name,
            inputSummary: e.inputSummary,
            pending: true,
          },
        ],
      };
    case "tool-result":
      return {
        items: t.items.map((i) =>
          i.type === "tool" && i.toolUseId === e.toolUseId
            ? { ...i, output: e.output, isError: e.isError, pending: false }
            : i,
        ),
      };
    case "artifact": {
      const prior = t.artifacts[e.artifactId];
      const versions = [...(prior?.versions ?? []), e.content];
      return {
        items: [
          ...t.items,
          {
            type: "artifact",
            artifactId: e.artifactId,
            artifactType: e.artifactType,
            title: e.title,
            op: e.op,
            content: e.content,
          },
        ],
        artifacts: {
          ...t.artifacts,
          [e.artifactId]: { title: e.title, type: e.artifactType, versions },
        },
        // Follow the agent's latest work in the panel.
        activeArtifact: { id: e.artifactId, version: versions.length - 1 },
        artifactPanelOpen: true,
      };
    }
    case "email-draft":
      return { items: [...t.items, { type: "email-draft", draft: e.draft }] };
    case "image":
      return {
        items: [...t.items, { type: "image", path: e.path, name: e.name }],
      };
    case "usage":
      return {
        contextUsage: {
          ...t.contextUsage,
          tokens: e.contextTokens,
          processed: t.contextUsage.processed + e.contextTokens,
        },
      };
    case "run-finished":
      return {
        runState: "idle",
        activeRunId: null,
        streamingText: "",
        streamingThinking: "",
        resumeSessionId: e.sessionId,
        contextUsage: {
          ...t.contextUsage,
          window: e.contextWindow ?? t.contextUsage.window,
        },
        statusLine: `${e.numTurns} turns${e.costUsd ? ` · $${e.costUsd.toFixed(3)}` : ""}`,
        runModel: null,
        // The CLI already narrated a generic failure as assistant text; only
        // a lost login gets an extra card, because that one has a fix.
        ...(e.needsLogin && e.error
          ? { items: [...t.items, { type: "login-needed", text: e.error }] }
          : {}),
      };
    case "run-error":
      return {
        runState: "idle",
        activeRunId: null,
        streamingText: "",
        streamingThinking: "",
        items: [
          ...t.items,
          e.needsLogin
            ? { type: "login-needed", text: e.error }
            : { type: "error", text: e.error },
        ],
      };
  }
}

/** One stream event's effect on the store: its Thread's transitions (routed
 *  by runId, visible or not) plus the cross-thread bookkeeping. Null when
 *  the event has nowhere to land. `resync` names a stale Thread's session
 *  whose run just ended. */
function stepEvent(
  s: MonadState,
  e: AgentStreamEvent,
): { patch: Partial<MonadState>; resync?: string } | null {
  const runId = e.runId;
  // Route by the run's own thread. Unknown runId = a run this UI never
  // started or one already finished — its stragglers have nowhere to land.
  const key = runId ? s.runThreads[runId] : undefined;
  if (!key) return null;
  const global: Partial<MonadState> = {};
  const ended = e.kind === "run-finished" || e.kind === "run-error";
  if (e.kind === "run-started" && e.sessionId) {
    global.runningSessions = {
      ...s.runningSessions,
      [e.sessionId]: e.runId,
    };
  }
  if (ended) {
    // A run that ended can no longer be answered — drop its stale cards,
    // its sidebar spinner, and (last event by contract) its routing entry.
    global.permissionQueue = s.permissionQueue.filter((r) => r.runId !== runId);
    const running = { ...s.runningSessions };
    for (const [sid, rid] of Object.entries(running)) {
      if (rid === runId) delete running[sid];
    }
    global.runningSessions = running;
    const routes = { ...s.runThreads };
    delete routes[runId];
    global.runThreads = routes;
    // A run that ended off-screen is news the user hasn't seen — dot the
    // thread. On-screen finishes need no dot, and an abort is the user's
    // own deliberate stop, not something to flag.
    const endedSessionId =
      e.kind === "run-finished"
        ? e.sessionId
        : Object.entries(s.runningSessions).find(
            ([, rid]) => rid === runId,
          )?.[0];
    const aborted = e.kind === "run-error" && e.aborted;
    if (
      endedSessionId &&
      !aborted &&
      key !== s.activeThreadId &&
      !s.unreadSessions.includes(endedSessionId)
    ) {
      global.unreadSessions = [...s.unreadSessions, endedSessionId];
      saveUnread(global.unreadSessions);
    }
  }
  const t = s.threads[key];
  if (!t) return { patch: global };
  // Still loading: the event waits for the history (replayed on top of it).
  const next: ThreadState = t.loaded
    ? { ...t, ...reduceThread(t, e) }
    : { ...t, pending: [...t.pending, e] };
  const resync =
    ended && t.stale && t.loaded
      ? (next.resumeSessionId ?? undefined)
      : undefined;
  return {
    patch: { ...global, threads: { ...s.threads, [key]: next } },
    resync,
  };
}

export const useStore = create<MonadState>((set, get) => ({
  ...initialThreads(),
  runThreads: {},
  runningSessions: {},
  permissionQueue: [],
  sessions: [],
  allSessions: {},
  searchQuery: "",
  highlightTerm: null,
  model: localStorage.getItem("monad-model") ?? "",
  modelProvider:
    (localStorage.getItem("monad-model-provider") as ProviderId) || null,
  runOptions: loadRunOptions(),
  skills: [],
  pinnedSessions: loadIds(PINNED_KEY),
  unreadSessions: loadIds(UNREAD_KEY),
  collapsedSections: loadIds(COLLAPSED_SECTIONS_KEY) as SectionId[],
  workspaces: [],
  settingsOpen: false,
  settingsSection: "workspaces",
  newWorkspaceOpen: false,
  settings: null,
  updateStatus: null,
  driveStatus: {},
  inboxFiles: [],
  ingest: { active: false, files: [] },
  backgroundRun: null,
  outboxFiles: [],
  reviewItems: [],
  healthIssues: [],
  claudeAuth: null,
  claudeLoginResult: null,
  knowledgeOpen: false,
  aboutOpen: false,
  knowledgeInitialPath: null,
  knowledgePaths: [],
  ollama: null,
  pulls: {},
  sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
  gmailDraftsBump: 0,

  push: (item) =>
    set((s) => patchActive(s, { items: [...activeThread(s).items, item] })),

  setPrewarmHandler: (fn) => {
    prewarmHandler = fn;
  },

  registerRun: (runId) =>
    set((s) => ({
      runThreads: { ...s.runThreads, [runId]: s.activeThreadId },
    })),

  applyEvent: (e) => void get().applyEvents([e]),

  applyEvents: (batch) => {
    // One set() for the whole batch: each event's patch lands on a working
    // copy the next event reads from, and subscribers hear about it once.
    const work = { ...get() };
    const patch: Partial<MonadState> = {};
    const resync: string[] = [];
    for (const e of batch) {
      const step = stepEvent(work, e);
      if (!step) continue;
      Object.assign(work, step.patch);
      Object.assign(patch, step.patch);
      if (step.resync) resync.push(step.resync);
    }
    if (Object.keys(patch).length) set(patch);
    return resync;
  },

  markStreamsStale: () =>
    set((s) => {
      const threads = { ...s.threads };
      for (const [id, t] of Object.entries(threads))
        if (t.runState === "running") threads[id] = { ...t, stale: true };
      return { threads };
    }),

  invalidateThread: (sessionId) =>
    set((s) => {
      const id = threadIdFor(s, sessionId);
      if (!id) return {};
      const t = s.threads[id];
      return {
        threads: {
          ...s.threads,
          [id]: {
            ...emptyThread(t.contextUsage.window, sessionId, false),
            composerDraft: t.composerDraft,
          },
        },
      };
    }),

  applyDriveEvent: (e) =>
    set((s) => ({ driveStatus: { ...s.driveStatus, [e.workspaceId]: e } })),

  enqueuePermission: (req) =>
    set((s) => ({ permissionQueue: [...s.permissionQueue, req] })),
  removePermission: (requestId) =>
    set((s) => ({
      permissionQueue: s.permissionQueue.filter(
        (r) => r.requestId !== requestId,
      ),
    })),

  newChat: () => {
    // Leaving a running thread doesn't abort it — the run keeps streaming
    // into its own Thread, and the sidebar spinner tracks it.
    const id = uid();
    set((s) => ({
      ...activate(s, id, {
        ...s.threads,
        [id]: emptyThread(carriedWindow(s)),
      }),
      highlightTerm: null,
    }));
    prewarmHandler(null);
  },

  markRead: (sessionId) =>
    set((s) => {
      if (!s.unreadSessions.includes(sessionId)) return {};
      const unreadSessions = s.unreadSessions.filter((id) => id !== sessionId);
      saveUnread(unreadSessions);
      return { unreadSessions };
    }),

  switchToThread: (sessionId) => {
    const id = threadIdFor(get(), sessionId);
    if (!id) return false;
    get().markRead(sessionId);
    set((s) => activate(s, id));
    // A running thread already has its live session — prewarming would boot
    // a pointless second process next to it.
    const t = get().threads[id];
    if (t.runState !== "running") prewarmHandler(sessionId);
    return true;
  },

  startThreadLoad: (sessionId) => {
    if (get().switchToThread(sessionId)) return;
    get().markRead(sessionId);
    const id = uid();
    set((s) => ({
      ...activate(s, id, {
        ...s.threads,
        [id]: emptyThread(carriedWindow(s), sessionId, false),
      }),
    }));
    // Boot the agent session while the history loads.
    prewarmHandler(sessionId);
  },

  openHistory: (sessionId, items, contextTokens) => {
    const known = threadIdFor(get(), sessionId);
    if (!known) {
      // Not in memory at all: create it, already loaded, and show it.
      get().startThreadLoad(sessionId);
    }
    set((s) => {
      const id = threadIdFor(s, sessionId);
      if (!id) return {};
      const t = s.threads[id];
      // Loaded meanwhile (or already): the live Thread wins over disk.
      if (t.loaded) return {};
      // History first, then anything added while it loaded (the user's own
      // message), then the stream events that waited for it.
      let next: ThreadState = {
        ...t,
        items: [...items, ...t.items],
        // Resume the meter from the thread's persisted usage; the next run's
        // own usage events take over from there.
        contextUsage: {
          tokens: contextTokens ?? 0,
          processed: contextTokens ?? 0,
          window: t.contextUsage.window,
        },
        artifacts: deriveArtifacts(items),
        loaded: true,
        pending: [],
      };
      for (const e of t.pending) next = { ...next, ...reduceThread(next, e) };
      return { threads: { ...s.threads, [id]: next } };
    });
  },

  abandonThreadLoad: (sessionId) => {
    const id = threadIdFor(get(), sessionId);
    if (!id || get().threads[id].loaded) return;
    const dropped = get().threads[id];
    if (get().activeThreadId === id) {
      get().newChat();
      // Keep what was shown on the skeleton's Thread (request()'s error).
      set((s) => patchActive(s, { items: dropped.items }));
    }
    set((s) => {
      const threads = { ...s.threads };
      delete threads[id];
      return { threads };
    });
  },

  dropThreadForSession: (sessionId) => {
    get().markRead(sessionId); // a deleted thread keeps no dot
    if (activeThread(get()).resumeSessionId === sessionId) get().newChat();
    set((s) => {
      const threads = { ...s.threads };
      for (const [k, t] of Object.entries(threads)) {
        if (t.resumeSessionId === sessionId) delete threads[k];
      }
      return { threads };
    });
  },

  openArtifact: (id, version) =>
    set((s) => {
      const art = activeThread(s).artifacts[id];
      if (!art) return {};
      const last = art.versions.length - 1;
      return patchActive(s, {
        activeArtifact: {
          id,
          version: Math.max(0, Math.min(version ?? last, last)),
        },
        artifactPanelOpen: true,
      });
    }),
  closeArtifactPanel: () =>
    set((s) => patchActive(s, { artifactPanelOpen: false })),
  setSidebarCollapsed: (sidebarCollapsed) => {
    if (get().sidebarCollapsed === sidebarCollapsed) return;
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    set({ sidebarCollapsed });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  bumpGmailDrafts: () =>
    set((s) => ({ gmailDraftsBump: s.gmailDraftsBump + 1 })),

  setSessions: (sessions) =>
    set((s) => ({
      sessions: keepListIfEqual(s.sessions, sessions, bySession),
    })),
  setAllSessions: (allSessions) =>
    set((s) => ({
      allSessions: keepSessionsByWorkspace(s.allSessions, allSessions),
    })),
  applySessionChanges: (changes) =>
    set((s) => {
      const allSessions = { ...s.allSessions };
      for (const c of changes) {
        allSessions[c.workspaceId] = applyRowChanges(
          allSessions[c.workspaceId] ?? [],
          c,
        );
      }
      const activeId = s.workspaces.find((w) => w.active)?.id;
      return {
        allSessions: keepSessionsByWorkspace(s.allSessions, allSessions),
        ...(activeId && changes.some((c) => c.workspaceId === activeId)
          ? {
              sessions: keepListIfEqual(
                s.sessions,
                allSessions[activeId] ?? [],
                bySession,
              ),
            }
          : {}),
      };
    }),
  applySidebarSnapshot: (snap) => {
    const st = get();
    st.setWorkspaces(snap.workspaces);
    st.setAllSessions(snap.byWorkspace);
    const active = snap.workspaces.find((w) => w.active);
    st.setSessions(active ? (snap.byWorkspace[active.id] ?? []) : []);
    st.setInbox(snap.inbox);
    st.setIngest(snap.ingest);
    st.setBackgroundRun(snap.background);
    st.setOutbox(snap.outbox);
    st.setSkills(snap.skills);
    st.setKnowledgePaths(snap.knowledgePaths);
    st.setReview(snap.review);
    st.setHealth(snap.health);
  },
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setHighlightTerm: (highlightTerm) => set({ highlightTerm }),
  setRunOptions: (key, patch) =>
    set((s) => {
      const runOptions = {
        ...s.runOptions,
        [key]: { ...s.runOptions[key], ...patch },
      };
      localStorage.setItem(RUN_OPTIONS_KEY, JSON.stringify(runOptions));
      return { runOptions };
    }),
  setModel: (model, provider = null) => {
    localStorage.setItem("monad-model", model);
    if (provider) localStorage.setItem("monad-model-provider", provider);
    else localStorage.removeItem("monad-model-provider");
    set({ model, modelProvider: provider });
  },
  setComposerDraft: (composerDraft) =>
    set((s) => patchActive(s, { composerDraft })),
  setSkills: (skills) =>
    set((s) => ({ skills: keepListIfEqual(s.skills, skills, (k) => k.name) })),
  togglePin: (sessionId) =>
    set((s) => {
      const pinnedSessions = s.pinnedSessions.includes(sessionId)
        ? s.pinnedSessions.filter((id) => id !== sessionId)
        : [...s.pinnedSessions, sessionId];
      localStorage.setItem(PINNED_KEY, JSON.stringify(pinnedSessions));
      return { pinnedSessions };
    }),
  toggleSection: (id) =>
    set((s) => {
      const collapsedSections = s.collapsedSections.includes(id)
        ? s.collapsedSections.filter((x) => x !== id)
        : [...s.collapsedSections, id];
      localStorage.setItem(
        COLLAPSED_SECTIONS_KEY,
        JSON.stringify(collapsedSections),
      );
      return { collapsedSections };
    }),
  setWorkspaces: (workspaces) =>
    set((s) => ({
      workspaces: keepListIfEqual(s.workspaces, workspaces, (w) => w.id),
    })),
  setRun: (runState, activeRunId = null) =>
    set((s) => patchActive(s, { runState, activeRunId })),
  // Leaving settings or the section drops the New workspace dialog, so it
  // doesn't pop back open on the next visit.
  setSettingsOpen: (settingsOpen) =>
    set({ settingsOpen, newWorkspaceOpen: false }),
  setSettingsSection: (settingsSection) =>
    set({ settingsSection, newWorkspaceOpen: false }),
  openSettingsAt: (settingsSection) =>
    set({ settingsOpen: true, settingsSection, newWorkspaceOpen: false }),
  setNewWorkspaceOpen: (newWorkspaceOpen) => set({ newWorkspaceOpen }),
  setSettings: (settings) =>
    set((s) => ({ settings: keepIfEqual(s.settings, settings) })),
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setInbox: (inboxFiles) =>
    set((s) => ({
      inboxFiles: keepListIfEqual(s.inboxFiles, inboxFiles, (f) => f.name),
    })),
  setIngest: (ingest) =>
    set((s) => ({ ingest: keepIfEqual(s.ingest, ingest) })),
  // Background runs (briefing/scheduled/prep) never route through applyEvent
  // (the UI didn't start them), so their "finished" moment is the run leaving
  // this slot — dot the thread it produced unless the user is looking at it.
  setBackgroundRun: (next) =>
    set((s) => {
      const prev = s.backgroundRun;
      const run = keepIfEqual(prev, next);
      if (run === prev) return {};
      const endedSessionId =
        prev?.runId !== run?.runId ? prev?.sessionId : undefined;
      if (
        !endedSessionId ||
        endedSessionId === activeThread(s).resumeSessionId ||
        s.unreadSessions.includes(endedSessionId)
      ) {
        return { backgroundRun: run };
      }
      const unreadSessions = [...s.unreadSessions, endedSessionId];
      saveUnread(unreadSessions);
      return { backgroundRun: run, unreadSessions };
    }),
  setOutbox: (outboxFiles) =>
    set((s) => ({
      outboxFiles: keepListIfEqual(s.outboxFiles, outboxFiles, (f) => f.name),
    })),
  setReview: (reviewItems) =>
    set((s) => ({
      reviewItems: keepListIfEqual(s.reviewItems, reviewItems, (r) => r.path),
    })),
  setHealth: (healthIssues) =>
    set((s) => ({ healthIssues: keepIfEqual(s.healthIssues, healthIssues) })),
  setClaudeAuth: (claudeAuth) => set({ claudeAuth }),
  setClaudeLoginResult: (r) =>
    set((s) => ({
      claudeLoginResult: { ...r, seq: (s.claudeLoginResult?.seq ?? 0) + 1 },
    })),
  setKnowledgeOpen: (knowledgeOpen) =>
    set(
      knowledgeOpen
        ? { knowledgeOpen }
        : { knowledgeOpen, knowledgeInitialPath: null },
    ),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  openKnowledgeAt: (knowledgeInitialPath) =>
    set({ knowledgeOpen: true, knowledgeInitialPath }),
  setKnowledgePaths: (knowledgePaths) =>
    set((s) => ({
      knowledgePaths: keepIfEqual(s.knowledgePaths, knowledgePaths),
    })),

  setOllama: (ollama) => set({ ollama }),
  applyPullProgress: (p) =>
    set((s) => {
      const pulls = { ...s.pulls };
      if (p.done && !p.error) {
        delete pulls[p.model]; // finished — the refreshed status shows it installed
      } else {
        pulls[p.model] = {
          status: p.status,
          percent: p.percent,
          error: p.error,
        };
      }
      return { pulls };
    }),
}));
