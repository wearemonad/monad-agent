import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ScheduledJob } from "../../shared/ipc";
import { LOG_DIR, redactSecrets } from "./AppLog";

/** How much workspace history a bundle carries — enough to cover "it didn't
 *  run last Tuesday" without shipping months of activity. */
const ACTIVITY_DAYS = 14;
const ACTIVITY_MAX_LINES = 5_000;
/** Read at most this much of an activity log's tail (it is append-only). */
const ACTIVITY_TAIL_BYTES = 8 * 1024 * 1024;

export type DiagnosticsInput = {
  /** Folder the zip is written to (Desktop by default). */
  outDir?: string;
  /** App/runtime facts for about.json — must hold no secrets. */
  about: Record<string, unknown>;
  workspaces: Array<{ name: string; path: string; jobs: ScheduledJob[] }>;
  /** In-flight scheduled runs (CONFIG_DIR/scheduler-runs.json). */
  schedulerStateFile: string;
  /** The running scheduler's in-memory state (SchedulerService.snapshot). */
  schedulerLive?: unknown;
  /** macOS power log text; defaults to `pmset -g log`. Injected by tests. */
  powerLog?: () => string;
  logDir?: string;
  now?: Date;
};

/** Bundle everything needed to debug "what happened" into one zip a
 *  colleague can send: the app log, scheduler state, each workspace's jobs,
 *  claims and recent activity. Deliberately excluded: API keys, OAuth
 *  tokens, .env files, transcripts, knowledge/ and outbox/ content. Returns
 *  the zip's path; throws when the zip can't be written. */
export function exportDiagnostics(input: DiagnosticsInput): string {
  const now = input.now ?? new Date();
  const stamp = stampOf(now);
  const name = `Monad-diagnostics-${stamp}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "monad-diag-"));
  const root = path.join(staging, name);
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "README.txt"), readme(now));
    writeJson(path.join(root, "about.json"), {
      generatedAt: now.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...input.about,
    });

    // App log (current + rotated), already secret-redacted as written.
    const logDir = input.logDir ?? LOG_DIR;
    const logOut = path.join(root, "app-log");
    fs.mkdirSync(logOut);
    for (const f of safeReaddir(logDir)) {
      if (f.startsWith("monad.log")) {
        fs.copyFileSync(path.join(logDir, f), path.join(logOut, f));
      }
    }

    const schedOut = path.join(root, "scheduler");
    fs.mkdirSync(schedOut);
    if (fs.existsSync(input.schedulerStateFile)) {
      fs.copyFileSync(
        input.schedulerStateFile,
        path.join(schedOut, "scheduler-runs.json"),
      );
    }
    if (input.schedulerLive !== undefined) {
      writeJson(path.join(schedOut, "live-state.json"), input.schedulerLive);
    }

    // When the Mac slept, woke, or briefly woke on its own (DarkWake) — the
    // first question for any "the scheduled run didn't happen" report.
    let power = "";
    try {
      power = sleepWakeEvents((input.powerLog ?? readPowerLog)(), now);
    } catch (e) {
      power = `(power log unavailable: ${(e as Error).message})\n`;
    }
    fs.writeFileSync(path.join(root, "sleep-wake.txt"), power);

    input.workspaces.forEach((ws, i) => {
      const dir = path.join(
        root,
        "workspaces",
        `${i + 1}-${ws.name.replace(/[^\w.-]+/g, "_").slice(0, 40)}`,
      );
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, "workspace.json"), {
        name: ws.name,
        path: ws.path,
      });
      writeJson(
        path.join(dir, "jobs.json"),
        ws.jobs.map((j) => ({ ...j, prompt: j.prompt.slice(0, 200) })),
      );
      writeJson(path.join(dir, "job-claims.json"), listClaims(ws.path));
      fs.writeFileSync(
        path.join(dir, "activity.jsonl"),
        recentActivity(path.join(ws.path, ".monad", "activity.jsonl"), now),
      );
    });

    const outDir = input.outDir ?? defaultOutDir();
    const zip = uniquePath(path.join(outDir, `${name}.zip`));
    // ditto ships with macOS and writes the same zip Finder's Compress does.
    // No resource forks/xattrs: they turn into ._ clutter for whoever unzips it.
    execFileSync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--norsrc",
      "--noextattr",
      "--noacl",
      "--noqtn",
      "--keepParent",
      root,
      zip,
    ]);
    return zip;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Activity lines from the last ACTIVITY_DAYS, newest ACTIVITY_MAX_LINES. */
export function recentActivity(file: string, now: Date): string {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(size, ACTIVITY_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  const cutoff = now.getTime() - ACTIVITY_DAYS * 86_400_000;
  const lines = text.split("\n").filter((line) => {
    const ts = /"ts":"([^"]+)"/.exec(line)?.[1];
    return ts ? Date.parse(ts) >= cutoff : false;
  });
  const kept = lines.slice(-ACTIVITY_MAX_LINES);
  return kept.length ? `${redactSecrets(kept.join("\n"))}\n` : "";
}

/** Days of sleep/wake history a bundle carries. */
const POWER_DAYS = 3;

/** `pmset -g log`: the system power log, readable without admin rights. */
function readPowerLog(): string {
  return execFileSync("/usr/bin/pmset", ["-g", "log"], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 20_000,
  });
}

/** Sleep / Wake / DarkWake (and shutdown/restart) lines from the last
 *  POWER_DAYS, from pmset's log format:
 *  "2026-10-02 07:09:30 +0100 DarkWake  \tDarkWake from Deep Idle …". */
export function sleepWakeEvents(log: string, now: Date): string {
  const cutoff = now.getTime() - POWER_DAYS * 86_400_000;
  const kept = log.split("\n").filter((line) => {
    const m =
      /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}) (Sleep|Wake|DarkWake|Start|Shutdown|Restart) *\t/.exec(
        line,
      );
    if (!m) return false;
    const [d, t, z] = m[1].split(" ");
    const ts = Date.parse(`${d}T${t}${z.slice(0, 3)}:${z.slice(3)}`);
    return ts >= cutoff;
  });
  return kept.length
    ? `${kept.map((l) => l.replace(/\s+$/, "")).join("\n")}\n`
    : "(no sleep/wake events in the last 3 days)\n";
}

/** The workspace's once-only run claims: which process took which job-day. */
function listClaims(
  workspacePath: string,
): Array<{ claim: string; pid: string; modified: string }> {
  const dir = path.join(workspacePath, ".monad", "job-claims");
  return safeReaddir(dir).flatMap((claim) => {
    try {
      const p = path.join(dir, claim);
      return [
        {
          claim,
          pid: fs.readFileSync(p, "utf8").trim(),
          modified: fs.statSync(p).mtime.toISOString(),
        },
      ];
    } catch {
      return [];
    }
  });
}

function readme(now: Date): string {
  return `Monad diagnostics — ${now.toString()}

about.json                 app version, macOS, providers in use (no keys)
app-log/                   the app's log (~/Library/Logs/Monad)
sleep-wake.txt             when the Mac slept / woke / briefly woke (last 3 days)
scheduler/                 scheduled runs in flight + the scheduler's live state
workspaces/<n>/jobs.json   scheduled jobs and when they last ran/succeeded
workspaces/<n>/job-claims.json   which process started which job-day
workspaces/<n>/activity.jsonl    last ${ACTIVITY_DAYS} days of agent activity

Not included: API keys, sign-in tokens, .env files, chat transcripts,
knowledge/, outbox/. Activity lines can contain short prompt and email-subject
snippets — skim them before sending if that matters.
`;
}

function defaultOutDir(): string {
  for (const d of ["Desktop", "Downloads"]) {
    const p = path.join(os.homedir(), d);
    if (fs.existsSync(p)) return p;
  }
  return os.homedir();
}

function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  for (let i = 2; ; i++) {
    const next = `${p.slice(0, -ext.length)} ${i}${ext}`;
    if (!fs.existsSync(next)) return next;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
