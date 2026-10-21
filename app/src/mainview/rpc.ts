import Electrobun, { Electroview } from "electrobun/view";
import type {
  DriveFolder,
  MonadRPC,
  ProviderId,
  RunOptions,
} from "../shared/ipc";
import { uid, useStore } from "./store";
import { choiceKey, controlsFor, resolveRunOptions } from "./lib/models";
import { bytesToBase64 } from "./util";
import { forwardConsole } from "./lib/consoleForward";
import { zoomIn, zoomOut, zoomReset } from "./lib/zoom";

const rpc = Electroview.defineRPC<MonadRPC>({
  maxRequestTime: 300_000,
  handlers: {
    requests: {},
    messages: {
      streamEvent: (event) => {
        useStore.getState().applyEvent(event);
        // runs move inbox files, write outbox drafts, and create sessions —
        // refresh the whole sidebar when one ends
        if (event.kind === "run-finished" || event.kind === "run-error")
          void refreshSidebar();
      },
      permissionRequest: (req) => useStore.getState().enqueuePermission(req),
      workspaceChanged: () => {
        useStore.getState().newChat();
        void refreshSidebar();
      },
      workspacesUpdated: ({ workspaces }) =>
        useStore.getState().setWorkspaces(workspaces),
      driveEvent: (e) => useStore.getState().applyDriveEvent(e),
      inboxChanged: ({ files }) => useStore.getState().setInbox(files),
      ingestChanged: (status) => useStore.getState().setIngest(status),
      backgroundChanged: ({ run }) => useStore.getState().setBackgroundRun(run),
      outboxChanged: ({ files }) => useStore.getState().setOutbox(files),
      reviewChanged: ({ items }) => useStore.getState().setReview(items),
      healthChanged: ({ issues }) => useStore.getState().setHealth(issues),
      claudeAuthChanged: (status) => useStore.getState().setClaudeAuth(status),
      claudeLoginFinished: (r) => useStore.getState().setClaudeLoginResult(r),
      sessionsChanged: () => void refreshSidebar(),
      updateStatus: (u) => useStore.getState().setUpdateStatus(u),
      openSettings: ({ section }) => {
        const store = useStore.getState();
        if (section) store.openSettingsAt(section);
        else store.setSettingsOpen(true);
      },
      showAbout: () => {
        // Version info comes from settings — refresh so the dialog is never
        // showing a stale snapshot (or nothing, right after startup).
        void api.getSettings();
        useStore.getState().setAboutOpen(true);
      },
      newThread: () => {
        // Leave the settings page if it's covering the chat — a fresh thread
        // you can't see isn't a fresh thread.
        useStore.getState().setSettingsOpen(false);
        useStore.getState().newChat();
      },
      // Fires only on mouse clicks in the View menu — the keyboard shortcuts
      // are claimed first by the webview handler in AppRoot (see there).
      zoomCommand: ({ direction }) => {
        if (direction === "in") zoomIn();
        else if (direction === "out") zoomOut();
        else zoomReset();
      },
      ollamaPullProgress: (p) => {
        useStore.getState().applyPullProgress(p);
        // a finished download changes the installed list (and maybe the default)
        if (p.done && !p.error) {
          void refreshOllama();
          void api.getSettings();
        }
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// Frontend logs land in the dev terminal via the bun process — the only
// reliable channel on Electrobun (see consoleForward.ts for why).
forwardConsole((level, text) => {
  (electrobun.rpc as any)?.send?.webviewLog?.({ level, text });
});

// Pre-warm: opening a thread (fresh or resumed) boots its agent session in
// the background so the first message skips the CLI cold start. Silent by
// design — this must never surface an error the user didn't cause, so it
// bypasses request()'s error toast.
/** The picked model's reasoning / context / speed, resolved against its
 *  defaults — sent with every message so the run matches what the composer
 *  shows. Undefined for models without controls (Ollama). */
function currentRunOptions(): RunOptions | undefined {
  const { model, modelProvider, runOptions, settings } = useStore.getState();
  const provider = modelProvider ?? settings?.authMode ?? null;
  if (!provider) return undefined;
  return (
    resolveRunOptions(
      controlsFor(provider, model),
      runOptions[choiceKey(provider, model)],
    ) ?? undefined
  );
}

function prewarm(resumeSessionId: string | null): void {
  const { model, modelProvider } = useStore.getState();
  try {
    void (electrobun.rpc as any).request
      .prewarm({
        resumeSessionId: resumeSessionId ?? undefined,
        model: model || undefined,
        provider: modelProvider ?? undefined,
        runOptions: currentRunOptions(),
      })
      .catch(() => {});
  } catch {
    // transport not ready — the message will simply cold-start
  }
}
useStore.getState().setPrewarmHandler(prewarm);
// The landing state is a fresh thread; warm it once the app has settled.
setTimeout(() => prewarm(null), 3000);

async function request<K extends keyof MonadRPC["bun"]["requests"]>(
  name: K,
  params: MonadRPC["bun"]["requests"][K]["params"],
): Promise<MonadRPC["bun"]["requests"][K]["response"]> {
  try {
    return await (electrobun.rpc as any).request[name](params);
  } catch (e) {
    // Most callers `void` these promises, so a transport/handler rejection
    // (ENOENT, a thrown handler) would otherwise vanish with only a console
    // rejection. Surface it, then rethrow so awaiting callers still branch.
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    useStore.getState().push({
      type: "info",
      text: `Something went wrong (${String(name)}): ${msg}`,
    });
    throw e;
  }
}

export const api = {
  async startRun(prompt: string) {
    const store = useStore.getState();
    // One run per THREAD — other threads and background runs (ingest,
    // scheduled jobs) all proceed in parallel. Guarding here (not just on the
    // composer's disabled state) covers every entry point — skill "Run", a
    // job's "Run now" — and prevents the phantom user bubble + error that
    // would otherwise flip runState back to idle mid-stream.
    if (store.runState === "running") {
      store.push({
        type: "info",
        text: "A run is already active in this thread.",
      });
      return;
    }
    // The webview mints the runId so stream events (which may arrive before
    // this request resolves) already route to the thread that sent the message
    // — even if the user has switched threads in the meantime.
    const runId = uid();
    store.registerRun(runId);
    store.push({ type: "user", text: prompt });
    store.setRun("running", runId);
    try {
      const res = await request("startRun", {
        prompt,
        runId,
        resumeSessionId: store.resumeSessionId ?? undefined,
        model: store.model || undefined,
        provider: store.modelProvider ?? undefined,
        runOptions: currentRunOptions(),
      });
      if ("error" in res) {
        store.applyEvent({ kind: "run-error", runId, error: res.error });
      }
    } catch (e) {
      // Transport failure — release the thread (request() already surfaced it).
      store.applyEvent({
        kind: "run-error",
        runId,
        error: String((e as Error)?.message ?? e).slice(0, 200),
      });
    }
  },

  async abortRun() {
    const { activeRunId } = useStore.getState();
    if (activeRunId) await request("abortRun", { runId: activeRunId });
  },

  /** Stop the background run (ingest/scheduled/prep) occupying the workspace. */
  async abortBackgroundRun() {
    const run = useStore.getState().backgroundRun;
    if (run) await request("abortRun", { runId: run.runId });
  },

  async respondPermission(requestId: string, allow: boolean, always = false) {
    useStore.getState().removePermission(requestId);
    await request("respondPermission", { requestId, allow, always });
  },

  async openSession(sessionId: string) {
    const s = useStore.getState();
    // Already open with a run streaming: re-fetching would clone the thread
    // into a stale idle copy next to the live one — there's nothing to load.
    if (s.resumeSessionId === sessionId && s.runState === "running") return;
    const res = await request("getSessionHistory", { sessionId });
    useStore.getState().openHistory(sessionId, res.items, res.contextTokens);
  },

  async renameSession(sessionId: string, title: string) {
    const res = await request("renameSession", { sessionId, title });
    if (res.ok) await refreshSidebar();
    return res.ok;
  },

  async deleteSession(sessionId: string) {
    // A thread can be deleted while its run still streams (possibly stashed
    // in the background) — stop the run first so it can't keep writing.
    const liveRunId = useStore.getState().runningSessions[sessionId];
    if (liveRunId) {
      await request("abortRun", { runId: liveRunId }).catch(() => {});
    }
    const res = await request("deleteSession", { sessionId });
    if (res.ok) {
      const { pinnedSessions } = useStore.getState();
      useStore.getState().dropThreadForSession(sessionId);
      if (pinnedSessions.includes(sessionId))
        useStore.getState().togglePin(sessionId);
      await refreshSidebar();
    }
    return res.ok;
  },

  async rememberText(text: string, title?: string) {
    return request("rememberText", { text, title });
  },

  /** Open a thread that may live in another workspace: switch first, then load. */
  async openThread(workspaceId: string, sessionId: string) {
    const { workspaces } = useStore.getState();
    if (!workspaces.find((w) => w.id === workspaceId)?.active) {
      await request("setActiveWorkspace", { id: workspaceId });
    }
    await api.openSession(sessionId);
  },

  async setActiveWorkspace(id: string) {
    await request("setActiveWorkspace", { id });
  },

  async pickFolder(): Promise<string | undefined> {
    const res = await request("pickFolder", {});
    return res.path;
  },

  async pickFile(): Promise<string | undefined> {
    const res = await request("pickFile", {});
    return res.path;
  },

  async addWorkspaceFromFolder(path: string) {
    return request("addWorkspace", { path });
  },

  async createWorkspace(parentDir: string, name: string, templateId?: string) {
    return request("addWorkspace", { create: { parentDir, name, templateId } });
  },

  /** Switch a workspace skill on/off, then refresh the skill list it feeds. */
  async setSkillEnabled(workspaceId: string, skill: string, enabled: boolean) {
    await request("setSkillEnabled", { workspaceId, skill, enabled });
    const res = await request("listSkills", {});
    useStore.getState().setSkills(res.skills);
  },

  /** Delete a user-imported skill, then refresh the skill list it feeds. */
  async deleteSkill(workspaceId: string, skill: string) {
    const res = await request("deleteSkill", { workspaceId, skill });
    const skills = await request("listSkills", {});
    useStore.getState().setSkills(skills.skills);
    return res;
  },

  /** Show a skill's SKILL.md in the Finder — editing happens there, not in-app. */
  async revealSkill(workspaceId: string, skill: string) {
    await request("revealSkill", { workspaceId, skill });
  },

  async exportSkills(workspaceId: string, destDir: string) {
    return request("exportSkills", { workspaceId, destDir });
  },
  async importSkills(workspaceId: string, source: string) {
    return request("importSkills", { workspaceId, source });
  },
  async exportWorkspace(workspaceId: string, destDir: string) {
    return request("exportWorkspace", { workspaceId, destDir });
  },
  async importWorkspace(zipPath: string, parentDir: string, name: string) {
    return request("importWorkspace", { zipPath, parentDir, name });
  },
  async runHealthCheck() {
    const res = await request("runHealthCheck", {});
    useStore.getState().setHealth(res.issues);
    return res;
  },
  async revealActivity(workspaceId: string) {
    await request("revealActivity", { workspaceId });
  },

  async removeWorkspace(id: string) {
    await request("removeWorkspace", { id });
  },

  async deleteWorkspace(id: string, confirmName: string) {
    return request("deleteWorkspace", { id, confirmName });
  },

  async renameWorkspace(id: string, name: string) {
    await request("renameWorkspace", { id, name });
  },

  /** recheck=true also re-probes cached detection (the Claude CLI path). */
  async getSettings(recheck = false) {
    const s = await request("getSettings", { recheck });
    useStore.getState().setSettings(s);
    return s;
  },

  async updateSettings(
    patch: MonadRPC["bun"]["requests"]["updateSettings"]["params"],
  ) {
    const s = await request("updateSettings", patch);
    useStore.getState().setSettings(s);
    return s;
  },

  async testAuth(provider?: ProviderId) {
    return request("testAuth", { provider });
  },
  async claudeAuthStatus() {
    const status = await request("claudeAuthStatus", {});
    useStore.getState().setClaudeAuth(status);
    return status;
  },
  async claudeLoginStart() {
    return request("claudeLoginStart", {});
  },
  async claudeLoginSubmitCode(code: string) {
    return request("claudeLoginSubmitCode", { code });
  },
  async claudeLoginCancel() {
    return request("claudeLoginCancel", {});
  },
  async codexAuthStatus() {
    return request("codexAuthStatus", {});
  },
  /** Runs `codex login` (browser sign-in); resolves when the CLI exits. */
  async codexLogin() {
    return request("codexLogin", {});
  },

  refreshOllama,
  async ollamaStart() {
    const res = await request("ollamaStart", {});
    await refreshOllama();
    return res;
  },
  async ollamaPull(model: string) {
    useStore.getState().applyPullProgress({ model, status: "starting…" });
    return request("ollamaPull", { model });
  },
  async openUrl(url: string) {
    await request("openUrl", { url });
  },

  async updateCheck() {
    return request("updateCheck", {});
  },
  async updateDownload() {
    await request("updateDownload", {});
  },
  async updateInstall() {
    await request("updateInstall", {});
  },
  async revealLogs() {
    return request("revealLogs", {});
  },
  async exportDiagnostics() {
    return request("exportDiagnostics", {});
  },

  async driveConnect(workspaceId: string) {
    await request("driveConnect", { workspaceId });
  },

  async driveDisconnect(workspaceId: string) {
    await request("driveDisconnect", { workspaceId });
  },

  async driveListFolders(workspaceId: string) {
    return request("driveListFolders", { workspaceId });
  },

  async driveSetFolders(
    workspaceId: string,
    folders: DriveFolder[],
    recursive: boolean,
  ) {
    await request("driveSetFolders", { workspaceId, folders, recursive });
  },

  async driveSetGmailLabels(workspaceId: string, labels: string[]) {
    await request("driveSetGmailLabels", { workspaceId, labels });
  },

  async gmailListLabels(workspaceId: string) {
    return request("gmailListLabels", { workspaceId });
  },

  async driveSync(workspaceId: string) {
    await request("driveSync", { workspaceId });
  },

  async ingestFiles(files: File[]) {
    const store = useStore.getState();
    const payload = await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        // Chunked encode — a spread over a multi-MB image would blow the stack
        // and silently reject the whole drop.
        base64: bytesToBase64(await f.arrayBuffer()),
      })),
    );
    store.push({
      type: "info",
      text: `Dropped ${files.length} file(s) → inbox/`,
    });
    const res = await request("ingestFiles", { files: payload });
    if (res.runId) {
      // runs in the background — progress lives in the Inbox panel, results in Review
      store.push({
        type: "info",
        text: "Ingesting in the background — results land in Review.",
      });
    } else if (res.queued) {
      // An ingest is already working — these chain automatically when it's done.
      store.push({
        type: "info",
        text: "Ingest already running — queued; these will be ingested when it finishes.",
      });
    } else {
      // The real reason (busy, missing API key, …), not a canned guess.
      store.push({
        type: "info",
        text: `Files saved to inbox, but ingest couldn't start: ${res.error ?? "unknown error"}. Say "ingest" to retry.`,
      });
    }
  },

  async ingestInbox() {
    const res = await request("ingestInbox", {});
    if (res.queued) {
      useStore.getState().push({
        type: "info",
        text: "Ingest already running — queued; remaining files will be ingested when it finishes.",
      });
    } else if (res.error) {
      useStore.getState().push({ type: "info", text: res.error });
    }
  },

  async stopIngest() {
    await request("stopIngest", {});
  },

  async revealInbox() {
    await request("revealInbox", {});
  },

  /** Remove one inbox file (moved to the macOS Trash). The bun side pushes
	    the updated list via inboxChanged, so no local state juggling here. */
  async deleteInboxFile(name: string) {
    const res = await request("deleteInboxFile", { name });
    if (!res.ok && res.error) {
      useStore
        .getState()
        .push({ type: "info", text: `Couldn't remove ${name}: ${res.error}` });
    }
  },

  /** Move every inbox file to the Trash. The bun side pushes the updated
      list via inboxChanged. */
  async clearInbox() {
    const res = await request("clearInbox", {});
    if (res.error) {
      useStore
        .getState()
        .push({ type: "info", text: `Couldn't clear inbox: ${res.error}` });
    }
  },

  /** Fetch a pasted URL into inbox/ and kick off ingest. */
  async ingestUrl(url: string) {
    const store = useStore.getState();
    store.push({ type: "info", text: `Fetching ${url} → inbox/` });
    const res = await request("ingestUrl", { url });
    if (res.runId) {
      store.push({
        type: "info",
        text: "Ingesting in the background — results land in Review.",
      });
    } else if (res.queued) {
      store.push({
        type: "info",
        text: "Ingest already running — queued; the page will be ingested when it finishes.",
      });
    } else if (res.saved) {
      store.push({
        type: "info",
        text: `Page saved to inbox, but ingest couldn't start: ${res.error ?? "unknown error"}. Say "ingest" to retry.`,
      });
    } else if (res.error) {
      store.push({ type: "info", text: res.error });
    }
    void refreshInbox();
  },

  async setWatchFolder(workspaceId: string, path?: string) {
    return request("setWatchFolder", { workspaceId, path });
  },

  async resolveReview(path: string, action: "accept" | "reject") {
    return request("resolveReview", { path, action });
  },

  async emailCreateDraft(draft: {
    to: string;
    cc?: string;
    subject: string;
    body: string;
  }) {
    return request("emailCreateDraft", draft);
  },

  async revealArtifact(id: string) {
    await request("revealArtifact", { id });
  },
  async openArtifactFile(id: string) {
    await request("openArtifact", { id });
  },

  async readOutbox(name: string) {
    return request("readOutbox", { name });
  },
  async archiveOutbox(name: string) {
    await request("archiveOutbox", { name });
  },
  async openOutbox(name: string) {
    await request("openOutbox", { name });
  },
  async revealOutbox() {
    await request("revealOutbox", {});
  },

  async gmailListDrafts(workspaceId: string) {
    return request("gmailListDrafts", { workspaceId });
  },
  async gmailSendDraft(workspaceId: string, draftId: string) {
    return request("gmailSendDraft", { workspaceId, draftId });
  },
  async gmailDeleteDraft(workspaceId: string, draftId: string) {
    return request("gmailDeleteDraft", { workspaceId, draftId });
  },

  async searchSessions(query: string) {
    return request("searchSessions", { query });
  },

  async setAppFocused(focused: boolean) {
    await request("setAppFocused", { focused });
  },

  async costSummary(workspaceId: string) {
    return request("costSummary", { workspaceId });
  },
  async setBudget(workspaceId: string, budgetUsd?: number) {
    await request("setBudget", { workspaceId, budgetUsd });
  },

  async brainHealth() {
    return request("brainHealth", {});
  },
  async writeKnowledge(path: string, content: string) {
    return request("writeKnowledge", { path, content });
  },

  async saveChatAttachment(name: string, base64: string) {
    return request("saveChatAttachment", { name, base64 });
  },
  async readChatImage(path: string) {
    return request("readChatImage", { path });
  },
  async openChatImage(path: string) {
    return request("openChatImage", { path });
  },
  async saveChatImage(path: string) {
    return request("saveChatImage", { path });
  },
  /** Native multi-select file chooser; resolves empty on cancel. */
  async pickChatFiles(max: number) {
    return request("pickChatFiles", { max });
  },

  async addInboxTrigger(workspaceId: string, match: string, prompt: string) {
    return request("addInboxTrigger", { workspaceId, match, prompt });
  },
  async removeInboxTrigger(workspaceId: string, triggerId: string) {
    await request("removeInboxTrigger", { workspaceId, triggerId });
  },
  async setMeetingPrep(workspaceId: string, enabled: boolean) {
    await request("setMeetingPrep", { workspaceId, enabled });
  },
  async setBriefingFocus(workspaceId: string, enabled: boolean) {
    await request("setBriefingFocus", { workspaceId, enabled });
  },

  async listKnowledge() {
    return request("listKnowledge", {});
  },
  async readKnowledge(path: string, workspaceId?: string) {
    return request("readKnowledge", { path, workspaceId });
  },
  async forgetKnowledge(path: string) {
    return request("forgetKnowledge", { path });
  },
  async revealKnowledge(path: string, workspaceId?: string) {
    await request("revealKnowledge", { path, workspaceId });
  },
  async knowledgeGraph(workspaceId: string, includeDocs: boolean) {
    return request("knowledgeGraph", { workspaceId, includeDocs });
  },
  async graphBackfillStart(workspaceId: string) {
    return request("graphBackfillStart", { workspaceId });
  },

  async mcpList(workspaceId: string) {
    return request("mcpList", { workspaceId });
  },
  async mcpAdd(
    workspaceId: string,
    server: MonadRPC["bun"]["requests"]["mcpAdd"]["params"]["server"],
  ) {
    return request("mcpAdd", { workspaceId, server });
  },
  async mcpRemove(workspaceId: string, name: string) {
    await request("mcpRemove", { workspaceId, name });
  },
  async mcpTest(workspaceId: string, name: string) {
    return request("mcpTest", { workspaceId, name });
  },
  async wsEnvSet(workspaceId: string, name: string, value: string) {
    return request("wsEnvSet", { workspaceId, name, value });
  },
  async wsEnvClear(workspaceId: string, name: string) {
    await request("wsEnvClear", { workspaceId, name });
  },

  async setAlwaysAllow(workspaceId: string, alwaysAllow: string[]) {
    await request("setAlwaysAllow", { workspaceId, alwaysAllow });
  },
  async addJob(workspaceId: string, job: Parameters<typeof buildJob>[0]) {
    await request("addJob", { workspaceId, job: buildJob(job) });
  },
  async removeJob(workspaceId: string, jobId: string) {
    await request("removeJob", { workspaceId, jobId });
  },
  async toggleJob(workspaceId: string, jobId: string) {
    await request("toggleJob", { workspaceId, jobId });
  },

  refreshSidebar,
  refreshInbox,
};

function buildJob(job: {
  name: string;
  prompt: string;
  hour: number;
  minute: number;
  days: number[];
  enabled: boolean;
}) {
  return job;
}

export async function refreshSidebar() {
  const [all, w, i, o, skills, knowledge, review, health, ingest, background] =
    await Promise.all([
      request("listAllSessions", {}),
      request("listWorkspaces", {}),
      request("listInbox", {}),
      request("listOutbox", {}),
      request("listSkills", {}),
      request("listKnowledge", {}),
      request("listReview", {}),
      request("listHealth", {}),
      request("ingestStatus", {}),
      request("backgroundStatus", {}),
    ]);
  const active = w.workspaces.find((ws) => ws.active);
  useStore.getState().setAllSessions(all.byWorkspace);
  useStore
    .getState()
    .setSessions(active ? (all.byWorkspace[active.id] ?? []) : []);
  useStore.getState().setWorkspaces(w.workspaces);
  useStore.getState().setInbox(i.files);
  useStore.getState().setIngest(ingest);
  useStore.getState().setBackgroundRun(background.run);
  useStore.getState().setOutbox(o.files);
  useStore.getState().setSkills(skills.skills);
  useStore.getState().setKnowledgePaths(knowledge.docs.map((d) => d.path));
  useStore.getState().setReview(review.items);
  useStore.getState().setHealth(health.issues);
}

export async function refreshInbox() {
  const i = await request("listInbox", {});
  useStore.getState().setInbox(i.files);
}

// Report window focus so the bun side can keep "quiet when focused"
// notifications honest. Single-window app: window blur means the user left
// Monad. The bun side assumes focused at launch, matching a fresh window.
window.addEventListener("focus", () => void api.setAppFocused(true));
window.addEventListener("blur", () => void api.setAppFocused(false));

/** Refresh local-model state (installed models, fit verdicts, download list).
 *  Called on demand — when the Settings panel opens, local mode is selected,
 *  or a download finishes — not on the sidebar cadence. */
export async function refreshOllama() {
  const status = await request("ollamaStatus", {});
  useStore.getState().setOllama(status);
  return status;
}
