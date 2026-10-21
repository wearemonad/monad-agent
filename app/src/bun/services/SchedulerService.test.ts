import { describe, expect, test } from "bun:test";
import { isJobDue, localDateKey } from "./SchedulerService";
import { nextJobRun, type ScheduledJob } from "../../shared/ipc";

const job = (patch: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: "j1",
  name: "Briefing",
  prompt: "run it",
  hour: 8,
  minute: 0,
  days: [1, 2, 3, 4, 5],
  enabled: true,
  ...patch,
});

// Monday 2026-07-06 09:15 local time
const monday0915 = new Date(2026, 6, 6, 9, 15);
const monday0700 = new Date(2026, 6, 6, 7, 0);
const sunday1200 = new Date(2026, 6, 5, 12, 0);

describe("nextJobRun", () => {
  test("weekday job on a weekend → Monday at its time", () => {
    expect(nextJobRun(job(), sunday1200)).toEqual(new Date(2026, 6, 6, 8, 0));
  });

  test("past its time and unstamped → today's slot, i.e. due now", () => {
    const next = nextJobRun(job(), monday0915)!;
    expect(next).toEqual(new Date(2026, 6, 6, 8, 0));
    expect(next <= monday0915).toBe(true);
  });

  test("stamped today → the next enabled day", () => {
    const stamped = job({ lastRunDate: localDateKey(monday0915) });
    expect(nextJobRun(stamped, monday0915)).toEqual(new Date(2026, 6, 7, 8, 0));
  });

  test("disabled or no days → null", () => {
    expect(nextJobRun(job({ enabled: false }), monday0915)).toBeNull();
    expect(nextJobRun(job({ days: [] }), monday0915)).toBeNull();
  });
});

describe("isJobDue", () => {
  test("fires at-or-after its time on an enabled day", () => {
    expect(isJobDue(job(), monday0915)).toBe(true);
  });

  test("does not fire before its time", () => {
    expect(isJobDue(job(), monday0700)).toBe(false);
  });

  test("does not fire on a disabled weekday", () => {
    expect(isJobDue(job(), sunday1200)).toBe(false);
  });

  test("does not fire when disabled", () => {
    expect(isJobDue(job({ enabled: false }), monday0915)).toBe(false);
  });

  test("fires only once per day (lastRunDate)", () => {
    const today = localDateKey(monday0915);
    expect(isJobDue(job({ lastRunDate: today }), monday0915)).toBe(false);
    expect(isJobDue(job({ lastRunDate: "2026-07-05" }), monday0915)).toBe(true);
  });

  test("exact minute counts as due (catch-up semantics)", () => {
    expect(isJobDue(job(), new Date(2026, 6, 6, 8, 0))).toBe(true);
  });

  // H10: the "already ran today" guard must key off the LOCAL date, matching
  // the local weekday/hour checks. A UTC key rolls over at a different instant
  // and, east of UTC, would let a morning job fire twice in one local day.
  test("the run guard uses the local date, not UTC", () => {
    const local = new Date(2026, 6, 6, 9, 15); // local Monday
    expect(localDateKey(local)).toBe("2026-07-06");
    expect(localDateKey(local)).toBe(
      `${local.getFullYear()}-07-0${local.getDate()}`,
    );
    // once marked ran for the local day, it stays not-due later that same day
    const ran = job({ lastRunDate: localDateKey(local) });
    expect(isJobDue(ran, local)).toBe(false);
    expect(isJobDue(ran, new Date(2026, 6, 6, 23, 59))).toBe(false);
  });
});

// ---- behavior: safeTools, retry-on-failure, orphan recovery ----

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ATTEMPTS_PER_DAY, SchedulerService } from "./SchedulerService";
import type { WorkspaceManager } from "./WorkspaceManager";
import type { AgentService } from "./AgentService";

/** Minimal fakes: a tiny in-memory job registry standing in for the
 *  WorkspaceManager (list/mark/clear), a run-id-minting agent, and
 *  recorders for every side channel (notices, renames, kinds, deletes). */
function makeScheduler(
  opts: {
    stateFile?: string;
    jobs?: ScheduledJob[];
    online?: () => Promise<boolean>;
    /** Stand-in for the transcript check "did the run save its output?". */
    delivered?: (cwd: string, sessionId: string) => boolean;
    /** Make agent.startRun throw (busy workspace, unusable auth). */
    startError?: string;
    /** Workspace dir to use (lets a test seed claims before construction). */
    wsPath?: string;
  } = {},
) {
  // Fake clock: starts at the real time (existing tests compare titles
  // against `new Date()`); tick(now) moves it so backoff/day checks agree.
  const clock = { now: new Date() };
  const cleared: Array<[string, string]> = [];
  const succeeded: Array<[string, string, string]> = [];
  const started: Array<Parameters<AgentService["startRun"]>[0]> = [];
  const notices: string[] = [];
  const renamed: Array<[string, string, string]> = [];
  const kinds: Array<[string, string, string]> = [];
  const deleted: Array<[string, string]> = [];
  const logged: string[] = [];
  let n = 0;
  const wsPath =
    opts.wsPath ?? fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-ws-"));
  const jobs = opts.jobs ?? [];
  const find = (jobId: string) => jobs.find((j) => j.id === jobId);
  const workspaces = {
    list: () => [{ id: "ws1", name: "Main", path: wsPath, jobs, active: true }],
    markJobRan: (_id: string, jobId: string, date: string) => {
      const j = find(jobId);
      if (j) j.lastRunDate = date;
    },
    markJobSucceeded: (id: string, jobId: string, date: string) => {
      succeeded.push([id, jobId, date]);
      const j = find(jobId);
      if (j) {
        j.lastRunDate = date;
        j.lastSuccessDate = date;
      }
    },
    clearJobRan: (id: string, jobId: string) => {
      cleared.push([id, jobId]);
      const j = find(jobId);
      if (j) delete j.lastRunDate;
    },
  } as unknown as WorkspaceManager;
  const agent = {
    startRun: (o: Parameters<AgentService["startRun"]>[0]) => {
      if (opts.startError) throw new Error(opts.startError);
      started.push(o);
      return `run-${++n}`;
    },
  } as unknown as AgentService;
  const scheduler = new SchedulerService(
    workspaces,
    agent,
    () => {},
    () => {},
    opts.stateFile ?? null,
    (_subtitle, message) => notices.push(message),
    async (cwd, sessionId, title) => {
      renamed.push([cwd, sessionId, title]);
      return true;
    },
    (cwd, sessionId, kind) => kinds.push([cwd, sessionId, kind]),
    async (cwd, sessionId) => {
      deleted.push([cwd, sessionId]);
      return true;
    },
    opts.online ?? (async () => true),
    () => clock.now,
    opts.delivered,
    (_cwd, entry) => logged.push(entry.detail),
  );
  const realTick = scheduler.tick.bind(scheduler);
  scheduler.tick = (now?: Date, signal?: AbortSignal) => {
    if (now) clock.now = now;
    return realTick(now, signal);
  };
  return {
    scheduler,
    clock,
    cleared,
    succeeded,
    started,
    notices,
    renamed,
    kinds,
    deleted,
    logged,
    jobs,
    wsPath,
  };
}

const jobRun = {
  workspaceId: "ws1",
  workspacePath: "/tmp/ws1",
  workspaceName: "Main",
  jobName: "Briefing",
  prompt: "run it",
  jobId: "j1",
};

describe("scheduled runs get the scheduled-safe tool policy", () => {
  test("outbox/artifacts writes allowed, knowledge writes and stray Bash denied", () => {
    const { scheduler, started } = makeScheduler();
    expect(scheduler.runBackground(jobRun)).toBe("run-1");
    const safeTools = started[0].safeTools!;
    expect(safeTools("Write", { file_path: "outbox/briefings/x.md" })).toBe(
      true,
    );
    expect(safeTools("Write", { file_path: "artifacts/x.html" })).toBe(true);
    expect(safeTools("Write", { file_path: "knowledge/x.md" })).toBe(false);
    expect(safeTools("Bash", { command: "curl https://evil.example" })).toBe(
      false,
    );
  });
});

describe("failed jobs retry, bounded per day", () => {
  test("a run-error re-arms the job until the budget is spent", () => {
    const { scheduler, cleared, notices } = makeScheduler();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_DAY; attempt++) {
      const runId = scheduler.runBackground(jobRun)!;
      expect(
        scheduler.handleEvent({ kind: "run-error", runId, error: "boom" }),
      ).toBe(true);
    }
    // re-armed after every failure except the last of the day
    expect(cleared).toEqual([
      ["ws1", "j1"],
      ["ws1", "j1"],
    ]);
    expect(notices[notices.length - 1]).toBe("Scheduled run failed.");
    expect(notices.slice(0, -1)).toEqual(
      Array(MAX_ATTEMPTS_PER_DAY - 1).fill(
        "Scheduled run failed — retrying shortly.",
      ),
    );
  });

  test("a success resets the attempt budget", () => {
    const { scheduler, cleared } = makeScheduler();
    let runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-error", runId, error: "boom" });
    runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s1",
      numTurns: 3,
    });
    for (let attempt = 1; attempt < MAX_ATTEMPTS_PER_DAY; attempt++) {
      runId = scheduler.runBackground(jobRun)!;
      scheduler.handleEvent({ kind: "run-error", runId, error: "boom" });
    }
    // 1 re-arm before the success + a fresh budget's worth after it
    expect(cleared.length).toBe(1 + (MAX_ATTEMPTS_PER_DAY - 1));
  });

  test("a user-stopped run is not retried", () => {
    const { scheduler, cleared, notices } = makeScheduler();
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({
      kind: "run-error",
      runId,
      error: "Stopped.",
      aborted: true,
    });
    expect(cleared).toEqual([]);
    expect(notices).toEqual(["Scheduled run stopped."]);
  });

  test("non-job runs (meeting prep) are never re-armed", () => {
    const { scheduler, cleared } = makeScheduler();
    const { jobId: _jobId, ...prepRun } = jobRun;
    const runId = scheduler.runBackground(prepRun)!;
    scheduler.handleEvent({ kind: "run-error", runId, error: "boom" });
    expect(cleared).toEqual([]);
  });
});

describe("orphaned runs are re-armed on the next launch", () => {
  test("in-flight ownership is persisted and cleared as runs settle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-"));
    const stateFile = path.join(dir, "scheduler-runs.json");
    const { scheduler } = makeScheduler({ stateFile });
    const runId = scheduler.runBackground(jobRun)!;
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).runs).toEqual([
      {
        runId,
        jobName: "Briefing",
        workspaceName: "Main",
        workspaceId: "ws1",
        workspacePath: "/tmp/ws1",
        kind: "scheduled",
        jobId: "j1",
      },
    ]);
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s1",
      numTurns: 3,
    });
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).runs).toEqual([]);
  });

  test("recoverOrphans clears the stamp for job runs only, then empties the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-"));
    const stateFile = path.join(dir, "scheduler-runs.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runs: [
          {
            runId: "dead-1",
            jobName: "Briefing",
            workspaceName: "Main",
            workspaceId: "ws1",
            jobId: "j1",
          },
          {
            runId: "dead-2",
            jobName: "Prep: standup",
            workspaceName: "Main",
            workspaceId: "ws1",
          },
        ],
      }),
    );
    const { scheduler, cleared } = makeScheduler({ stateFile });
    const orphans = scheduler.recoverOrphans();
    expect(orphans.length).toBe(2);
    expect(cleared).toEqual([["ws1", "j1"]]);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).runs).toEqual([]);
  });

  test("no state file → nothing to recover", () => {
    const { scheduler, cleared } = makeScheduler();
    expect(scheduler.recoverOrphans()).toEqual([]);
    expect(cleared).toEqual([]);
  });
});

// ---- cross-process once-only claims ----

import { claimOnce, releaseClaim } from "./SchedulerService";

describe("claimOnce", () => {
  test("first claim wins, the duplicate loses, release re-opens it", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-claim-"));
    expect(claimOnce(ws, "j1-2026-08-25")).toBe(true);
    // A second process (or tick) claiming the same job+day must lose.
    expect(claimOnce(ws, "j1-2026-08-25")).toBe(false);
    // Other keys are independent.
    expect(claimOnce(ws, "j1-2026-08-26")).toBe(true);
    expect(claimOnce(ws, "meeting-prep-evt1")).toBe(true);
    // Releasing (failed start / retry re-arm) lets the next claim through.
    releaseClaim(ws, "j1-2026-08-25");
    expect(claimOnce(ws, "j1-2026-08-25")).toBe(true);
  });

  test("weird keys are sanitized into safe filenames", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-claim-"));
    const key = "meeting-prep-abc/../..#?*evt";
    expect(claimOnce(ws, key)).toBe(true);
    expect(claimOnce(ws, key)).toBe(false);
    const claims = fs.readdirSync(path.join(ws, ".monad", "job-claims"));
    expect(claims.length).toBe(1);
    expect(claims[0]).not.toContain("/");
  });
});

// ---- code-composed thread titles + kind stamping ----

import { runTitle } from "./SchedulerService";
import { jobKind } from "../../shared/ipc";

describe("scheduled threads are titled in code and kind-stamped", () => {
  test("runTitle composes '<date> · <job name>' with no model involved", () => {
    const d = new Date(2026, 7, 21); // Aug 21
    const date = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(runTitle("Morning briefing", d)).toBe(`${date} · Morning briefing`);
  });

  test("jobKind: briefing jobs get their own kind, others are scheduled", () => {
    expect(jobKind(job({ name: "Morning briefing" }))).toBe("briefing");
    expect(
      jobKind(
        job({ name: "Digest", prompt: "run the morning-briefing skill" }),
      ),
    ).toBe("briefing");
    expect(jobKind(job({ name: "Weekly CRM status", prompt: "crm" }))).toBe(
      "scheduled",
    );
  });

  test("run-started renames the session once and records its kind", () => {
    const { scheduler, renamed, kinds } = makeScheduler();
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "s1" });
    // finish must not stamp a second time
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s1",
      numTurns: 3,
    });
    expect(kinds).toEqual([["/tmp/ws1", "s1", "scheduled"]]);
    expect(renamed).toEqual([
      ["/tmp/ws1", "s1", runTitle("Briefing", new Date())],
    ]);
  });

  test("run-started attaches the session id to the active-run info", () => {
    const { scheduler } = makeScheduler();
    const runId = scheduler.runBackground(jobRun)!;
    // Not yet known before the run reports its session.
    expect(scheduler.activeRunFor("ws1")?.sessionId).toBeUndefined();
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "s1" });
    expect(scheduler.activeRunFor("ws1")).toEqual({
      runId,
      jobName: "Briefing",
      sessionId: "s1",
    });
  });

  test("run-finished stamps as a backstop when run-started had no session id", () => {
    const { scheduler, renamed, kinds } = makeScheduler();
    const runId = scheduler.runBackground({
      ...jobRun,
      kind: "meeting-prep",
    })!;
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "" });
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s2",
      numTurns: 3,
    });
    expect(kinds).toEqual([["/tmp/ws1", "s2", "meeting-prep"]]);
    expect(renamed.length).toBe(1);
  });
});

// ---- catch-up on launch/wake, offline tolerance, transient retries ----

import {
  isTransientError,
  TRANSIENT_RETRY_BACKOFF_MS,
  WAKE_GAP_MS,
} from "./SchedulerService";

describe("isTransientError", () => {
  test("network / timeout / upstream trouble is transient", () => {
    for (const m of [
      "API Error: Connection error.",
      "fetch failed",
      "getaddrinfo ENOTFOUND api.anthropic.com",
      "read ECONNRESET",
      "connect ECONNREFUSED 127.0.0.1:11434",
      "Request timed out",
      "API Error: 529 Overloaded",
      "API Error: 503 Service Unavailable",
      "429 rate limit exceeded",
    ]) {
      expect([m, isTransientError(m)]).toEqual([m, true]);
    }
  });

  test("auth / config problems are not", () => {
    for (const m of [
      "API Error: 401 Unauthorized",
      "Invalid API key",
      "authentication_error: invalid x-api-key",
      "claude: command not found (ENOENT)",
      "boom",
      "error_max_turns",
    ]) {
      expect([m, isTransientError(m)]).toEqual([m, false]);
    }
  });
});

describe("catch-up on launch", () => {
  test("a job whose time passed today with no run yet fires on the first tick", async () => {
    const { scheduler, started, jobs } = makeScheduler({ jobs: [job()] });
    await scheduler.tick(monday0915);
    expect(started.length).toBe(1);
    expect(jobs[0].lastRunDate).toBe(localDateKey(monday0915));
  });

  test("no duplicate run once it already ran today", async () => {
    const { scheduler, started } = makeScheduler({
      jobs: [job({ lastRunDate: localDateKey(monday0915) })],
    });
    await scheduler.tick(monday0915);
    await scheduler.tick(new Date(2026, 6, 6, 12, 0));
    expect(started.length).toBe(0);
  });

  test("a job that started but has not finished is not started again", async () => {
    const { scheduler, started } = makeScheduler({ jobs: [job()] });
    await scheduler.tick(monday0915);
    await scheduler.tick(new Date(2026, 6, 6, 9, 16));
    expect(started.length).toBe(1);
  });

  test("a success stamps lastSuccessDate", async () => {
    const { scheduler, started, succeeded, jobs } = makeScheduler({
      jobs: [job()],
    });
    await scheduler.tick(monday0915);
    void started;
    scheduler.handleEvent({
      kind: "run-finished",
      runId: "run-1",
      sessionId: "s1",
      numTurns: 3,
    });
    expect(succeeded).toEqual([["ws1", "j1", localDateKey(monday0915)]]);
    expect(jobs[0].lastSuccessDate).toBe(localDateKey(monday0915));
  });
});

describe("offline: a due job waits instead of failing", () => {
  test("nothing starts while offline; it fires once the network is back", async () => {
    let online = false;
    const { scheduler, started, jobs } = makeScheduler({
      jobs: [job()],
      online: async () => online,
    });
    await scheduler.tick(monday0915);
    expect(started.length).toBe(0);
    expect(jobs[0].lastRunDate).toBeUndefined(); // still due
    online = true;
    await scheduler.tick(new Date(2026, 6, 6, 9, 16));
    expect(started.length).toBe(1);
  });
});

describe("transient failures retry silently and keep the job due", () => {
  test("an errored RESULT (API connection error) is a failure, not a finish", async () => {
    const { scheduler, started, notices, deleted, cleared, jobs, wsPath } =
      makeScheduler({ jobs: [job()] });
    await scheduler.tick(monday0915);
    scheduler.handleEvent({
      kind: "run-started",
      runId: "run-1",
      sessionId: "s1",
    });
    scheduler.handleEvent({
      kind: "run-finished",
      runId: "run-1",
      sessionId: "s1",
      numTurns: 1,
      error: "API Error: Connection error.",
    });
    // silent: no "finished"/"failed" notification
    expect(notices).toEqual([]);
    // the half-thread is erased
    expect(deleted).toEqual([[wsPath, "s1"]]);
    // still due (stamp cleared) but held back by backoff
    expect(cleared).toEqual([["ws1", "j1"]]);
    expect(jobs[0].lastRunDate).toBeUndefined();
    const hold = scheduler.retryAfterFor("ws1", "j1");
    expect(hold).toBe(monday0915.getTime() + TRANSIENT_RETRY_BACKOFF_MS[0]);
    // a tick inside the backoff window does not start anything…
    await scheduler.tick(new Date(monday0915.getTime() + 10_000));
    expect(started.length).toBe(1);
    // …a tick past it does (retry), and the claim was released so it isn't self-blocked
    await scheduler.tick(new Date(hold + 1000));
    expect(started.length).toBe(2);
  });

  test("a thrown transient error (run-error) behaves the same and backs off further each time", async () => {
    const { scheduler, notices, cleared, clock } = makeScheduler({
      jobs: [job()],
    });
    for (let i = 0; i < TRANSIENT_RETRY_BACKOFF_MS.length + 1; i++) {
      const runId = scheduler.runBackground(jobRun)!;
      scheduler.handleEvent({
        kind: "run-error",
        runId,
        error: "fetch failed",
      });
      const expected =
        TRANSIENT_RETRY_BACKOFF_MS[
          Math.min(i, TRANSIENT_RETRY_BACKOFF_MS.length - 1)
        ];
      expect(scheduler.retryAfterFor("ws1", "j1") - clock.now.getTime()).toBe(
        expected,
      );
    }
    expect(notices).toEqual([]);
    // unbounded within the day: re-armed every time, never "failed" for good
    expect(cleared.length).toBe(TRANSIENT_RETRY_BACKOFF_MS.length + 1);
  });

  test("transient attempts do not consume the non-transient daily budget", () => {
    const { scheduler, notices } = makeScheduler();
    for (let i = 0; i < MAX_ATTEMPTS_PER_DAY; i++) {
      const runId = scheduler.runBackground(jobRun)!;
      scheduler.handleEvent({ kind: "run-error", runId, error: "ECONNRESET" });
    }
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-error", runId, error: "boom" });
    expect(notices).toEqual(["Scheduled run failed — retrying shortly."]);
  });

  test("a success clears the backoff hold", () => {
    const { scheduler } = makeScheduler();
    let runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-error", runId, error: "fetch failed" });
    expect(scheduler.retryAfterFor("ws1", "j1")).toBeGreaterThan(0);
    runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s2",
      numTurns: 3,
    });
    expect(scheduler.retryAfterFor("ws1", "j1")).toBe(0);
  });

  test("non-transient failures keep their notification and stamped thread", () => {
    const { scheduler, notices, deleted, kinds } = makeScheduler();
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "s1" });
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s1",
      numTurns: 1,
      error: "API Error: 401 Unauthorized",
    });
    expect(notices).toEqual(["Scheduled run failed — retrying shortly."]);
    expect(deleted).toEqual([]);
    expect(kinds).toEqual([["/tmp/ws1", "s1", "scheduled"]]);
  });
});

describe("a run that delivered before erroring counts as done", () => {
  test("transient error after the briefing was saved: kept, marked done, not retried", () => {
    const { scheduler, notices, deleted, cleared, succeeded, kinds } =
      makeScheduler({
        jobs: [job()],
        delivered: (_cwd, sessionId) => sessionId === "s1",
      });
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "s1" });
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s1",
      numTurns: 9,
      error: "API Error: 529 overloaded",
    });
    expect(deleted).toEqual([]); // the thread holding the briefing stays
    expect(kinds).toEqual([["/tmp/ws1", "s1", "scheduled"]]);
    expect(cleared).toEqual([]); // not re-armed → no duplicate briefing
    expect(succeeded.map(([, jobId]) => jobId)).toEqual(["j1"]);
    expect(scheduler.retryAfterFor("ws1", "j1")).toBe(0);
    expect(notices).toEqual([
      "Scheduled run finished — open Monad to read it.",
    ]);
  });

  test("non-transient error after delivering is also done, not 'failed'", () => {
    const { scheduler, notices, cleared } = makeScheduler({
      delivered: () => true,
    });
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "s1" });
    scheduler.handleEvent({ kind: "run-error", runId, error: "boom" });
    expect(cleared).toEqual([]);
    expect(notices).toEqual([
      "Scheduled run finished — open Monad to read it.",
    ]);
  });

  test("nothing delivered: the transient path is unchanged (delete + backoff)", () => {
    const { scheduler, deleted, cleared } = makeScheduler({
      delivered: () => false,
    });
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "s1" });
    scheduler.handleEvent({
      kind: "run-finished",
      runId,
      sessionId: "s1",
      numTurns: 1,
      error: "API Error: Connection error.",
    });
    expect(deleted).toEqual([["/tmp/ws1", "s1"]]);
    expect(cleared).toEqual([["ws1", "j1"]]);
  });

  test("a user-stopped run is never treated as delivered", () => {
    const { scheduler, succeeded, notices } = makeScheduler({
      delivered: () => true,
    });
    const runId = scheduler.runBackground(jobRun)!;
    scheduler.handleEvent({ kind: "run-started", runId, sessionId: "s1" });
    scheduler.handleEvent({
      kind: "run-error",
      runId,
      error: "Stopped by the user.",
      aborted: true,
    });
    expect(succeeded).toEqual([]);
    expect(notices).toEqual(["Scheduled run stopped."]);
  });
});

describe("sleep/wake detection", () => {
  test("a tick after a long gap drops the backoff hold so the job retries at once", async () => {
    const { scheduler, started } = makeScheduler({ jobs: [job()] });
    const at = (min: number, ms = 0) =>
      new Date(monday0915.getTime() + min * 60_000 + ms);
    // Three transient failures in a row → a 5-minute hold (until 09:23).
    await scheduler.tick(at(0));
    scheduler.handleEvent({
      kind: "run-error",
      runId: "run-1",
      error: "fetch failed",
    });
    await scheduler.tick(at(1));
    scheduler.handleEvent({
      kind: "run-error",
      runId: "run-2",
      error: "fetch failed",
    });
    await scheduler.tick(at(3));
    scheduler.handleEvent({
      kind: "run-error",
      runId: "run-3",
      error: "fetch failed",
    });
    expect(started.length).toBe(3);
    expect(scheduler.retryAfterFor("ws1", "j1")).toBe(at(8).getTime());
    // A minute later: still held back.
    await scheduler.tick(at(4));
    expect(started.length).toBe(3);
    // The next tick arrives after a sleep-sized gap, still inside the hold:
    // wake → hold cleared → retried immediately.
    await scheduler.tick(at(4, WAKE_GAP_MS + 1));
    expect(scheduler.retryAfterFor("ws1", "j1")).toBe(0);
    expect(started.length).toBe(4);
  });
});

// ---- interrupted runs: the dead process's claim must not skip the day ----

/** A pid that is certainly not running: a process that already exited. */
function deadPid(): number {
  return Bun.spawnSync(["true"]).pid;
}

function seedClaim(wsPath: string, key: string, pid: number): void {
  const dir = path.join(wsPath, ".monad", "job-claims");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key), String(pid));
}

function seedOrphan(stateFile: string, run: Record<string, unknown>): void {
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      runs: [
        {
          runId: "dead-1",
          jobName: "Briefing",
          workspaceName: "Main",
          workspaceId: "ws1",
          jobId: "j1",
          kind: "briefing",
          ...run,
        },
      ],
    }),
  );
}

describe("a run interrupted by quit/restart is re-run on the next launch", () => {
  const today = localDateKey(monday0915);

  test("the dead process's claim is released, so the next tick fires the job", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-"));
    const stateFile = path.join(dir, "scheduler-runs.json");
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-ws-"));
    // The previous launch claimed today's run, stamped the job, then died.
    seedClaim(wsPath, `j1-${today}`, deadPid());
    seedOrphan(stateFile, { workspacePath: wsPath, date: today });
    const { scheduler, started, jobs, logged } = makeScheduler({
      stateFile,
      wsPath,
      jobs: [job({ lastRunDate: today })],
    });
    scheduler.recoverOrphans();
    expect(jobs[0].lastRunDate).toBeUndefined();
    await scheduler.tick(monday0915);
    expect(started.length).toBe(1);
    expect(jobs[0].lastRunDate).toBe(today);
    expect(logged.some((l) => l.includes("interrupted"))).toBe(true);
  });

  test("a claim held by a live process (second instance) is kept — no duplicate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-"));
    const stateFile = path.join(dir, "scheduler-runs.json");
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-ws-"));
    seedClaim(wsPath, `j1-${today}`, process.ppid);
    seedOrphan(stateFile, { workspacePath: wsPath, date: today });
    const { scheduler, started } = makeScheduler({
      stateFile,
      wsPath,
      jobs: [job({ lastRunDate: today })],
    });
    scheduler.recoverOrphans();
    await scheduler.tick(monday0915);
    expect(started.length).toBe(0);
  });

  test("an interrupted run that already delivered counts as done, not re-run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-"));
    const stateFile = path.join(dir, "scheduler-runs.json");
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-ws-"));
    seedClaim(wsPath, `j1-${today}`, deadPid());
    seedOrphan(stateFile, {
      workspacePath: wsPath,
      date: today,
      sessionId: "s-done",
    });
    const { scheduler, started, cleared, succeeded } = makeScheduler({
      stateFile,
      wsPath,
      jobs: [job({ lastRunDate: today })],
      delivered: (_cwd, sessionId) => sessionId === "s-done",
    });
    scheduler.recoverOrphans();
    expect(cleared).toEqual([]);
    expect(succeeded).toEqual([["ws1", "j1", today]]);
    await scheduler.tick(monday0915);
    expect(started.length).toBe(0);
  });

  test("the run's date and session id are persisted for recovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-"));
    const stateFile = path.join(dir, "scheduler-runs.json");
    const { scheduler } = makeScheduler({ stateFile, jobs: [job()] });
    await scheduler.tick(monday0915);
    scheduler.handleEvent({
      kind: "run-started",
      runId: "run-1",
      sessionId: "s1",
    });
    const [run] = JSON.parse(fs.readFileSync(stateFile, "utf8")).runs;
    expect(run.date).toBe(today);
    expect(run.sessionId).toBe("s1");
  });
});

describe("an abandoned check starts nothing", () => {
  test("a check whose signal aborts while probing the network starts no job", async () => {
    let answer: (online: boolean) => void = () => {};
    const { scheduler, started, jobs } = makeScheduler({
      jobs: [job()],
      online: () => new Promise<boolean>((r) => (answer = r)),
    });
    const abandon = new AbortController();
    const check = scheduler.tick(monday0915, abandon.signal);
    abandon.abort(); // the loop's timeout gave up on this check
    answer(true); // …and only then does the probe come back
    await check;
    expect(started).toEqual([]);
    expect(jobs[0].lastRunDate).toBeUndefined();
  });
});

describe("why a due job didn't start is logged once per day", () => {
  test("offline", async () => {
    const { scheduler, logged } = makeScheduler({
      jobs: [job()],
      online: async () => false,
    });
    await scheduler.tick(monday0915);
    await scheduler.tick(new Date(2026, 6, 6, 9, 16));
    expect(logged).toEqual(["Briefing is due — waiting for the network"]);
  });

  test("start failure (busy workspace / auth) keeps the job due", async () => {
    const { scheduler, logged, jobs } = makeScheduler({
      jobs: [job()],
      startError: "A background run is already active in this workspace.",
    });
    await scheduler.tick(monday0915);
    await scheduler.tick(new Date(2026, 6, 6, 9, 16));
    expect(jobs[0].lastRunDate).toBeUndefined();
    expect(logged).toEqual([
      "Briefing is due but could not start: A background run is already active in this workspace.",
    ]);
  });
});

// ---- stalled background runs ----
// The stall watchdog itself (20 silent minutes, sleep-aware, user stop vs
// timeout) is tested through BackgroundRuns.test.ts and oneShotRun.test.ts.
// What the scheduler relies on is the wording of its error:

import { STALL_ERROR } from "./AgentService";

describe("a stalled background run", () => {
  test("is retried quietly: its error matches the transient matcher", () => {
    expect(isTransientError(STALL_ERROR)).toBe(true);
  });
});

// ---- the app log can tell "nothing was due" from "the scheduler stopped" ----

import { spyOn } from "bun:test";
import { HEARTBEAT_MS, notify, setAppFocused } from "./SchedulerService";

/** Capture console.info/error lines for the duration of fn. */
async function captureLog(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((...a) => {
    lines.push(a.join(" "));
  });
  const error = spyOn(console, "error").mockImplementation((...a) => {
    lines.push(a.join(" "));
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn();
  } finally {
    info.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
  return lines;
}

// Scheduled jobs belong to their workspace, not to whichever one is open: every
// workspace with an enabled job gets its run, and a disabled one gets none.
describe("multiple workspaces", () => {
  test("fires each workspace's enabled job, active or not; skips disabled", async () => {
    const dir = (name: string) =>
      fs.mkdtempSync(path.join(os.tmpdir(), `monad-sched-${name}-`));
    const list = [
      {
        id: "a",
        name: "Active",
        path: dir("a"),
        active: true,
        jobs: [job({ id: "ja" })],
      },
      {
        id: "b",
        name: "Background",
        path: dir("b"),
        active: false,
        jobs: [job({ id: "jb" })],
      },
      {
        id: "c",
        name: "Off",
        path: dir("c"),
        active: false,
        jobs: [job({ id: "jc", enabled: false })],
      },
    ];
    const started: string[] = [];
    let n = 0;
    const scheduler = new SchedulerService(
      {
        list: () => list,
        markJobRan: (id: string, jobId: string, date: string) => {
          const j = list
            .find((w) => w.id === id)
            ?.jobs.find((x) => x.id === jobId);
          if (j) j.lastRunDate = date;
        },
      } as unknown as WorkspaceManager,
      {
        startRun: (o: { workspaceId: string }) => {
          started.push(o.workspaceId);
          return `run-${++n}`;
        },
      } as unknown as AgentService,
      () => {},
      () => {},
      null,
      () => {},
      null,
      () => {},
      null,
      async () => true,
      () => monday0915,
    );
    await captureLog(() => scheduler.tick(monday0915));
    expect(started.sort()).toEqual(["a", "b"]);
  });
});

describe("scheduler status in the app log", () => {
  // The 30-minute cadence is the heartbeat loop's (SchedulerLoop.test.ts).
  test("heartbeat() writes the status line; checks don't", async () => {
    const { scheduler, clock } = makeScheduler({
      jobs: [
        job({
          lastRunDate: localDateKey(monday0915),
          lastSuccessDate: localDateKey(monday0915),
        }),
      ],
    });
    const lines = await captureLog(async () => {
      await scheduler.tick(monday0915);
      await scheduler.tick(new Date(monday0915.getTime() + HEARTBEAT_MS));
      clock.now = new Date(monday0915.getTime() + HEARTBEAT_MS);
      scheduler.heartbeat();
    });
    const alive = lines.filter((l) => l.includes("[scheduler] alive"));
    expect(alive.length).toBe(1);
    expect(alive[0]).toContain("Main › Briefing: done today");
  });

  test("job states: due later today / not today / due", async () => {
    const { scheduler, clock } = makeScheduler({ jobs: [job()] });
    clock.now = monday0700;
    const early = await captureLog(() => scheduler.heartbeat());
    expect(early.join("\n")).toContain("Briefing: due at 08:00");
    const { scheduler: s2, clock: c2 } = makeScheduler({ jobs: [job()] });
    c2.now = sunday1200;
    const sunday = await captureLog(() => s2.heartbeat());
    expect(sunday.join("\n")).toContain(
      "Briefing: not scheduled today — next Mon 08:00",
    );
  });

  // addJob stamps a job added after its time so it waits for its next
  // occurrence — that stamp must not read as an interrupted run.
  test("a job added after today's time says so, not 'started, not finished'", async () => {
    const today = localDateKey(monday0915);
    const { scheduler, clock } = makeScheduler({
      jobs: [job({ addedDate: today, lastRunDate: today })],
    });
    clock.now = monday0915;
    const lines = (await captureLog(() => scheduler.heartbeat())).join("\n");
    expect(lines).toContain(
      "Briefing: added after today's time — next Tue 08:00",
    );
    expect(lines).not.toContain("started today, not finished");
  });

  test("starting and finishing a run are both logged", async () => {
    const { scheduler } = makeScheduler({ jobs: [job()] });
    const lines = await captureLog(async () => {
      await scheduler.tick(monday0915);
      scheduler.handleEvent({
        kind: "run-finished",
        runId: "run-1",
        sessionId: "s1",
        numTurns: 2,
      });
    });
    expect(lines).toContain("[scheduler] starting Briefing (Main) — run run-1");
    expect(lines).toContain("[scheduler] Briefing (Main): succeeded");
  });

  // A check that never finishes: abandoned after TICK_TIMEOUT_MS by its
  // loop, logged, and the next check runs — SchedulerLoop.test.ts.

  test("network changes are logged", async () => {
    let online = false;
    const { scheduler } = makeScheduler({
      jobs: [job()],
      online: async () => online,
    });
    const lines = await captureLog(async () => {
      await scheduler.tick(monday0915);
      online = true;
      await scheduler.tick(new Date(2026, 6, 6, 9, 16));
    });
    expect(lines).toContain("[scheduler] network is back");
  });

  test("snapshot exposes the in-memory state", async () => {
    const { scheduler } = makeScheduler({ jobs: [job()] });
    await captureLog(() => scheduler.tick(monday0915));
    scheduler.handleEvent({
      kind: "run-error",
      runId: "run-1",
      error: "fetch failed",
    });
    const snap = scheduler.snapshot() as any;
    expect(snap.tickInProgress).toBe(false);
    expect(snap.lastOnline).toBe(true);
    expect(Object.keys(snap.retryAfter)).toEqual(["ws1:j1"]);
    expect(snap.transientAttempts["ws1:j1"].count).toBe(1);
  });
});

describe("notifications are logged, shown or not", () => {
  test("a suppressed notification still leaves a log line", async () => {
    setAppFocused(true);
    const lines = await captureLog(() =>
      notify("Main: Briefing", "Scheduled run finished.", {
        quietWhenFocused: true,
      }),
    );
    expect(lines).toEqual([
      "[notify] Main: Briefing: Scheduled run finished. (not shown — app in focus)",
    ]);
  });
});
