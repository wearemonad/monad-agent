import type { AgentStreamEvent, StreamBatch } from "../../shared/ipc";

/** How the multiplexer schedules its tick — setTimeout in the app, a
 *  hand-cranked fake in tests. */
export type TickTimer = {
  set: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimer: TickTimer = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Events that change what the user can do next — they never wait for the
 *  tick (the sidebar spinner, the composer unlocking). */
const IMMEDIATE = new Set<AgentStreamEvent["kind"]>([
  "run-started",
  "run-finished",
  "run-error",
]);

export const STREAM_TICK_MS = 50;

/** Every interactive run's stream events, sent to the webview as ONE
 *  `streamBatch` message per tick, however many Threads are streaming.
 *  Within a run, order is kept and consecutive deltas of the same kind are
 *  merged — so a delta still lands before the complete block that follows
 *  it. An idle tick sends nothing; lifecycle events flush at once. */
export class StreamMultiplexer {
  /** runId → its events this tick (Map order = first-seen order). */
  private queued = new Map<string, AgentStreamEvent[]>();
  private timer: unknown = null;
  private seq = 0;

  constructor(
    private send: (batch: StreamBatch) => void,
    private tick: TickTimer = realTimer,
    private tickMs = STREAM_TICK_MS,
  ) {}

  push(event: AgentStreamEvent): void {
    let events = this.queued.get(event.runId);
    if (!events) {
      events = [];
      this.queued.set(event.runId, events);
    }
    const last = events[events.length - 1];
    if (
      last &&
      last.kind === event.kind &&
      (last.kind === "text-delta" || last.kind === "thinking-delta")
    ) {
      // Replace rather than mutate: the caller may still hold `last`.
      events[events.length - 1] = {
        ...last,
        text: last.text + (event as typeof last).text,
      };
    } else {
      events.push(event);
    }
    if (IMMEDIATE.has(event.kind)) this.flush();
    else this.timer ??= this.tick.set(() => this.flush(), this.tickMs);
  }

  /** Send everything queued now (also before any message whose meaning
   *  depends on the stream before it, like a permission request). */
  flush(): void {
    if (this.timer !== null) this.tick.clear(this.timer);
    this.timer = null;
    if (!this.queued.size) return;
    const runs = [...this.queued].map(([runId, events]) => ({
      runId,
      events,
    }));
    this.queued = new Map();
    this.send({ seq: ++this.seq, runs });
  }
}
