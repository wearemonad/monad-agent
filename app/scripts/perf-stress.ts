/** bun run perf:stress [seconds] [threads]
 *
 *  Launches the dev app with the fake-stream harness (MONAD_FAKE_AGENT, 5
 *  streaming Threads by default) and MONAD_PERF_STRESS, which has the webview
 *  click between Threads and Settings every 2 s for 3 minutes. Then prints
 *  the click-to-paint and lag summary. Manual, not run in CI — it needs a
 *  desktop session. See internal/PARALLEL-THREADS-PR1-MEASURE.html §4. */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const seconds = Number(process.argv[2]) || 180;
const threads = Number(process.argv[3]) || 5;
const reportFile = path.join(os.homedir(), "Library/Logs/Monad/perf-stress.txt");
const START = "=== MONAD PERF REPORT ===";
const END = "=== END PERF REPORT ===";
// Build + launch + harness warm-up + the run itself + the report hand-off.
const deadline = Date.now() + (seconds + 180) * 1000;

fs.rmSync(reportFile, { force: true });
console.log(
  `perf:stress — ${threads} fake Threads, clicking for ${seconds}s (building and launching the dev app first)…`,
);

const child = spawn("bun", ["run", "start"], {
  cwd: path.resolve(import.meta.dir, ".."),
  env: {
    ...process.env,
    MONAD_FAKE_AGENT: String(threads),
    MONAD_PERF_STRESS: String(seconds),
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // own process group, so a timeout can stop electrobun too
});

let output = "";
let report: string | null = null;
const onData = (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  for (const line of text.split("\n")) {
    if (/\[perf\]|error/i.test(line) && !line.includes(START)) console.log(line);
  }
  const start = output.indexOf(START);
  const end = output.indexOf(END, start);
  if (start !== -1 && end !== -1) {
    report = output.slice(start + START.length, end).trim();
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

const stop = () => {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
};

const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
while (!report && Date.now() < deadline) {
  const done = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
  ]);
  if (!report && fs.existsSync(reportFile)) {
    report = fs.readFileSync(reportFile, "utf8");
  }
  if (done) break;
}
stop();

if (!report) {
  console.error(
    "perf:stress — no report. Is this a dev build with a workspace open? Last output:\n",
  );
  console.error(output.split("\n").slice(-40).join("\n"));
  process.exit(1);
}
console.log(`\n${report}\n`);
console.log("Full log: ~/Library/Logs/Monad/perf.log");
process.exit(0);
