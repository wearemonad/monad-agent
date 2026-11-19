import type { MonadRPC } from "../shared/ipc";
import { useStore } from "./store";

export type WebviewMessageHandlers = {
  [K in keyof MonadRPC["webview"]["messages"]]: (
    payload: MonadRPC["webview"]["messages"][K],
  ) => void;
};

export type MessageHandlerDeps = {
  /** Full sidebar snapshot — only for a workspace switch. */
  refreshSidebar: () => Promise<void>;
  /** A Thread missed a stream batch and its run has ended: reload it. */
  resyncThread: (sessionId: string) => void;
  /** Which of these runs bun still has in flight. */
  liveRuns: (runIds: string[]) => Promise<string[]>;
  getSettings: () => void;
  refreshOllama: () => void;
  zoom: (direction: "in" | "out" | "reset") => void;
};

/** Everything bun pushes to the webview, applied to the store. Bun sends
 *  every streaming Thread's events as one streamBatch per tick, applied in
 *  one store update; lifecycle events and permission requests are flushed
 *  by bun in order, so nothing here buffers. Sidebar lists arrive as
 *  targeted pushes — nothing here re-fetches them, except a workspace
 *  switch. */
export function createMessageHandlers(deps: MessageHandlerDeps): {
  handlers: WebviewMessageHandlers;
} {
  const store = () => useStore.getState();
  /** Last batch seq seen (null until the first: a reloaded webview joins
   *  bun's sequence midway). */
  let lastSeq: number | null = null;

  /** The lost batch may have held a run's end, which never comes again:
   *  ask bun which runs still stream and end the rest here (each is stale,
   *  so ending it resyncs it from disk). */
  async function closeLostRuns() {
    // Only runs bun has started (run-started seen): one the webview just
    // sent may not have reached bun yet.
    const { threads, runningSessions } = store();
    const started = new Set(Object.values(runningSessions));
    const running = Object.values(threads)
      .filter(
        (t) => t.runState === "running" && started.has(t.activeRunId ?? ""),
      )
      .map((t) => ({
        runId: t.activeRunId as string,
        sessionId: t.resumeSessionId,
      }));
    if (!running.length) return;
    const answer = await deps
      .liveRuns(running.map((r) => r.runId))
      .catch(() => null);
    if (!answer) return; // can't tell: the ordinary path still resyncs
    const live = new Set(answer);
    const ended = running.filter((r) => r.sessionId && !live.has(r.runId));
    if (!ended.length) return;
    // A run whose real end arrived meanwhile has no route left: ignored.
    const resync = store().applyEvents(
      ended.map((r) => ({
        kind: "run-finished" as const,
        runId: r.runId,
        sessionId: r.sessionId as string,
        numTurns: 0,
      })),
    );
    for (const sessionId of resync) deps.resyncThread(sessionId);
  }

  const handlers: WebviewMessageHandlers = {
    streamBatch: ({ seq, runs }) => {
      // A gap means a batch never arrived: every streaming Thread may be
      // short, so each reloads from disk once its run ends.
      const gap = lastSeq !== null && seq !== lastSeq + 1;
      if (gap) store().markStreamsStale();
      lastSeq = seq;
      const resync = store().applyEvents(runs.flatMap((r) => r.events));
      for (const sessionId of resync) deps.resyncThread(sessionId);
      if (gap) void closeLostRuns();
    },
    permissionRequest: (req) => store().enqueuePermission(req),
    workspaceChanged: () => {
      store().newChat();
      void deps.refreshSidebar();
    },
    workspacesUpdated: ({ workspaces }) => store().setWorkspaces(workspaces),
    driveEvent: (e) => store().applyDriveEvent(e),
    inboxChanged: ({ files }) => store().setInbox(files),
    ingestChanged: (status) => store().setIngest(status),
    backgroundChanged: ({ run }) => store().setBackgroundRun(run),
    outboxChanged: ({ files }) => store().setOutbox(files),
    reviewChanged: ({ items }) => store().setReview(items),
    healthChanged: ({ issues }) => store().setHealth(issues),
    knowledgeChanged: ({ paths }) => store().setKnowledgePaths(paths),
    skillsChanged: ({ skills }) => store().setSkills(skills),
    sessionsChanged: ({ changes }) => store().applySessionChanges(changes),
    claudeAuthChanged: (status) => store().setClaudeAuth(status),
    claudeLoginFinished: (r) => store().setClaudeLoginResult(r),
    updateStatus: (u) => store().setUpdateStatus(u),
    openSettings: ({ section }) => {
      if (section) store().openSettingsAt(section);
      else store().setSettingsOpen(true);
    },
    showAbout: () => {
      // Version info comes from settings — refresh so the dialog is never
      // showing a stale snapshot (or nothing, right after startup).
      deps.getSettings();
      store().setAboutOpen(true);
    },
    newThread: () => {
      // Leave the settings page if it's covering the chat — a fresh thread
      // you can't see isn't a fresh thread.
      store().setSettingsOpen(false);
      store().newChat();
    },
    // Fires only on mouse clicks in the View menu — the keyboard shortcuts
    // are claimed first by the webview handler in AppRoot (see there).
    zoomCommand: ({ direction }) => deps.zoom(direction),
    ollamaPullProgress: (p) => {
      store().applyPullProgress(p);
      // a finished download changes the installed list (and maybe the default)
      if (p.done && !p.error) {
        deps.refreshOllama();
        deps.getSettings();
      }
    },
  };
  return { handlers };
}
