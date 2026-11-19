/** Holds background work back while the user is actively using the app, so
 *  it doesn't compete with streaming Threads for bun's main thread
 *  (internal/PARALLEL-THREADS-PR2-UNBLOCK-BUN.html, 2d).
 *
 *  Busy: any interactive Turn is streaming, OR the app launched less than a
 *  minute ago, OR a Thread was opened less than 2 s ago.
 *  Idle: not busy for 5 s straight. */

export type GateClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** How long after launch the app counts as busy. */
export const LAUNCH_BUSY_MS = 60_000;
/** How long after a Thread opens the app counts as busy. */
export const THREAD_OPEN_BUSY_MS = 2_000;
/** Quiet time needed before the app counts as idle. */
export const IDLE_AFTER_MS = 5_000;
/** Longest a gated job waits for idle before it runs anyway. */
export const DEFAULT_MAX_WAIT_MS = 10 * 60_000;

export class ForegroundGate {
  private readonly clock: GateClock;
  /** The moment the latest busy reason ended (or will end). */
  private busyUntil: number;

  constructor(opts: { clock?: GateClock; launchedAt?: number } = {}) {
    this.clock = opts.clock ?? realClock;
    this.busyUntil = (opts.launchedAt ?? this.clock.now()) + LAUNCH_BUSY_MS;
  }

  /** Interactive Turns streaming right now, by run id. */
  private streaming = new Set<string>();

  /** Jobs parked in whenIdle, each with its starvation deadline. */
  private waiters: { release: () => void; deadline: number }[] = [];
  private timer: unknown = null;

  turnStarted(runId: string): void {
    this.streaming.add(runId);
    this.reschedule();
  }

  turnEnded(runId: string): void {
    if (!this.streaming.delete(runId)) return;
    if (this.streaming.size === 0) this.extendBusy(this.clock.now());
    this.reschedule();
  }

  threadOpened(): void {
    this.extendBusy(this.clock.now() + THREAD_OPEN_BUSY_MS);
    this.reschedule();
  }

  /** Resolves once the app is idle, or after maxWaitMs regardless (default
   *  10 minutes) so no job starves behind a long session. */
  whenIdle({
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
  }: {
    maxWaitMs?: number;
  } = {}): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((release) => {
      this.waiters.push({ release, deadline: this.clock.now() + maxWaitMs });
      this.reschedule();
    });
  }

  isBusy(): boolean {
    return this.streaming.size > 0 || this.clock.now() < this.busyUntil;
  }

  isIdle(): boolean {
    return (
      this.streaming.size === 0 &&
      this.clock.now() >= this.busyUntil + IDLE_AFTER_MS
    );
  }

  private extendBusy(until: number): void {
    this.busyUntil = Math.max(this.busyUntil, until);
  }

  /** Release whoever may go now, then arm one timer for the next moment that
   *  could release someone: the idle point (unless a Turn streams — its end
   *  re-runs this) or the earliest deadline. */
  private reschedule(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.clock.now();
    const idle = this.isIdle();
    const waiting: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (idle || now >= w.deadline) w.release();
      else waiting.push(w);
    }
    this.waiters = waiting;
    if (waiting.length === 0) return;
    let next = Math.min(...waiting.map((w) => w.deadline));
    if (this.streaming.size === 0)
      next = Math.min(next, this.busyUntil + IDLE_AFTER_MS);
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        this.reschedule();
      },
      Math.max(0, next - now),
    );
  }
}
