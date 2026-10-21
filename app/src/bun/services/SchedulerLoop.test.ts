import { afterEach, describe, expect, test } from "bun:test";
import { HEARTBEAT_MS } from "./SchedulerService";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { backgroundLoops } from "../runtime/BackgroundLoops";
import {
  type SchedulerDriver,
  schedulerLoops,
  TICK_TIMEOUT_MS,
} from "./SchedulerLoop";

/** Every log line Effect emitted, as `Level message`. */
let logs: string[] = [];
let rt: ManagedRuntime.ManagedRuntime<TestClock.TestClock, never> | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

/** Run the scheduler's loops under a TestClock. */
async function runLoops(driver: SchedulerDriver) {
  logs = [];
  rt = ManagedRuntime.make(
    backgroundLoops(schedulerLoops(driver)).pipe(
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(
        Logger.layer([
          Logger.make((o) => {
            const parts = Array.isArray(o.message) ? o.message : [o.message];
            logs.push(`${o.logLevel} ${parts.join(" ")}`);
          }),
        ]),
      ),
    ),
  );
  await rt.runPromise(Effect.void);
  const runtime = rt;
  return async (ms: number) => {
    for (let left = ms; left > 0; left -= 10_000) {
      await runtime.runPromise(TestClock.adjust(Math.min(10_000, left)));
      await Bun.sleep(0);
    }
  };
}

describe("schedulerLoops", () => {
  test("the first check runs 15 s after launch, then every minute", async () => {
    let ticks = 0;
    const advance = await runLoops({
      tick: async () => void ticks++,
      heartbeat: () => {},
    });
    await advance(14_000);
    expect(ticks).toBe(0);
    await advance(1_000);
    expect(ticks).toBe(1);
    await advance(3 * 60_000);
    expect(ticks).toBe(4);
  });

  test("a check stuck past its timeout is abandoned and the next one runs", async () => {
    let ticks = 0;
    let abandoned = false;
    const advance = await runLoops({
      tick: (_now, signal) => {
        ticks++;
        if (ticks > 1) return Promise.resolve();
        // The first check hangs (e.g. a probe that ignores its timeout).
        return new Promise<void>(() =>
          signal.addEventListener("abort", () => (abandoned = true)),
        );
      },
      heartbeat: () => {},
    });
    await advance(15_000 + TICK_TIMEOUT_MS);
    expect(abandoned).toBe(true);
    expect(logs).toEqual([
      `Warn [scheduler tick] run timed out after ${TICK_TIMEOUT_MS / 1000}s`,
    ]);
    await advance(60_000);
    expect(ticks).toBe(2);
  });

  test("the heartbeat logs every 30 minutes, even while every check hangs", async () => {
    let beats = 0;
    const advance = await runLoops({
      tick: () => new Promise<void>(() => {}),
      heartbeat: () => void beats++,
    });
    await advance(HEARTBEAT_MS - 10_000);
    expect(beats).toBe(0);
    await advance(10_000);
    expect(beats).toBe(1);
    await advance(2 * HEARTBEAT_MS);
    expect(beats).toBe(3);
  });
});

// ---- end to end: the real scheduler on its real loops ----
// Effect's TestClock paces the loops; `world.wallMs` is the wall clock the
// scheduler reads. They advance together while the machine is awake; during
// OS sleep the wall clock jumps and no timer fires.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spyOn } from "bun:test";
import type { ScheduledJob } from "../../shared/ipc";
import type { AgentService } from "./AgentService";
import { localDateKey, SchedulerService } from "./SchedulerService";
import type { WorkspaceManager } from "./WorkspaceManager";

const job = (patch: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: "j1",
  name: "Briefing",
  prompt: "run it",
  hour: 8,
  minute: 0,
  days: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
  ...patch,
});

type World = { wallMs: number };

/** One app process's scheduler over a workspace folder. Its job registry is
 *  its own (as each process's config is); the folder — claims — is shared. */
function liveScheduler(
  world: World,
  o: {
    jobs: ScheduledJob[];
    wsPath?: string;
    stateFile?: string;
    online?: () => boolean;
  },
) {
  const started: Date[] = [];
  const wsPath =
    o.wsPath ?? fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-ws-"));
  const find = (jobId: string) => o.jobs.find((j) => j.id === jobId);
  const workspaces = {
    list: () => [{ id: "ws1", name: "Main", path: wsPath, jobs: o.jobs }],
    markJobRan: (_ws: string, jobId: string, date: string) => {
      const j = find(jobId);
      if (j) j.lastRunDate = date;
    },
    markJobSucceeded: (_ws: string, jobId: string, date: string) => {
      const j = find(jobId);
      if (j) j.lastSuccessDate = j.lastRunDate = date;
    },
    clearJobRan: (_ws: string, jobId: string) => {
      const j = find(jobId);
      if (j) delete j.lastRunDate;
    },
  } as unknown as WorkspaceManager;
  const agent = {
    startRun: () => {
      started.push(new Date(world.wallMs));
      return `run-${started.length}`;
    },
  } as unknown as AgentService;
  const scheduler = new SchedulerService(
    workspaces,
    agent,
    () => {},
    () => {},
    o.stateFile ?? null,
    () => {},
    null,
    () => {},
    null,
    async () => o.online?.() ?? true,
    () => new Date(world.wallMs),
  );
  return { scheduler, started, wsPath };
}

/** Launch the schedulers (start + their loops) and return the clock controls. */
async function launch(world: World, ...schedulers: SchedulerService[]) {
  for (const s of schedulers) s.start();
  rt = ManagedRuntime.make(
    backgroundLoops(
      schedulers.flatMap((s) =>
        schedulerLoops({
          tick: (now, signal) => s.tick(now, signal),
          heartbeat: () => s.heartbeat(),
        }),
      ),
    ).pipe(Layer.provideMerge(TestClock.layer())),
  );
  await rt.runPromise(Effect.void);
  const runtime = rt;
  return {
    /** Awake time passing (the loops tick every minute). */
    advance: async (ms: number) => {
      for (let left = ms; left > 0; left -= 30_000) {
        const step = Math.min(30_000, left);
        world.wallMs += step;
        await runtime.runPromise(TestClock.adjust(step));
        await Bun.sleep(0);
      }
    },
    /** The lid closed: wall time moves, timers don't. */
    osSleep: (ms: number) => {
      world.wallMs += ms;
    },
  };
}

const MIN = 60_000;
const quiet = () => [
  spyOn(console, "info").mockImplementation(() => {}),
  spyOn(console, "warn").mockImplementation(() => {}),
];

describe("the scheduler on its loops (TestClock)", () => {
  let restore: Array<{ mockRestore: () => void }> = [];
  const priorTz = process.env.TZ;
  afterEach(() => {
    for (const r of restore) r.mockRestore();
    process.env.TZ = priorTz;
  });

  test("asleep through 08:00: the briefing starts within a minute of waking", async () => {
    restore = quiet();
    const world = { wallMs: new Date(2026, 6, 6, 7, 55).getTime() };
    const { scheduler, started } = liveScheduler(world, { jobs: [job()] });
    const { advance, osSleep } = await launch(world, scheduler);
    await advance(3 * MIN); // 07:58
    osSleep(77 * MIN); // wakes at 09:15
    expect(started).toEqual([]);
    await advance(MIN);
    expect(started.length).toBe(1);
    expect(started[0].getHours()).toBe(9);
  });

  test("local midnight: yesterday's run doesn't block today's, once", async () => {
    restore = quiet();
    const monday = new Date(2026, 6, 6, 23, 58);
    const world = { wallMs: monday.getTime() };
    const { scheduler, started } = liveScheduler(world, {
      jobs: [job({ lastRunDate: localDateKey(monday) })],
    });
    const { advance } = await launch(world, scheduler);
    await advance(8 * 60 * MIN); // Tuesday 07:58
    expect(started).toEqual([]);
    await advance(3 * MIN);
    expect(started.length).toBe(1);
    await advance(60 * MIN);
    expect(started.length).toBe(1);
    expect(started[0].getDate()).toBe(7);
  });

  test("DST spring forward: a 01:30 job (a time that doesn't exist) runs once, at 02:00", async () => {
    restore = quiet();
    process.env.TZ = "Europe/London";
    // Sunday 28 Mar 2027: clocks jump 01:00 GMT → 02:00 BST.
    const world = { wallMs: new Date(2027, 2, 28, 0, 50).getTime() };
    const { scheduler, started } = liveScheduler(world, {
      jobs: [job({ hour: 1, minute: 30 })],
    });
    const { advance } = await launch(world, scheduler);
    await advance(2 * 60 * MIN);
    expect(started.length).toBe(1);
    expect(started[0].getHours()).toBe(2);
    expect(started[0].getMinutes()).toBeLessThan(2);
  });

  test("DST fall back: a 01:30 job runs once, not again in the repeated hour", async () => {
    restore = quiet();
    process.env.TZ = "Europe/London";
    // Sunday 25 Oct 2026: clocks fall back 02:00 BST → 01:00 GMT.
    const world = { wallMs: new Date(2026, 9, 25, 0, 50).getTime() };
    const { scheduler, started } = liveScheduler(world, {
      jobs: [job({ hour: 1, minute: 30 })],
    });
    const { advance } = await launch(world, scheduler);
    await advance(3 * 60 * MIN); // through both 01:30s
    expect(started.length).toBe(1);
    expect(started[0].getTimezoneOffset()).toBe(-60); // the first, BST, 01:30
  });

  test("offline at wake: the job waits, then starts once the network is back", async () => {
    restore = quiet();
    let online = false;
    const world = { wallMs: new Date(2026, 6, 6, 9, 10).getTime() };
    const { scheduler, started } = liveScheduler(world, {
      jobs: [job()],
      online: () => online,
    });
    const { advance } = await launch(world, scheduler);
    await advance(10 * MIN);
    expect(started).toEqual([]);
    online = true;
    await advance(MIN);
    expect(started.length).toBe(1);
  });

  test("a run that died with the previous launch is re-run on the first check", async () => {
    restore = quiet();
    const world = { wallMs: new Date(2026, 6, 6, 9, 15).getTime() };
    const today = localDateKey(new Date(world.wallMs));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-"));
    const stateFile = path.join(dir, "scheduler-runs.json");
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "monad-sched-ws-"));
    // The previous launch claimed and stamped today's run, then died.
    const claims = path.join(wsPath, ".monad", "job-claims");
    fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(
      path.join(claims, `j1-${today}`),
      String(Bun.spawnSync(["true"]).pid),
    );
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runs: [
          {
            runId: "dead-1",
            jobName: "Briefing",
            workspaceName: "Main",
            workspaceId: "ws1",
            workspacePath: wsPath,
            jobId: "j1",
            kind: "briefing",
            date: today,
          },
        ],
      }),
    );
    const { scheduler, started } = liveScheduler(world, {
      jobs: [job({ lastRunDate: today })],
      wsPath,
      stateFile,
    });
    const { advance } = await launch(world, scheduler);
    await advance(15_000);
    expect(started.length).toBe(1);
  });

  test("two app processes on one workspace: the job runs exactly once", async () => {
    restore = quiet();
    const world = { wallMs: new Date(2026, 6, 6, 9, 15).getTime() };
    const a = liveScheduler(world, { jobs: [job()] });
    const b = liveScheduler(world, { jobs: [job()], wsPath: a.wsPath });
    const { advance } = await launch(world, a.scheduler, b.scheduler);
    await advance(10 * MIN);
    expect(a.started.length + b.started.length).toBe(1);
  });
});
