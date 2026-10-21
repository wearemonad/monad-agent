import { create } from "zustand";
import { deriveArtifacts, type ArtifactState } from "../shared/artifacts";
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
  SessionSummary,
  SettingsView,
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

/** Everything that belongs to ONE conversation thread. The active thread's
 *  snapshot is spread across the store's top-level fields (so components keep
 *  their simple selectors); switching threads stashes the current snapshot
 *  into `threads` and restores (or builds) the next one. A thread with a run
 *  still streaming keeps receiving events in its stashed snapshot — parallel
 *  threads are the point of this shape. */
export type ThreadSnapshot = {
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
};

/** Client-side unique id (thread keys, run ids). crypto.randomUUID needs a
 *  secure context, which a custom-scheme webview may not be — so roll one. */
export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Stashed idle threads reload from disk when reopened, so keep only a few
 *  around (running ones always stay — they hold live state disk doesn't). */
const IDLE_STASH_MAX = 8;

function emptyThread(window: number | null): ThreadSnapshot {
  return {
    items: [],
    streamingText: "",
    streamingThinking: "",
    runState: "idle",
    activeRunId: null,
    resumeSessionId: null,
    // Window size survives — same model until the user changes it.
    contextUsage: { tokens: 0, processed: 0, window },
    statusLine: "",
    runModel: null,
    composerDraft: "",
    artifacts: {},
    activeArtifact: null,
    artifactPanelOpen: false,
  };
}

type MonadState = ThreadSnapshot & {
  /** Key of the thread currently on screen (its snapshot lives at top level). */
  activeThreadKey: string;
  /** Snapshots of every NON-active thread that must survive a switch: those
   *  with a run streaming, plus a bounded set of recently-left idle ones. */
  threads: Record<string, ThreadSnapshot>;
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

  push: (item: ChatItem) => void;
  applyEvent: (e: AgentStreamEvent) => void;
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
  openHistory: (
    sessionId: string,
    items: ChatItem[],
    contextTokens?: number,
  ) => void;
  setSessions: (s: SessionSummary[]) => void;
  setAllSessions: (s: Record<string, SessionSummary[]>) => void;
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

/** Set by rpc.ts at init (kept out of state to avoid a circular import):
 *  opening a thread — fresh or resumed — boots its agent session early so the
 *  first message skips the CLI cold start. */
let prewarmHandler: (resumeSessionId: string | null) => void = () => {};

/** The active thread's snapshot, lifted back out of the top-level fields. */
function snapshotOf(s: MonadState): ThreadSnapshot {
  return {
    items: s.items,
    streamingText: s.streamingText,
    streamingThinking: s.streamingThinking,
    runState: s.runState,
    activeRunId: s.activeRunId,
    resumeSessionId: s.resumeSessionId,
    contextUsage: s.contextUsage,
    statusLine: s.statusLine,
    runModel: s.runModel,
    composerDraft: s.composerDraft,
    artifacts: s.artifacts,
    activeArtifact: s.activeArtifact,
    artifactPanelOpen: s.artifactPanelOpen,
  };
}

/** The `threads` map after leaving the active thread: a running thread is
 *  stashed (its live state exists nowhere else); an idle one is dropped —
 *  reopening it reloads from disk, same as before parallel threads existed.
 *  Idle leftovers (runs that finished while stashed) are capped, oldest-ish
 *  first; `protect` (the snapshot about to be restored) is never dropped. */
function stashThreads(
  s: MonadState,
  protect?: string,
): Record<string, ThreadSnapshot> {
  const threads = { ...s.threads };
  const idle = Object.keys(threads).filter(
    (k) => k !== protect && threads[k].runState !== "running",
  );
  for (const k of idle.slice(0, Math.max(0, idle.length - IDLE_STASH_MAX))) {
    delete threads[k];
  }
  if (s.runState === "running") threads[s.activeThreadKey] = snapshotOf(s);
  return threads;
}

/** Pure per-thread event reducer — the same transitions whether the thread is
 *  on screen (top-level state) or stashed in `threads`. Cross-thread effects
 *  (permission queue, running-session bookkeeping) live in applyEvent. */
function reduceThread(
  t: ThreadSnapshot,
  e: AgentStreamEvent,
): Partial<ThreadSnapshot> {
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

export const useStore = create<MonadState>((set, get) => ({
  ...emptyThread(null),
  activeThreadKey: uid(),
  threads: {},
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

  push: (item) => set((s) => ({ items: [...s.items, item] })),

  setPrewarmHandler: (fn) => {
    prewarmHandler = fn;
  },

  registerRun: (runId) =>
    set((s) => ({
      runThreads: { ...s.runThreads, [runId]: s.activeThreadKey },
    })),

  applyEvent: (e) => {
    const s = get();
    const runId = "runId" in e ? e.runId : "";
    // Route by the run's own thread. Unknown runId = a run this UI never
    // started or one already finished — its stragglers have nowhere to land.
    const key = runId ? s.runThreads[runId] : undefined;
    if (!key) return;
    const global: Partial<MonadState> = {};
    if (e.kind === "run-started" && e.sessionId) {
      global.runningSessions = {
        ...s.runningSessions,
        [e.sessionId]: e.runId,
      };
    }
    if (e.kind === "run-finished" || e.kind === "run-error") {
      // A run that ended can no longer be answered — drop its stale cards,
      // its sidebar spinner, and (last event by contract) its routing entry.
      global.permissionQueue = s.permissionQueue.filter(
        (r) => r.runId !== runId,
      );
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
        key !== s.activeThreadKey &&
        !s.unreadSessions.includes(endedSessionId)
      ) {
        global.unreadSessions = [...s.unreadSessions, endedSessionId];
        saveUnread(global.unreadSessions);
      }
    }
    if (key === s.activeThreadKey) {
      set({ ...global, ...reduceThread(snapshotOf(s), e) });
    } else {
      const t = s.threads[key];
      set(
        t
          ? {
              ...global,
              threads: { ...s.threads, [key]: { ...t, ...reduceThread(t, e) } },
            }
          : global,
      );
    }
  },

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
    // Leaving a running thread no longer aborts it — the run keeps streaming
    // into its stashed snapshot, and the sidebar spinner tracks it.
    set((s) => ({
      threads: stashThreads(s),
      activeThreadKey: uid(),
      ...emptyThread(s.contextUsage.window),
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

  openHistory: (sessionId, items, contextTokens) => {
    get().markRead(sessionId);
    let restoredRunning = false;
    set((s) => {
      // A stashed thread for this session — running or recently finished —
      // wins over the fetched history: it has the live streaming state.
      const found = Object.entries(s.threads).find(
        ([, t]) => t.resumeSessionId === sessionId,
      );
      const threads = stashThreads(s, found?.[0]);
      if (found) {
        const [key, snap] = found;
        delete threads[key];
        restoredRunning = snap.runState === "running";
        return { threads, activeThreadKey: key, ...snap };
      }
      return {
        threads,
        activeThreadKey: uid(),
        items,
        streamingText: "",
        streamingThinking: "",
        // Switching threads drops the half-typed message; re-opening the same
        // thread keeps it.
        composerDraft: sessionId === s.resumeSessionId ? s.composerDraft : "",
        resumeSessionId: sessionId,
        // Resume the meter from the thread's persisted usage; the next run's
        // own usage events take over from there. Threads without usage (or an
        // older bun process not sending it) fall back to 0 as before.
        contextUsage: {
          tokens: contextTokens ?? 0,
          processed: contextTokens ?? 0,
          window: s.contextUsage.window,
        },
        runState: "idle",
        activeRunId: null,
        statusLine: "",
        runModel: null,
        artifacts: deriveArtifacts(items),
        activeArtifact: null,
        artifactPanelOpen: false,
      };
    });
    // A restored running thread already has its live session — prewarming
    // would boot a pointless second process next to it.
    if (!restoredRunning) prewarmHandler(sessionId);
  },

  dropThreadForSession: (sessionId) => {
    get().markRead(sessionId); // a deleted thread keeps no dot
    set((s) => {
      const threads = { ...s.threads };
      for (const [k, t] of Object.entries(threads)) {
        if (t.resumeSessionId === sessionId) delete threads[k];
      }
      return { threads };
    });
    if (get().resumeSessionId === sessionId) get().newChat();
  },

  openArtifact: (id, version) =>
    set((s) => {
      const art = s.artifacts[id];
      if (!art) return {};
      const last = art.versions.length - 1;
      return {
        activeArtifact: {
          id,
          version: Math.max(0, Math.min(version ?? last, last)),
        },
        artifactPanelOpen: true,
      };
    }),
  closeArtifactPanel: () => set({ artifactPanelOpen: false }),
  setSidebarCollapsed: (sidebarCollapsed) => {
    if (get().sidebarCollapsed === sidebarCollapsed) return;
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    set({ sidebarCollapsed });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  bumpGmailDrafts: () =>
    set((s) => ({ gmailDraftsBump: s.gmailDraftsBump + 1 })),

  setSessions: (sessions) => set({ sessions }),
  setAllSessions: (allSessions) => set({ allSessions }),
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
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  setSkills: (skills) => set({ skills }),
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
  setWorkspaces: (workspaces) => set({ workspaces }),
  setRun: (runState, activeRunId = null) => set({ runState, activeRunId }),
  // Leaving settings or the section drops the New workspace dialog, so it
  // doesn't pop back open on the next visit.
  setSettingsOpen: (settingsOpen) =>
    set({ settingsOpen, newWorkspaceOpen: false }),
  setSettingsSection: (settingsSection) =>
    set({ settingsSection, newWorkspaceOpen: false }),
  openSettingsAt: (settingsSection) =>
    set({ settingsOpen: true, settingsSection, newWorkspaceOpen: false }),
  setNewWorkspaceOpen: (newWorkspaceOpen) => set({ newWorkspaceOpen }),
  setSettings: (settings) => set({ settings }),
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setInbox: (inboxFiles) => set({ inboxFiles }),
  setIngest: (ingest) => set({ ingest }),
  // Background runs (briefing/scheduled/prep) never route through applyEvent
  // (the UI didn't start them), so their "finished" moment is the run leaving
  // this slot — dot the thread it produced unless the user is looking at it.
  setBackgroundRun: (run) =>
    set((s) => {
      const prev = s.backgroundRun;
      const endedSessionId =
        prev?.runId !== run?.runId ? prev?.sessionId : undefined;
      if (
        !endedSessionId ||
        endedSessionId === s.resumeSessionId ||
        s.unreadSessions.includes(endedSessionId)
      ) {
        return { backgroundRun: run };
      }
      const unreadSessions = [...s.unreadSessions, endedSessionId];
      saveUnread(unreadSessions);
      return { backgroundRun: run, unreadSessions };
    }),
  setOutbox: (outboxFiles) => set({ outboxFiles }),
  setReview: (reviewItems) => set({ reviewItems }),
  setHealth: (healthIssues) => set({ healthIssues }),
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
  setKnowledgePaths: (knowledgePaths) => set({ knowledgePaths }),

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
