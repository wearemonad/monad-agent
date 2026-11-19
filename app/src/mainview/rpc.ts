import Electrobun, { Electroview } from "electrobun/view";
import type {
  DriveFolder,
  HarnessThread,
  MonadRPC,
  ProviderId,
  RunOptions,
} from "../shared/ipc";
import { activeThread, uid, useStore } from "./store";
import { choiceKey, controlsFor, resolveRunOptions } from "./lib/models";
import { bytesToBase64 } from "./util";
import { forwardConsole } from "./lib/consoleForward";
import { zoomIn, zoomOut, zoomReset } from "./lib/zoom";
import { perf } from "./lib/perf";
import { createMessageHandlers } from "./messageHandlers";

/** Count every incoming message by type for the performance diagnostics —
 *  the bursts after a bun stall show up here. */
function counted<T extends Record<string, (payload: any) => void>>(
  handlers: T,
): T {
  const out: Record<string, (payload: any) => void> = {};
  for (const [type, handler] of Object.entries(handlers)) {
    out[type] = (payload) => {
      perf.countMessage(type, payload);
      handler(payload);
    };
  }
  return out as T;
}

const { handlers: messageHandlers } = createMessageHandlers({
  refreshSidebar,
  resyncThread: (sessionId) => {
    // A batch went missing while this Thread streamed: drop its transcript
    // and reload it from disk (now, if it's on screen; else on next open).
    useStore.getState().invalidateThread(sessionId);
    if (activeThread(useStore.getState()).resumeSessionId === sessionId)
      void api.openSession(sessionId);
  },
  getSettings: () => void api.getSettings(),
  refreshOllama: () => void refreshOllama(),
  zoom: (direction) => {
    if (direction === "in") zoomIn();
    else if (direction === "out") zoomOut();
    else zoomReset();
  },
});

const rpc = Electroview.defineRPC<MonadRPC>({
  maxRequestTime: 300_000,
  handlers: {
    requests: {},
    messages: counted(messageHandlers),
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// Frontend logs land in the dev terminal via the bun process — the only
// reliable channel on Electrobun (see consoleForward.ts for why).
forwardConsole((level, text) => {
  (electrobun.rpc as any)?.send?.webviewLog?.({ level, text });
});

perf.init((report) => {
  (electrobun.rpc as any)?.send?.perfReport?.(report);
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
    const res = await (electrobun.rpc as any).request[name](params);
    if (name === "getSessionHistory") perf.noteHistoryLoaded();
    return res;
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

/** Sessions whose history is being fetched — a second open of a Thread
 *  still loading waits for the same fetch instead of starting another. */
const historyLoads = new Set<string>();

export const api = {
  async startRun(prompt: string) {
    const store = useStore.getState();
    const thread = activeThread(store);
    // One run per THREAD — other threads and background runs (ingest,
    // scheduled jobs) all proceed in parallel. Guarding here (not just on the
    // composer's disabled state) covers every entry point — skill "Run", a
    // job's "Run now" — and prevents the phantom user bubble + error that
    // would otherwise flip runState back to idle mid-stream.
    if (thread.runState === "running") {
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
        resumeSessionId: thread.resumeSessionId ?? undefined,
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
    const { activeRunId } = activeThread(useStore.getState());
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
    // A Thread in memory (loaded or loading) is just shown — no RPC. One
    // that isn't is shown at once as a skeleton while its history loads.
    const store = useStore.getState();
    store.startThreadLoad(sessionId);
    const s = useStore.getState();
    if (activeThread(s).loaded || historyLoads.has(sessionId)) return;
    historyLoads.add(sessionId);
    try {
      const res = await request("getSessionHistory", { sessionId });
      useStore.getState().openHistory(sessionId, res.items, res.contextTokens);
    } catch {
      // request() surfaced the error; don't leave a skeleton behind
      useStore.getState().abandonThreadLoad(sessionId);
    } finally {
      historyLoads.delete(sessionId);
    }
  },

  async renameSession(sessionId: string, title: string) {
    // bun pushes the renamed row (sessionsChanged)
    const res = await request("renameSession", { sessionId, title });
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
      // bun pushes the row's removal (sessionsChanged)
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

  /** Switch a workspace skill on/off (bun pushes the new skill list). */
  async setSkillEnabled(workspaceId: string, skill: string, enabled: boolean) {
    await request("setSkillEnabled", { workspaceId, skill, enabled });
  },

  /** Delete a user-imported skill (bun pushes the new skill list). */
  async deleteSkill(workspaceId: string, skill: string) {
    return request("deleteSkill", { workspaceId, skill });
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
  /** Settings → Advanced → Copy performance report. */
  async perfReport() {
    return (await request("getPerfReport", {})).text;
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
    // bun pushed the inbox when it saved the page (inboxChanged)
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
  async readChatImage(path: string, inline = false) {
    return request("readChatImage", { path, ...(inline ? { inline } : {}) });
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

/** Every sidebar list in one RPC — only on mount and on a workspace switch.
 *  Everything else arrives as targeted pushes (sessionsChanged, inboxChanged,
 *  skillsChanged, …). */
export async function refreshSidebar() {
  const snap = await request("getSidebarSnapshot", {});
  useStore.getState().applySidebarSnapshot(snap);
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

/** Dev builds with MONAD_FAKE_AGENT: start a run in every fake Thread (bun
 *  spreads them over up to three workspaces). For `bun run perf:stress`,
 *  then click every `everyMs` (the automation hook) through a cycle that
 *  covers each kind of switch:
 *    running Thread → another running Thread (direct, sidebar-style)
 *    → the workspace's largest existing idle Thread → Settings → back
 *    → a Thread in another workspace (idle or running, alternately)
 *    → a running Thread back in the home workspace
 *  and finally hand over to bun for the report. A no-op in release builds —
 *  bun answers with no fake Threads. */
async function runDevHarness(): Promise<void> {
  let harness: MonadRPC["bun"]["requests"]["devHarness"]["response"];
  // Straight to the transport, not request(): an older bun without this
  // handler must not raise the error toast in every dev session.
  try {
    harness = await (electrobun.rpc as any).request.devHarness({});
  } catch {
    return;
  }
  const { homeWorkspaceId: home, fakeThreads, idleThreads } = harness;
  if (!fakeThreads.length) return;
  useStore.getState().setSettingsOpen(false);
  for (const t of fakeThreads) {
    await api.openThread(t.workspaceId, t.sessionId);
    await api.startRun("Keep streaming — fake agent run.");
  }
  const homeRunning = fakeThreads.filter((t) => t.workspaceId === home);
  const otherRunning = fakeThreads.filter((t) => t.workspaceId !== home);
  const homeIdle = idleThreads.filter((t) => t.workspaceId === home);
  const otherIdle = idleThreads.filter((t) => t.workspaceId !== home);
  await api.openThread(home, homeRunning[0].sessionId);
  const stress = harness.stress;
  if (!stress) return;

  const turn: Record<string, number> = {};
  const next = (name: string, list: HarnessThread[]) => {
    turn[name] = (turn[name] ?? -1) + 1;
    return list[turn[name] % list.length];
  };
  const open = async (t: HarnessThread) => {
    perf.markClick("thread", t.sessionId, t.workspaceId);
    await api.openThread(t.workspaceId, t.sessionId);
  };
  let away = 0;
  const steps: (() => Promise<void>)[] = [
    () => open(next("home-running", homeRunning)),
    () => open(next("home-running", homeRunning)),
    ...(homeIdle.length ? [() => open(next("home-idle", homeIdle))] : []),
    async () => {
      perf.markClick("settings");
      useStore.getState().setSettingsOpen(true);
    },
    async () => useStore.getState().setSettingsOpen(false), // back, unmeasured
    ...(otherRunning.length || otherIdle.length
      ? [
          () =>
            open(
              otherIdle.length && (away++ % 2 === 0 || !otherRunning.length)
                ? next("other-idle", otherIdle)
                : next("other-running", otherRunning),
            ),
          () => open(next("home-running", homeRunning)),
        ]
      : []),
  ];

  const end = Date.now() + stress.durationMs;
  let n = 0;
  const step = async () => {
    if (Date.now() >= end) {
      useStore.getState().setSettingsOpen(false);
      await api.openThread(home, homeRunning[0].sessionId); // end where we began
      perf.flushNow();
      await request("perfStressDone", {});
      return;
    }
    await steps[n++ % steps.length]();
    setTimeout(() => void step(), stress.everyMs);
  };
  setTimeout(() => void step(), stress.everyMs);
}
// After the first sidebar load has settled.
setTimeout(() => void runDevHarness(), 3_000);
