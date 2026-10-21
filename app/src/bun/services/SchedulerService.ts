import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  jobKind,
  nextJobRun,
  type AgentStreamEvent,
  type ScheduledJob,
  type SessionKind,
} from "../../shared/ipc";
import type { WorkspaceManager } from "./WorkspaceManager";
import type { AgentService } from "./AgentService";
import { isScheduledSafeTool } from "./ingestPolicy";
import { readJsonAtomic, writeJsonAtomic } from "./atomicJson";

/** Runs per-workspace scheduled jobs (e.g. the morning briefing).
 *
 *  Catch-up semantics: a job fires the first tick at-or-after its time on an
 *  enabled day, once per day — so a laptop asleep at 08:00 still gets its
 *  briefing when it wakes at 09:15. Background runs never show dialogs; tools
 *  outside the scheduled-safe policy / always-allow list are denied.
 *
 *  Offline-tolerant: a due job waits (stays due) while the machine has no
 *  network — the first tick after wake typically lands before Wi-Fi is back
 *  — and a run that dies of a transient cause (connection error, timeout,
 *  5xx) is retried silently with backoff: no notification, and its failed
 *  thread is removed so the user never sees an "API Error" briefing. */

/** Total tries a job gets per local day for NON-transient failures. A run
 *  that errors re-arms the job so the next tick retries it (a failed 8:00
 *  briefing must not wait until tomorrow) — bounded, because each retry is a
 *  fresh paid agent run. */
export const MAX_ATTEMPTS_PER_DAY = 3;

/** Delay before the Nth silent retry after a transient failure (offline,
 *  timeout, 5xx). Past the end of the list the last value repeats: the job
 *  stays due all day and is retried every 15 minutes until it succeeds, so
 *  a morning without Wi-Fi still gets its briefing when the network returns.
 *  Transient attempts cost nothing when the failure is a dead connection. */
export const TRANSIENT_RETRY_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000];

/** A tick arriving this much later than scheduled means the machine slept
 *  (timers don't run during sleep — they fire late on wake). Bun/Electrobun
 *  expose no system wake event, so elapsed wall-clock time is the signal. */
export const WAKE_GAP_MS = 3 * 60_000;

/** How often the scheduler writes an "alive" status line to the app log —
 *  silence in the log then means the scheduler itself stopped, not merely
 *  that nothing was due. */
export const HEARTBEAT_MS = 30 * 60_000;

/** Failures worth a quiet retry rather than a "Scheduled run failed" alert:
 *  no network, DNS down, dropped/refused/reset connections, timeouts,
 *  upstream 5xx/overload/rate-limit. Auth and config problems (401/403,
 *  invalid key, missing CLI) are deliberately NOT matched — the user must
 *  see those. */
export function isTransientError(message: string): boolean {
  const s = message ?? "";
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*(api[ _-]?key|token)|authentication|not logged in|ENOENT|not found/i.test(
      s,
    )
  ) {
    return false;
  }
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|fetch failed|network|connection (error|refused|reset|closed|failed)|socket hang up|timed? ?out|timeout|overloaded|rate.?limit|too many requests|\b(408|425|429|500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway time/i.test(
    s,
  );
}

/** Default connectivity probe: any HTTP response from the API host (even a
 *  4xx) means the network is up; a thrown fetch = offline/DNS down. Bounded
 *  so a half-up network can't stall the tick. */
export async function probeOnline(signal?: AbortSignal): Promise<boolean> {
  try {
    await fetch("https://api.anthropic.com/", {
      method: "HEAD",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
        : AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Claim files older than this are pruned — they only need to outlive their
 *  own day (job claims) or the calendar lookahead (meeting-prep claims). */
const CLAIM_MAX_AGE_MS = 14 * 86_400_000;

/** Cross-process once-only claim, keyed per workspace. The ran-today guard
 *  lives in each app process's own config/memory — when TWO processes overlap
 *  on one machine (dev build + installed app, or an updater's old process
 *  still alive), both see a job as due and BOTH fire it: two briefing
 *  threads, twice the cost. The workspace's own .monad/ dir is the one place
 *  every process shares, so the claim is an exclusive-create (`wx`) file
 *  there: exactly one process wins the right to start the run.
 *
 *  Filesystem trouble (permissions, missing workspace) returns true — a rare
 *  duplicate beats a briefing that silently never fires. */
export function claimOnce(workspacePath: string, key: string): boolean {
  const dir = path.join(workspacePath, ".monad", "job-claims");
  try {
    fs.mkdirSync(dir, { recursive: true });
    pruneOldClaims(dir);
    fs.writeFileSync(path.join(dir, claimName(key)), String(process.pid), {
      flag: "wx",
    });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

/** Release a claim only when the process that took it is gone — used by
 *  orphan recovery, where the claimer may be a dead previous launch (release:
 *  its run died with it) or a still-running second instance (keep: its run is
 *  live and would otherwise be duplicated). */
export function releaseStaleClaim(workspacePath: string, key: string): void {
  try {
    const pid = Number(
      fs.readFileSync(
        path.join(workspacePath, ".monad", "job-claims", claimName(key)),
        "utf8",
      ),
    );
    if (pid && pid !== process.pid && processAlive(pid)) return;
  } catch {
    return; // no claim — nothing to release
  }
  releaseClaim(workspacePath, key);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Release a claim so the work can be tried again (start failed / run
 *  errored and is being re-armed). Missing file = fine. */
export function releaseClaim(workspacePath: string, key: string): void {
  try {
    fs.rmSync(path.join(workspacePath, ".monad", "job-claims", claimName(key)));
  } catch {
    // never let cleanup break scheduling
  }
}

function claimName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}

function pruneOldClaims(dir: string): void {
  try {
    const cutoff = Date.now() - CLAIM_MAX_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p);
      } catch {
        // a claim raced away — nothing to prune
      }
    }
  } catch {
    // unreadable dir — pruning is best-effort
  }
}

type OwnedRun = {
  jobName: string;
  workspaceName: string;
  workspaceId: string;
  /** Where the workspace lives on disk — needed to rename/stamp the session. */
  workspacePath: string;
  /** What kind of thread this run produces ("briefing", "meeting-prep", …). */
  kind: SessionKind;
  /** Absent for non-job runs (meeting prep), which have their own idempotence
   *  and are never re-armed by the scheduler. */
  jobId?: string;
  /** True once the session was titled/kind-stamped (in-memory only). */
  stamped?: boolean;
  /** The run's thread, once run-started reports it — lets the sidebar show a
   *  working indicator on that row. */
  sessionId?: string;
  /** Local day (YYYY-MM-DD) the job run is for — names its cross-process
   *  claim, so orphan recovery can release it. Job runs only. */
  date?: string;
};

export class SchedulerService {
  /** runId → job/workspace context for completion notifications. Mirrored to
   *  `stateFile` so a run that dies with the process is detected on the next
   *  launch and its job re-armed (recoverOrphans). */
  private owned = new Map<string, OwnedRun>();
  /** `workspaceId:jobId` → today's failed-attempt count. In-memory only: a
   *  restart grants a fresh budget, which is acceptable for a bound whose job
   *  is to stop a same-day retry loop. */
  private attempts = new Map<string, { date: string; count: number }>();
  /** `workspaceId:jobId` → transient-failure count today (drives backoff). */
  private transientAttempts = new Map<
    string,
    { date: string; count: number }
  >();
  /** `workspaceId:jobId` → earliest time (ms) the job may be retried after a
   *  transient failure. Cleared on wake: a fresh network is a fresh chance. */
  private retryAfter = new Map<string, number>();
  /** Wall-clock time of the previous tick, for sleep/wake detection. */
  private lastTickAt = 0;
  /** A check is in progress, and when it began (Export Diagnostics). Checks
   *  never overlap: they run on one loop, which abandons a wedged one. */
  private ticking = false;
  private tickStartedAt = 0;
  /** Last connectivity probe result (null = not probed yet). */
  private lastOnline: boolean | null = null;

  constructor(
    private workspaces: WorkspaceManager,
    private agent: AgentService,
    private onBackgroundRunFinished: () => void,
    /** Fired when the set of scheduler-owned runs changes (start or finish),
     *  so the UI can surface/clear the background-run indicator. */
    private onRunsChanged: () => void = () => {},
    /** Where in-flight run ownership is persisted; null disables persistence. */
    private stateFile: string | null = null,
    /** Injectable for tests — the default fires a real macOS notification. */
    private notifier: (
      subtitle: string,
      message: string,
      opts?: NotifyOpts,
    ) => void = notify,
    /** Sets the session's custom title (SDK renameSession). Injected so the
     *  scheduler can title its threads in code — "Aug 21 · Morning briefing" —
     *  instead of leaving them to the token-costing auto-summary. Null (tests)
     *  skips titling entirely. */
    private renameSession:
      | ((cwd: string, sessionId: string, title: string) => Promise<boolean>)
      | null = null,
    /** Records sessionId → kind so the UI can tell briefing/scheduled threads
     *  from normal chats. */
    private recordKind: (
      cwd: string,
      sessionId: string,
      kind: SessionKind,
    ) => void = () => {},
    /** Removes a thread — used to erase the session of a transiently failed
     *  attempt (it holds only the prompt and an "API Error" line). Null
     *  (tests / callers without a session store) leaves the thread alone. */
    private deleteSession:
      | ((cwd: string, sessionId: string) => Promise<boolean>)
      | null = null,
    /** Connectivity probe consulted before starting a due job; while it says
     *  offline the job simply stays due. Injectable for tests. */
    private isOnline: (signal?: AbortSignal) => Promise<boolean> = probeOnline,
    /** Clock, injectable so tests can drive days/backoff deterministically. */
    private clock: () => Date = () => new Date(),
    /** True when the run's transcript shows it delivered its output (saved
     *  into outbox/, or created a Gmail draft). A run that errors AFTER
     *  delivering — e.g. "529 overloaded" on its closing turn — is a success:
     *  retrying would produce a duplicate briefing, and deleting its thread
     *  would leave the output with no thread. Default: never delivered. */
    private runDelivered: (cwd: string, sessionId: string) => boolean = () =>
      false,
    /** Workspace activity log (.monad/activity.jsonl). Scheduler decisions
     *  that leave a job unstarted — waiting for network, workspace busy,
     *  claimed elsewhere, interrupted run recovered — go here, so "the
     *  briefing never ran" can be diagnosed from the user's workspace. */
    private logActivity: (
      workspacePath: string,
      entry: { kind: string; detail: string },
    ) => void = () => {},
  ) {}

  /** `workspaceId:jobId:date:reason` already written to the activity log —
   *  a job stays due for many ticks, its reason is logged once a day. */
  private noted = new Set<string>();

  private note(
    workspacePath: string,
    key: string,
    reason: string,
    detail: string,
  ): void {
    const k = `${key}:${localDateKey(this.clock())}:${reason}`;
    if (this.noted.has(k)) return;
    if (this.noted.size > 500) this.noted.clear(); // older days' keys
    this.noted.add(k);
    console.info(`[scheduler] ${detail}`);
    this.logActivity(workspacePath, { kind: "scheduler", detail });
  }

  /** The scheduler-owned run active in a workspace, if any. */
  activeRunFor(
    workspaceId: string,
  ): { runId: string; jobName: string; sessionId?: string } | null {
    for (const [runId, ctx] of this.owned) {
      if (ctx.workspaceId === workspaceId)
        return { runId, jobName: ctx.jobName, sessionId: ctx.sessionId };
    }
    return null;
  }

  /** Launch-time setup. The checks and the heartbeat themselves run on loops
   *  the app runtime owns (schedulerLoops in SchedulerLoop.ts). */
  start(): void {
    this.logStatus(this.clock(), "started");
    this.recoverOrphans();
  }

  /** Re-arm jobs whose runs died with a previous process: the state file still
   *  lists them as in-flight, but nothing will ever emit their finish event —
   *  their jobs are stamped as "ran today" and would silently skip the day.
   *  Clearing the stamp lets catch-up semantics fire them again — and the dead
   *  run's cross-process claim must go too, or the next tick reads it as
   *  "another instance already ran this" and re-stamps the day as done. A run
   *  that already delivered its output before dying is done, not re-armed. */
  recoverOrphans(): OwnedRun[] {
    if (!this.stateFile) return [];
    let orphans: OwnedRun[] = [];
    try {
      orphans = readJsonAtomic<{ runs: OwnedRun[] }>(this.stateFile, () => ({
        runs: [],
      })).runs;
    } catch {
      return []; // momentarily unreadable — stale entries recover next launch
    }
    for (const run of orphans) {
      if (!run.jobId) continue;
      const date = run.date ?? localDateKey(this.clock());
      if (
        run.sessionId &&
        run.workspacePath &&
        this.runDelivered(run.workspacePath, run.sessionId)
      ) {
        this.workspaces.markJobSucceeded(run.workspaceId, run.jobId, date);
        continue;
      }
      this.workspaces.clearJobRan(run.workspaceId, run.jobId);
      if (run.workspacePath) {
        releaseStaleClaim(run.workspacePath, `${run.jobId}-${date}`);
        this.note(
          run.workspacePath,
          `${run.workspaceId}:${run.jobId}`,
          "orphan",
          `${run.jobName}: the previous run was interrupted (app quit or restarted mid-run) — re-armed`,
        );
      }
    }
    if (orphans.length) this.persistOwned();
    return orphans;
  }

  private persistOwned(): void {
    if (!this.stateFile) return;
    try {
      writeJsonAtomic(this.stateFile, {
        runs: [...this.owned.entries()].map(([runId, ctx]) => ({
          runId,
          ...ctx,
        })),
      });
    } catch {
      // persistence is a crash-recovery aid — never let it break the run
    }
  }

  /** Swallow stream events belonging to scheduled runs so they never bleed
   *  into the open chat. Returns true when the event was consumed. */
  handleEvent(event: AgentStreamEvent): boolean {
    const runId = "runId" in event ? event.runId : undefined;
    if (!runId || !this.owned.has(runId)) return false;
    // Title + kind-stamp the thread as soon as its session id exists. The
    // title is composed in code (no model call): "Aug 21 · Morning briefing".
    if (event.kind === "run-started" && event.sessionId) {
      const ctx = this.owned.get(runId)!;
      if (!ctx.sessionId) {
        ctx.sessionId = event.sessionId;
        // Persisted so orphan recovery can tell whether the run delivered.
        this.persistOwned();
        // Re-push the background-run info now that the thread is known, so
        // the sidebar can attach its working indicator to the right row.
        this.onRunsChanged();
      }
      this.stampSession(ctx, event.sessionId);
    }
    if (event.kind === "run-finished" || event.kind === "run-error") {
      const ctx = this.owned.get(runId)!;
      const sessionId =
        (event.kind === "run-finished" ? event.sessionId : "") ||
        ctx.sessionId ||
        "";
      // The CLI reports API/network failures as an errored RESULT, not a
      // thrown error — a run-finished carrying `error` is a failure too.
      const aborted = event.kind === "run-error" && !!event.aborted;
      const error =
        event.kind === "run-error" ? event.error : (event.error ?? "");
      const errored = !aborted && !!error;
      const delivered =
        errored &&
        !!sessionId &&
        this.runDelivered(ctx.workspacePath, sessionId);
      if (delivered) {
        console.warn(
          `[scheduler] ${ctx.jobName}: run ended with an error after delivering its output (${error.replace(/\s+/g, " ").slice(0, 120)}) — counted as done`,
        );
      }
      const failed = errored && !delivered;
      const transient = failed && isTransientError(error);
      // Stamp (title + kind) every thread that stays: the finish event is the
      // backstop for run-started missing the session id, and a FAILED attempt
      // keeps its badge too — otherwise it sits in the sidebar looking like a
      // normal chat next to the retry's properly-stamped one. A transient
      // failure's thread is deleted instead, so stamping it is pointless.
      if (!transient) this.stampSession(ctx, sessionId);
      this.owned.delete(runId);
      this.persistOwned();
      if (!transient) {
        console.info(
          `[scheduler] ${ctx.jobName} (${ctx.workspaceName}): ${
            aborted
              ? "stopped by the user"
              : failed
                ? `failed — ${error.replace(/\s+/g, " ").slice(0, 200)}`
                : "succeeded"
          }`,
        );
      }
      let outcome: string | null = "finished — open Monad to read it";
      if (aborted) {
        outcome = "stopped";
      } else if (transient) {
        // Offline / timeout / upstream 5xx: nothing the user can act on.
        // Retry quietly with backoff, keep the job due, and remove the
        // half-thread (prompt + "API Error") so it never shows as a failed
        // briefing.
        this.deferForTransientRetry(ctx, error);
        if (sessionId && this.deleteSession) {
          void this.deleteSession(ctx.workspacePath, sessionId).catch(
            () => false,
          );
        }
        outcome = null;
      } else if (failed) {
        outcome = this.rearmForRetry(ctx)
          ? "failed — retrying shortly"
          : "failed";
      } else if (ctx.jobId) {
        const key = `${ctx.workspaceId}:${ctx.jobId}`;
        this.attempts.delete(key);
        this.transientAttempts.delete(key);
        this.retryAfter.delete(key);
        this.workspaces.markJobSucceeded(
          ctx.workspaceId,
          ctx.jobId,
          localDateKey(this.clock()),
        );
      }
      if (outcome) {
        this.notifier(
          `${ctx.workspaceName}: ${ctx.jobName}`,
          `Scheduled run ${outcome}.`,
          // Success/stop is visible in-app (the thread appears in the
          // sidebar); failures always notify — there's nothing in-app to
          // catch the eye.
          !failed ? { quietWhenFocused: ctx.workspaceId } : undefined,
        );
      }
      this.onBackgroundRunFinished();
      this.onRunsChanged();
    }
    return true;
  }

  /** Give the thread its code-composed title and record its kind — exactly
   *  once per run. Rename retries because the CLI writes the session file
   *  asynchronously shortly after init (same reason session tagging retries). */
  private stampSession(ctx: OwnedRun, sessionId: string): void {
    if (ctx.stamped || !sessionId) return;
    ctx.stamped = true;
    this.recordKind(ctx.workspacePath, sessionId, ctx.kind);
    const rename = this.renameSession;
    if (!rename) return;
    const title = runTitle(ctx.jobName, this.clock());
    void (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const ok = await rename(ctx.workspacePath, sessionId, title).catch(
          () => false,
        );
        if (ok) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
  }

  /** Transient failure: re-arm the job (stamp + claim released) and hold it
   *  back for a backoff interval. Unbounded within the day by design — the
   *  point is to deliver the briefing whenever the network returns. */
  private deferForTransientRetry(ctx: OwnedRun, error: string): void {
    if (!ctx.jobId) return; // meeting prep re-queues itself on the next poll
    const now = this.clock();
    const today = localDateKey(now);
    const key = `${ctx.workspaceId}:${ctx.jobId}`;
    const prior = this.transientAttempts.get(key);
    const count = (prior?.date === today ? prior.count : 0) + 1;
    this.transientAttempts.set(key, { date: today, count });
    const delay =
      TRANSIENT_RETRY_BACKOFF_MS[
        Math.min(count, TRANSIENT_RETRY_BACKOFF_MS.length) - 1
      ];
    this.retryAfter.set(key, now.getTime() + delay);
    this.workspaces.clearJobRan(ctx.workspaceId, ctx.jobId);
    releaseClaim(ctx.workspacePath, `${ctx.jobId}-${today}`);
    console.warn(
      `[scheduler] ${ctx.jobName}: transient failure (${error.replace(/\s+/g, " ").slice(0, 120)}) — retry #${count} in ${Math.round(delay / 1000)}s`,
    );
  }

  /** When a job may next be started (ms) — 0 when not held back. Exposed
   *  for tests. */
  retryAfterFor(workspaceId: string, jobId: string): number {
    return this.retryAfter.get(`${workspaceId}:${jobId}`) ?? 0;
  }

  /** Count a failed attempt and, while the day's budget lasts, clear the job's
   *  ran-today stamp so the next tick retries it. True when re-armed. */
  private rearmForRetry(ctx: OwnedRun): boolean {
    if (!ctx.jobId) return false;
    const today = localDateKey(this.clock());
    const key = `${ctx.workspaceId}:${ctx.jobId}`;
    const prior = this.attempts.get(key);
    const used = (prior?.date === today ? prior.count : 0) + 1;
    this.attempts.set(key, { date: today, count: used });
    if (used >= MAX_ATTEMPTS_PER_DAY) return false;
    this.workspaces.clearJobRan(ctx.workspaceId, ctx.jobId);
    // The failed attempt holds today's cross-process claim — release it or
    // the retry blocks itself at the next tick.
    releaseClaim(ctx.workspacePath, `${ctx.jobId}-${today}`);
    return true;
  }

  /** Start a background run owned by the scheduler: its stream never bleeds
   *  into the open chat, and completion becomes a notification. Returns null
   *  when a run is already active in the workspace (caller retries later). */
  runBackground(opts: {
    workspaceId: string;
    workspacePath: string;
    workspaceName: string;
    jobName: string;
    prompt: string;
    /** Thread kind for the sidebar badge; defaults to "scheduled". */
    kind?: SessionKind;
    /** Present for registry-defined jobs — enables retry/orphan re-arming. */
    jobId?: string;
    /** Local day the job run is for (names its claim) — job runs only. */
    date?: string;
  }): string | null {
    try {
      const runId = this.agent.startRun({
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        prompt: opts.prompt,
        background: true,
        // Scheduled skills deliver into outbox/ and artifacts/ (briefings,
        // prep notes). Without this grant those Writes are silently denied —
        // only the Gmail draft would survive a background run.
        safeTools: (toolName, input) =>
          isScheduledSafeTool(toolName, input, opts.workspacePath),
      });
      this.owned.set(runId, {
        jobName: opts.jobName,
        workspaceName: opts.workspaceName,
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        kind: opts.kind ?? "scheduled",
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
        ...(opts.date ? { date: opts.date } : {}),
      });
      this.persistOwned();
      this.onRunsChanged();
      return runId;
    } catch (e) {
      // Busy workspace (another background run) or unusable auth — the job
      // stays due and is retried next tick. Logged once a day per reason.
      const message = String((e as Error)?.message ?? e);
      this.note(
        opts.workspacePath,
        `${opts.workspaceId}:${opts.jobId ?? opts.jobName}`,
        `start:${message}`,
        `${opts.jobName} is due but could not start: ${message}`,
      );
      return null;
    }
  }

  /** One scheduler pass. Public (with an injectable clock) so tests can
   *  drive catch-up without waiting on real timers. Resolves once any due
   *  jobs have been started or deliberately left due. */
  async tick(
    now: Date = this.clock(),
    /** Aborts when the owning loop abandons this check (timeout, quit). */
    signal?: AbortSignal,
  ): Promise<void> {
    this.ticking = true;
    this.tickStartedAt = now.getTime();
    try {
      this.detectWake(now.getTime());
      const today = localDateKey(now);
      const due: Array<{
        ws: ReturnType<WorkspaceManager["list"]>[number];
        job: ScheduledJob;
      }> = [];
      for (const ws of this.workspaces.list()) {
        for (const job of ws.jobs) {
          if (!isJobDue(job, now)) continue;
          // Held back by transient-failure backoff — still due, not yet.
          if (this.retryAfterFor(ws.id, job.id) > now.getTime()) continue;
          due.push({ ws, job });
        }
      }
      if (!due.length) return;
      // No network → nothing would succeed; leave every job due for the next
      // tick. (Sleep/wake: the first tick lands before Wi-Fi reconnects.)
      const online = await this.isOnline(signal);
      // Abandoned while probing: a check that outlived its timeout must not
      // start jobs late — possibly alongside the next check.
      if (signal?.aborted) return;
      if (online !== this.lastOnline && this.lastOnline !== null) {
        console.info(
          `[scheduler] network ${online ? "is back" : "is unreachable"}`,
        );
      }
      this.lastOnline = online;
      if (!online) {
        for (const { ws, job } of due) {
          this.note(
            ws.path,
            `${ws.id}:${job.id}`,
            "offline",
            `${job.name} is due — waiting for the network`,
          );
        }
        return;
      }
      for (const { ws, job } of due) {
        // Cross-process guard: another app instance already fired this job
        // today (its stamp lives in ITS config, not ours) — record ours and
        // stand down instead of running the job a second time.
        if (!claimOnce(ws.path, `${job.id}-${today}`)) {
          this.note(
            ws.path,
            `${ws.id}:${job.id}`,
            "claimed",
            `${job.name}: already started today by another Monad process — skipped here`,
          );
          this.workspaces.markJobRan(ws.id, job.id, today);
          continue;
        }
        const runId = this.runBackground({
          workspaceId: ws.id,
          workspacePath: ws.path,
          workspaceName: ws.name,
          jobName: job.name,
          prompt: job.prompt,
          kind: jobKind(job),
          jobId: job.id,
          date: today,
        });
        // null = a run is active in this workspace — stays due, retried next
        // tick (the claim is released so that retry isn't self-blocked)
        if (runId) {
          console.info(
            `[scheduler] starting ${job.name} (${ws.name}) — run ${runId}`,
          );
          this.workspaces.markJobRan(ws.id, job.id, today);
        } else releaseClaim(ws.path, `${job.id}-${today}`);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** The "alive" status line, every HEARTBEAT_MS from its own loop (see
   *  SchedulerLoop) — so it keeps coming even while a check is wedged. */
  heartbeat(): void {
    this.logStatus(this.clock(), "alive");
  }

  /** One status line per enabled job, so the app log shows what the scheduler
   *  believed at that moment: "We Are Monad › Morning briefing: done today". */
  private logStatus(now: Date, label: string): void {
    const today = localDateKey(now);
    const running = new Set(
      [...this.owned.values()].map((r) => `${r.workspaceId}:${r.jobId}`),
    );
    const jobs = this.workspaces.list().flatMap((ws) =>
      ws.jobs
        .filter((j) => j.enabled)
        .map((job) => {
          const key = `${ws.id}:${job.id}`;
          const hold = this.retryAfter.get(key) ?? 0;
          const next = nextJobRun(job, now);
          const nextLabel = next
            ? `next ${next.toLocaleDateString("en-GB", { weekday: "short" })} ${hhmm(next)}`
            : "no days selected";
          const status = running.has(key)
            ? "running"
            : job.lastSuccessDate === today
              ? "done today"
              : job.lastRunDate === today
                ? // addJob's stamp, not an attempt: added after its time
                  job.addedDate === today
                  ? `added after today's time — ${nextLabel}`
                  : "started today, not finished"
                : isJobDue(job, now)
                  ? hold > now.getTime()
                    ? `due, retrying at ${hhmm(new Date(hold))}`
                    : "due"
                  : job.days.includes(now.getDay())
                    ? `due at ${hhmm(new Date(0, 0, 0, job.hour, job.minute))}`
                    : `not scheduled today — ${nextLabel}`;
          return `${ws.name} › ${job.name}: ${status}`;
        }),
    );
    console.info(
      `[scheduler] ${label} — ${jobs.length ? jobs.join(" · ") : "no enabled jobs"}`,
    );
  }

  /** Point-in-time internals for Export Diagnostics: the in-memory state the
   *  log and files can't show (retry holds, attempt budgets, a stuck tick). */
  snapshot(): Record<string, unknown> {
    const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
    return {
      at: this.clock().toISOString(),
      lastTickAt: iso(this.lastTickAt),
      tickInProgress: this.ticking,
      tickStartedAt: iso(this.tickStartedAt),
      lastOnline: this.lastOnline,
      runs: [...this.owned].map(([runId, ctx]) => ({ runId, ...ctx })),
      attempts: Object.fromEntries(this.attempts),
      transientAttempts: Object.fromEntries(this.transientAttempts),
      retryAfter: Object.fromEntries(
        [...this.retryAfter].map(([k, ms]) => [k, iso(ms)]),
      ),
    };
  }

  /** A tick far later than the interval means the machine slept. Treat wake
   *  as a fresh opportunity: drop backoff holds so a job that failed offline
   *  before sleep is retried at once (the online probe still gates it). */
  private detectWake(nowMs: number): void {
    const gap = this.lastTickAt ? nowMs - this.lastTickAt : 0;
    this.lastTickAt = nowMs;
    if (gap > WAKE_GAP_MS) {
      this.retryAfter.clear();
      console.info(
        `[scheduler] wake detected (${Math.round(gap / 60_000)} min gap) — re-checking due jobs`,
      );
    }
  }
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Code-composed thread title for a scheduled run: "Aug 21 · Morning briefing".
 *  Composed here — never by the model — so titling costs zero tokens. */
export function runTitle(jobName: string, d: Date): string {
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date} · ${jobName}`;
}

/** Local-clock date key (YYYY-MM-DD). The weekday/hour checks below use the
 *  local clock, so the "already ran today" guard MUST too — a UTC key
 *  (toISOString) rolls over at a different instant and, east of UTC, lets a job
 *  whose hour is before the offset fire twice in one local day. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Pure due check: enabled, right weekday, not yet run today, time reached. */
export function isJobDue(job: ScheduledJob, now: Date): boolean {
  if (!job.enabled) return false;
  if (job.lastRunDate === localDateKey(now)) return false;
  if (!job.days.includes(now.getDay())) return false;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return minutesNow >= job.hour * 60 + job.minute;
}

export type NotifyOpts = {
  /** Suppress the notification while the user is already looking at the
   *  relevant UI (anti-flood): `true` = whenever the app is frontmost; a
   *  workspaceId = only when frontmost AND that workspace is the active one
   *  (its panels/chat already show the outcome). Omit for notifications that
   *  ARE the feedback channel (menu actions) or report failures. */
  quietWhenFocused?: true | string;
};

/** Fed by index.ts: the renderer reports focus/blur over RPC. Assumes focused
 *  at launch (the window opens frontmost). */
let appFocused = true;
export function setAppFocused(focused: boolean): void {
  appFocused = focused;
}
/** Injected once at startup so workspace-scoped quieting reads the active
 *  workspace live instead of chasing every switch site. */
let activeWorkspaceIdProvider: () => string | null = () => null;
export function setActiveWorkspaceProvider(fn: () => string | null): void {
  activeWorkspaceIdProvider = fn;
}

/** Native notification poster, injected by index.ts (Electrobun's
 *  Utils.showNotification). Injected rather than imported: Electrobun 2's SDK
 *  opens its native library as soon as it is imported, which fails outside the
 *  app — this module must stay loadable in tests. Unset → osascript fallback. */
let showNativeNotification:
  | ((n: { title: string; body: string }) => void)
  | null = null;
export function setNativeNotifier(
  fn: (n: { title: string; body: string }) => void,
): void {
  showNativeNotification = fn;
}

/** Desktop notification. Native via Electrobun first: posted by the app
 *  process itself, so it carries Monad's icon and clicking it activates Monad.
 *  The old osascript path stays as a fallback for FFI failures — those
 *  notifications wear Script Editor's identity (icon + click target), which is
 *  why they're last resort only. The system shows the app name already, so the
 *  old "Monad" title slot goes to the subtitle. */
export function notify(
  subtitle: string,
  message: string,
  opts?: NotifyOpts,
): void {
  const quiet = opts?.quietWhenFocused;
  const suppressed =
    !!quiet &&
    appFocused &&
    (quiet === true || activeWorkspaceIdProvider() === quiet);
  // Logged either way: a dismissed notification is otherwise gone for good.
  console.info(
    `[notify] ${subtitle}: ${message}${suppressed ? " (not shown — app in focus)" : ""}`,
  );
  if (suppressed) return; // the user is looking right at the in-app signal
  if (showNativeNotification) {
    try {
      showNativeNotification({ title: subtitle, body: message });
      return;
    } catch {
      // fall through to osascript
    }
  }
  // The no-op callback matters: without it, a spawn failure (osascript missing,
  // notifications denied) surfaces as an uncaught exception that can take down
  // the bun process.
  execFile(
    "osascript",
    [
      "-e",
      `display notification ${appleScriptString(message)} with title "Monad" subtitle ${appleScriptString(subtitle)}`,
    ],
    () => {},
  );
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
