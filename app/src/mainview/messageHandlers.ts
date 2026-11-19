import type { AgentStreamEvent, MonadRPC } from "../shared/ipc";
import { useStore } from "./store";
import {
  browserScheduler,
  createEventBuffer,
  type FrameScheduler,
} from "./lib/eventBuffer";

export type WebviewMessageHandlers = {
  [K in keyof MonadRPC["webview"]["messages"]]: (
    payload: MonadRPC["webview"]["messages"][K],
  ) => void;
};

export type MessageHandlerDeps = {
  /** Full sidebar snapshot — only for a workspace switch. */
  refreshSidebar: () => Promise<void>;
  getSettings: () => void;
  refreshOllama: () => void;
  zoom: (direction: "in" | "out" | "reset") => void;
  scheduler?: FrameScheduler;
};

/** Everything bun pushes to the webview, applied to the store. Stream events
 *  are buffered and applied once per animation frame (one store update per
 *  frame, however many events arrived); any message whose meaning depends on
 *  the events before it flushes the buffer first. Sidebar lists arrive as
 *  targeted pushes — nothing here re-fetches them, except a workspace switch. */
export function createMessageHandlers(deps: MessageHandlerDeps): {
  handlers: WebviewMessageHandlers;
  /** Apply buffered stream events now (before history loads, local run
   *  errors, …). */
  flushStream: () => void;
} {
  const stream = createEventBuffer<AgentStreamEvent>(
    (batch) => useStore.getState().applyEvents(batch),
    deps.scheduler ?? browserScheduler,
  );
  const store = () => useStore.getState();

  const handlers: WebviewMessageHandlers = {
    streamEvent: (event) => {
      stream.push(event);
      // A run ending changes what the user can do next (send, answer
      // permissions) — apply it now, not a frame later.
      if (event.kind === "run-finished" || event.kind === "run-error")
        stream.flush();
    },
    permissionRequest: (req) => {
      stream.flush();
      store().enqueuePermission(req);
    },
    workspaceChanged: () => {
      stream.flush();
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
  return { handlers, flushStream: stream.flush };
}
