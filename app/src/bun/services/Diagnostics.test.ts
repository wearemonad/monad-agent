import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exportDiagnostics,
  recentActivity,
  sleepWakeEvents,
} from "./Diagnostics";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const now = new Date(2026, 9, 2, 9, 30);
const line = (daysAgo: number, detail: string) =>
  JSON.stringify({
    ts: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    kind: "run-started",
    detail,
  });

describe("recentActivity", () => {
  test("keeps only the last 14 days", () => {
    const file = path.join(tmp("monad-act-"), "activity.jsonl");
    fs.writeFileSync(
      file,
      `${[line(30, "old"), line(13, "recent"), line(0, "today")].join("\n")}\n`,
    );
    const out = recentActivity(file, now);
    expect(out).not.toContain("old");
    expect(out).toContain("recent");
    expect(out).toContain("today");
  });

  test("missing file → empty", () => {
    expect(recentActivity("/nonexistent/activity.jsonl", now)).toBe("");
  });
});

describe("exportDiagnostics", () => {
  test("zips the log, scheduler state, jobs, claims and recent activity", () => {
    const outDir = tmp("monad-out-");
    const logDir = tmp("monad-logs-");
    fs.writeFileSync(path.join(logDir, "monad.log"), "hello log\n");
    fs.writeFileSync(path.join(logDir, "other.txt"), "not ours\n");
    const stateFile = path.join(tmp("monad-cfg-"), "scheduler-runs.json");
    fs.writeFileSync(stateFile, '{"runs":[]}');
    const ws = tmp("monad-ws-");
    fs.mkdirSync(path.join(ws, ".monad", "job-claims"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".monad", "job-claims", "j1-2026-10-02"),
      "4242",
    );
    fs.writeFileSync(
      path.join(ws, ".monad", "activity.jsonl"),
      `${line(0, "briefing")}\n`,
    );
    fs.writeFileSync(path.join(ws, ".env"), "SECRET=1\n");

    const zip = exportDiagnostics({
      outDir,
      logDir,
      now,
      about: { appVersion: "0.3.0" },
      schedulerStateFile: stateFile,
      schedulerLive: { tickInProgress: false },
      powerLog: () =>
        "2026-10-02 07:09:30 +0100 DarkWake            \tDarkWake from Deep Idle\n",
      workspaces: [
        {
          name: "We Are Monad",
          path: ws,
          jobs: [
            {
              id: "j1",
              name: "Morning briefing",
              prompt: "p".repeat(500),
              hour: 9,
              minute: 0,
              days: [1, 2, 3, 4, 5],
              enabled: true,
              lastRunDate: "2026-10-01",
            },
          ],
        },
      ],
    });

    expect(path.basename(zip)).toBe("Monad-diagnostics-2026-10-02-0930.zip");
    const unzipped = tmp("monad-unzip-");
    execFileSync("/usr/bin/ditto", ["-x", "-k", zip, unzipped]);
    const root = path.join(unzipped, "Monad-diagnostics-2026-10-02-0930");
    const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

    expect(JSON.parse(read("about.json")).appVersion).toBe("0.3.0");
    expect(read("app-log/monad.log")).toBe("hello log\n");
    expect(fs.existsSync(path.join(root, "app-log/other.txt"))).toBe(false);
    expect(read("scheduler/scheduler-runs.json")).toBe('{"runs":[]}');
    expect(JSON.parse(read("scheduler/live-state.json"))).toEqual({
      tickInProgress: false,
    });
    expect(read("sleep-wake.txt")).toContain("DarkWake from Deep Idle");
    const wsDir = "workspaces/1-We_Are_Monad";
    const [job] = JSON.parse(read(`${wsDir}/jobs.json`));
    expect(job.lastRunDate).toBe("2026-10-01");
    expect(job.prompt.length).toBe(200);
    expect(JSON.parse(read(`${wsDir}/job-claims.json`))[0]).toMatchObject({
      claim: "j1-2026-10-02",
      pid: "4242",
    });
    expect(read(`${wsDir}/activity.jsonl`)).toContain("briefing");
    // nothing beyond what's listed — no .env, no transcripts
    expect(fs.readdirSync(path.join(root, wsDir)).sort()).toEqual([
      "activity.jsonl",
      "job-claims.json",
      "jobs.json",
      "workspace.json",
    ]);

    // a second export the same minute doesn't overwrite the first
    const again = exportDiagnostics({
      outDir,
      logDir,
      now,
      about: {},
      schedulerStateFile: stateFile,
      powerLog: () => {
        throw new Error("pmset missing");
      },
      workspaces: [],
    });
    expect(path.basename(again)).toBe(
      "Monad-diagnostics-2026-10-02-0930 2.zip",
    );
  });
});

describe("sleepWakeEvents", () => {
  const log = [
    "2026-09-25 08:00:00 +0100 Sleep               \tEntering Sleep state (too old)",
    "2026-10-01 22:10:00 +0100 Sleep               \tEntering Sleep state due to 'Clamshell Sleep'",
    "2026-10-02 06:36:31 +0100 DarkWake            \tDarkWake from Deep Idle [CDNP]",
    "2026-10-02 06:36:35 +0100 Wake Requests       \t[process=dasd request=SleepService]",
    "2026-10-02 07:23:49 +0100 Wake                \tWake from Deep Idle [CDNVA] : lid",
    "2026-10-02 07:23:49 +0100 WakeDetails         \tDriverReason:smc",
    "Total Sleep/Wakes since boot:42",
  ].join("\n");

  test("keeps Sleep / DarkWake / Wake from the last 3 days, nothing else", () => {
    const out = sleepWakeEvents(log, now).trim().split("\n");
    expect(out.map((l) => l.split("\t")[1])).toEqual([
      "Entering Sleep state due to 'Clamshell Sleep'",
      "DarkWake from Deep Idle [CDNP]",
      "Wake from Deep Idle [CDNVA] : lid",
    ]);
  });

  test("says so when there is nothing", () => {
    expect(sleepWakeEvents("", now)).toContain("no sleep/wake events");
  });
});
