import * as fs from "node:fs";
import * as path from "node:path";
import {
  HEARTBEAT_MS,
  LAG_THRESHOLD_MS,
  REPORT_WINDOW_MS,
  formatPerfReport,
  type PerfReport,
  type PerfSamples,
} from "../../shared/perf";

/** RPC handlers slower than this get their own perf.log line. */
const SLOW_RPC_MS = 50;
/** perf.log is rotated to perf.log.1 at startup past this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Hard cap per sample series, on top of the 15-minute window. */
const MAX_SAMPLES = 20_000;

type Fn = (...args: any[]) => any;

/** Bun-side performance diagnostics (PARALLEL-THREADS-PR1-MEASURE.html).
 *
 *  - Event-loop lag: a heartbeat every 50 ms; a gap over 100 ms between two
 *    ticks is a lag event, named after the work that was running.
 *  - Task labels: `run(label, fn)` names a piece of work. A lag event is
 *    pinned on the labelled synchronous call that held the thread if there
 *    was one, else on labelled async work that finished since the last tick
 *    and ran long enough to be the culprit (its last continuation is the
 *    usual blocker), else on whatever is still in flight. Short work that
 *    merely happened nearby is never blamed.
 *  - RPC timing: `instrument(handlers)` times every request handler and
 *    sizes its response.
 *  - The webview's 2-second batches arrive through `ingest`.
 *
 *  Everything goes to perf.log through a buffered async append, flushed once
 *  a second — a synchronous append would add the very lag being measured —
 *  and the last 15 minutes stay in memory for `report()`. */
export class PerfMonitor {
  private enabled: boolean;
  private started = false;
  private readonly logFile: string;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private flusher: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private pending: string[] = [];
  private writing: Promise<void> = Promise.resolve();

  /** Labelled synchronous calls since the last tick: [label, ms]. */
  private segments: [string, number][] = [];
  /** Labelled async work still running, with a count per label. */
  private inFlight = new Map<string, number>();
  /** Labelled async work that finished since the last tick: label → how
   *  long it ran (ms). */
  private endedSinceTick = new Map<string, number>();

  private samples: PerfSamples = {
    lags: [],
    rpcs: [],
    longTasks: [],
    renders: [],
    clicks: [],
    messages: [],
  };

  constructor(opts: {
    logFile: string;
    enabled: boolean;
    intervalMs?: number;
    thresholdMs?: number;
  }) {
    this.logFile = opts.logFile;
    this.enabled = opts.enabled;
    this.intervalMs = opts.intervalMs ?? HEARTBEAT_MS;
    this.thresholdMs = opts.thresholdMs ?? LAG_THRESHOLD_MS;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  start(): void {
    this.started = true;
    if (this.enabled) this.startTimers();
  }

  /** Stop the timers and write out what is buffered. */
  async stop(): Promise<void> {
    this.started = false;
    this.stopTimers();
    await this.flush();
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on && this.started) this.startTimers();
    if (!on) this.stopTimers();
  }

  /** Run `fn` under a task label, so lag it causes is attributed to it.
   *  Returns whatever `fn` returns, promise or not. */
  run<T>(label: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    let result: T;
    try {
      result = fn();
    } catch (e) {
      this.segment(label, t0);
      throw e;
    }
    this.segment(label, t0);
    if (result instanceof Promise) {
      this.inFlight.set(label, (this.inFlight.get(label) ?? 0) + 1);
      const done = () => {
        const n = (this.inFlight.get(label) ?? 1) - 1;
        if (n > 0) this.inFlight.set(label, n);
        else this.inFlight.delete(label);
        const ran = performance.now() - t0;
        this.endedSinceTick.set(
          label,
          Math.max(ran, this.endedSinceTick.get(label) ?? 0),
        );
      };
      result.then(done, done);
    }
    return result;
  }

  /** Wrap every RPC request handler: labelled `rpc:<method>`, timed, its
   *  response sized, and a perf.log line when it takes over 50 ms. */
  instrument<T extends Record<string, Fn>>(handlers: T): T {
    const out: Record<string, Fn> = {};
    for (const [method, handler] of Object.entries(handlers)) {
      out[method] = (...args: unknown[]) => {
        if (!this.enabled) return handler(...args);
        const t0 = performance.now();
        const result = this.run(`rpc:${method}`, () => handler(...args));
        if (result instanceof Promise) {
          return result.then((value) => {
            this.recordRpc(method, t0, value);
            return value;
          });
        }
        this.recordRpc(method, t0, result);
        return result;
      };
    }
    return out as T;
  }

  /** A batch from the webview (every 2 s). */
  ingest(report: PerfReport): void {
    if (!this.enabled) return;
    const s = this.samples;
    s.longTasks.push(...report.longTasks);
    s.renders.push(...report.renders);
    s.clicks.push(...report.clicks);
    s.messages.push(report.messages);
    for (const t of report.longTasks)
      this.log(`webview long-task ${round(t.ms)}ms`);
    for (const r of report.renders)
      this.log(`webview render ${r.id} ${r.phase} ${round(r.ms)}ms`);
    for (const c of report.clicks) {
      this.log(
        `webview click ${c.target} ${round(c.totalMs)}ms (rpc ${c.rpcMs === undefined ? "-" : round(c.rpcMs)} commit ${round(c.commitMs)} paint ${round(c.paintMs)})`,
      );
    }
    const types = Object.entries(report.messages.byType);
    if (types.length) {
      this.log(
        `webview messages ${report.messages.windowMs}ms ${types
          .map(([t, { count, bytes }]) => `${t}=${count}/${bytes}B`)
          .join(" ")}`,
      );
    }
  }

  /** The summary behind "Copy performance report". */
  report(header?: string): string {
    return formatPerfReport(this.samples, {
      now: Date.now(),
      windowMs: REPORT_WINDOW_MS,
      header,
    });
  }

  /** Write out buffered lines now (also runs once a second). */
  async flush(): Promise<void> {
    this.prune();
    if (this.pending.length) {
      const chunk = this.pending.join("");
      this.pending = [];
      this.writing = this.writing.then(() =>
        fs.promises.appendFile(this.logFile, chunk).catch(() => {
          // a full disk must not take the app down with it
        }),
      );
    }
    await this.writing;
  }

  // ———————————————————————————————————————————————————————————

  private startTimers(): void {
    if (this.heartbeat) return;
    rotateOnce(this.logFile);
    this.lastTick = performance.now();
    this.heartbeat = setInterval(() => this.tick(), this.intervalMs);
    this.flusher = setInterval(() => void this.flush(), 1000);
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.flusher) clearInterval(this.flusher);
    this.heartbeat = this.flusher = null;
  }

  private tick(): void {
    const now = performance.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > this.thresholdMs) {
      const label = this.blame();
      this.push(this.samples.lags, { ts: Date.now(), ms: gap, label });
      this.log(`lag ${round(gap)}ms ${label}`);
    }
    this.segments = [];
    this.endedSinceTick.clear();
  }

  /** Who held the thread since the last tick (see the class comment). */
  private blame(): string {
    let longest: [string, number] | undefined;
    for (const seg of this.segments) {
      if (!longest || seg[1] > longest[1]) longest = seg;
    }
    const culprit = this.thresholdMs / 2;
    if (longest && longest[1] >= culprit) return longest[0];
    const ended = [...this.endedSinceTick]
      .filter(([, ran]) => ran >= culprit)
      .sort((a, b) => b[1] - a[1]);
    if (ended.length) return ended[0][0];
    if (this.inFlight.size) return [...this.inFlight.keys()].join("+");
    return "unlabelled";
  }

  private segment(label: string, t0: number): void {
    const ms = performance.now() - t0;
    if (ms >= 1) this.segments.push([label, ms]);
  }

  private recordRpc(method: string, t0: number, value: unknown): void {
    const ms = performance.now() - t0;
    const bytes = sizeOf(value);
    this.push(this.samples.rpcs, { ts: Date.now(), method, ms, bytes });
    if (ms > SLOW_RPC_MS) this.log(`rpc ${method} ${round(ms)}ms ${bytes}B`);
  }

  private push<T>(list: T[], item: T): void {
    list.push(item);
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  }

  private log(line: string): void {
    this.pending.push(`${new Date().toISOString()} ${line}\n`);
  }

  private prune(): void {
    const since = Date.now() - REPORT_WINDOW_MS;
    for (const list of Object.values(this.samples) as { ts: number }[][]) {
      const keep = list.findIndex((x) => x.ts >= since);
      if (keep === -1) list.length = 0;
      else if (keep > 0) list.splice(0, keep);
    }
  }
}

const round = (n: number) => Math.round(n);

function sizeOf(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

function rotateOnce(file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file).size > MAX_LOG_BYTES)
      fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}
