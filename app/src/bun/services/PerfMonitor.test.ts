import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PerfMonitor } from "./PerfMonitor";

/** Hold the thread like a synchronous fs walk or an ONNX call would. */
function block(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let logFile: string;
let perf: PerfMonitor;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-perf-"));
  logFile = path.join(dir, "perf.log");
  perf = new PerfMonitor({ logFile, enabled: true, intervalMs: 10 });
  perf.start();
});

afterEach(async () => {
  await perf.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");

describe("PerfMonitor", () => {
  test("a block inside perf.run is a lag event named after the task", async () => {
    await sleep(30);
    perf.run("loop:memory", () => block(180));
    await sleep(40);
    await perf.flush();
    expect(log()).toMatch(/lag \d+ms loop:memory/);
    expect(perf.report()).toMatch(/loop:memory\s+1\s+/);
  });

  test("a block in an async task's continuation names the task in flight", async () => {
    await sleep(30);
    const done = perf.run("syncMemory", async () => {
      await sleep(5);
      block(180);
    });
    await done;
    await sleep(40);
    await perf.flush();
    expect(log()).toMatch(/lag \d+ms syncMemory/);
  });

  test("short work produces no lag event", async () => {
    await sleep(30);
    perf.run("loop:health", () => block(5));
    await sleep(40);
    await perf.flush();
    expect(log()).not.toContain("lag");
  });

  test("instrumented RPC handlers are timed, sized and labelled", async () => {
    const handlers = perf.instrument({
      listSessions: (_: Record<string, never>) => ({ sessions: ["a", "b"] }),
      getSessionHistory: async (_: { sessionId: string }) => {
        block(160);
        return { items: "x".repeat(1000) };
      },
    });
    await sleep(30);
    expect(handlers.listSessions({})).toEqual({ sessions: ["a", "b"] });
    const res = await handlers.getSessionHistory({ sessionId: "s" });
    expect(res.items).toHaveLength(1000);
    await sleep(40);
    await perf.flush();
    // over 50 ms gets its own line, with the response size
    expect(log()).toMatch(/rpc getSessionHistory \d+ms 1\d{3}B/);
    expect(log()).not.toMatch(/rpc listSessions/);
    // the lag it caused is pinned on the handler
    expect(log()).toMatch(/lag \d+ms rpc:getSessionHistory/);
    const report = perf.report();
    expect(report).toContain("Slowest RPCs: 2 calls");
    expect(report.indexOf("getSessionHistory")).toBeLessThan(
      report.indexOf("listSessions"),
    );
  });

  test("webview batches land in perf.log and the report", async () => {
    perf.ingest({
      longTasks: [{ ts: Date.now(), ms: 240 }],
      renders: [{ ts: Date.now(), id: "Messages", phase: "update", ms: 35 }],
      clicks: [
        {
          ts: Date.now(),
          target: "settings",
          totalMs: 420,
          commitMs: 400,
          paintMs: 420,
        },
      ],
      messages: {
        ts: Date.now(),
        windowMs: 2000,
        byType: { streamEvent: { count: 40, bytes: 4096 } },
      },
    });
    await perf.flush();
    expect(log()).toMatch(/webview long-task 240ms/);
    expect(log()).toMatch(/webview click settings 420ms/);
    const report = perf.report();
    expect(report).toMatch(/settings\s+n=1\s+p50 420/);
    expect(report).toMatch(/Messages\s+1\s+35/);
    expect(report).toMatch(/streamEvent\s+20\.0\/s/);
  });

  test("switched off: nothing is measured or written, handlers still answer", async () => {
    await perf.stop();
    perf = new PerfMonitor({ logFile, enabled: false, intervalMs: 10 });
    perf.start();
    const handlers = perf.instrument({ ping: (_: Record<string, never>) => "pong" });
    await sleep(30);
    perf.run("loop:memory", () => block(150));
    expect(handlers.ping({})).toBe("pong");
    await sleep(40);
    await perf.flush();
    expect(log()).toBe("");
  });

  test("can be switched on at runtime", async () => {
    await perf.stop();
    perf = new PerfMonitor({ logFile, enabled: false, intervalMs: 10 });
    perf.start();
    perf.setEnabled(true);
    await sleep(30);
    perf.run("loop:memory", () => block(150));
    await sleep(40);
    await perf.flush();
    expect(log()).toMatch(/lag \d+ms loop:memory/);
  });
});
