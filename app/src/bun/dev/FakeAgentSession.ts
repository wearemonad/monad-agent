import type { AgentStreamEvent } from "../../shared/ipc";

/** Where a fake run's output goes. In the app this is AgentService's own
 *  emitter, so everything downstream of the CLI — routeAgentEvent, the
 *  StreamMultiplexer, the streamBatch RPC, the webview store — is the real
 *  path. */
export type FakeSink = {
  delta: (kind: "text" | "thinking", text: string) => void;
  emit: (event: AgentStreamEvent) => void;
};

/** A dev-only stand-in for an agent run (MONAD_FAKE_AGENT, perf:stress):
 *  streams thinking, then a markdown answer with code fences and tables at
 *  `charsPerSecond`, then a tool call and its result when one is due — step
 *  after step until `maxSteps` (then run-finished) or `stop()`.
 *  See internal/PARALLEL-THREADS-PR1-MEASURE.html §4. */
export class FakeAgentSession {
  /** Settles when the run has finished or was stopped. */
  readonly done: Promise<void>;
  private stopped = false;
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastToolAt = 0;

  constructor(
    private readonly opts: {
      runId: string;
      sessionId: string;
      sink: FakeSink;
      /** Streaming speed of thinking and text. Default 400 (a fast model). */
      charsPerSecond?: number;
      /** Delta cadence. Default 50 ms. */
      tickMs?: number;
      /** A tool call (and its result) at most this often. Default 4 s. */
      toolEveryMs?: number;
      /** Finish after this many steps; omit to stream until stopped. */
      maxSteps?: number;
      /** After each step, with that step's answer (to grow the session file). */
      onStep?: (answer: string) => void;
    },
  ) {
    this.done = this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }

  private async loop(): Promise<void> {
    const { runId, sessionId, sink, maxSteps } = this.opts;
    const toolEvery = this.opts.toolEveryMs ?? 4000;
    sink.emit({ kind: "run-started", runId, sessionId, model: "fake-agent" });
    this.lastToolAt = Date.now();
    let step = 0;
    for (; maxSteps === undefined || step < maxSteps; step++) {
      const thinking = THINKING[step % THINKING.length];
      if (!(await this.stream("thinking", thinking))) return;
      sink.emit({ kind: "thinking", runId, text: thinking });

      const answer = answerFor(step);
      if (!(await this.stream("text", answer))) return;
      sink.emit({ kind: "text", runId, text: answer });
      sink.emit({ kind: "usage", runId, contextTokens: 20_000 + step * 900 });

      if (Date.now() - this.lastToolAt >= toolEvery) {
        this.lastToolAt = Date.now();
        const toolUseId = `fake-tool-${runId}-${step}`;
        const tool = TOOLS[step % TOOLS.length];
        sink.emit({ kind: "tool-call", runId, toolUseId, ...tool.call });
        if (!(await this.sleep(Math.min(400, toolEvery / 4)))) return;
        sink.emit({
          kind: "tool-result",
          runId,
          toolUseId,
          output: tool.output,
          isError: false,
        });
      }
      this.opts.onStep?.(answer);
    }
    sink.emit({
      kind: "run-finished",
      runId,
      sessionId,
      numTurns: step,
      contextWindow: 200_000,
    });
  }

  /** Stream `text` as deltas at the configured rate; false if stopped. */
  private async stream(kind: "text" | "thinking", text: string) {
    const tick = this.opts.tickMs ?? 50;
    const perTick = Math.max(
      1,
      Math.round(((this.opts.charsPerSecond ?? 400) * tick) / 1000),
    );
    for (let i = 0; i < text.length; i += perTick) {
      if (!(await this.sleep(tick))) return false;
      this.opts.sink.delta(kind, text.slice(i, i + perTick));
    }
    return !this.stopped;
  }

  private sleep(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.wake = () => resolve(false);
      this.timer = setTimeout(() => {
        this.wake = null;
        resolve(!this.stopped);
      }, ms);
    });
  }
}

const THINKING = [
  "The user wants a comparison. I should pull the numbers from the knowledge base first, then lay them out in a table and flag anything that looks off.",
  "Let me check the latest notes before answering — the pricing doc was updated last week, so earlier figures may be stale.",
  "A code sample will make this concrete. Keep it short, then explain the trade-offs in a list.",
];

const TOOLS = [
  {
    call: { name: "Grep", inputSummary: 'pattern: "quarterly revenue"' },
    output:
      "knowledge/finance/q3-review.md:12: Quarterly revenue grew 14% …\nknowledge/finance/q2-review.md:9: Quarterly revenue was flat …",
  },
  {
    call: { name: "Read", inputSummary: "knowledge/product/roadmap.md" },
    output:
      "# Roadmap\n\n- Q4: parallel threads\n- Q1: shared workspaces\n".repeat(
        8,
      ),
  },
  {
    call: { name: "mcp__memory__search", inputSummary: 'query: "onboarding"' },
    output: JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({
        path: `knowledge/people/onboarding-${i}.md`,
        score: 0.9 - i * 0.05,
      })),
    ),
  },
];

/** A markdown answer — paragraphs, a table, a code fence, a list — varied a
 *  little per step so consecutive blocks differ. */
function answerFor(step: number): string {
  const n = step + 1;
  return [
    `## Step ${n}: what the numbers say`,
    "",
    `Here is the breakdown for pass ${n}. Revenue is up across the board, but **support load** grew faster than headcount, which is the thing to watch next quarter.`,
    "",
    "| Area | Q2 | Q3 | Change |",
    "| ---- | -- | -- | ------ |",
    `| Revenue | 1.20M | ${(1.2 + n / 100).toFixed(2)}M | +${n}% |`,
    "| Tickets | 3 400 | 4 100 | +21% |",
    "| Headcount | 18 | 19 | +6% |",
    "",
    "```ts",
    `export function growth(prev: number, next: number): number {`,
    "  if (prev === 0) return 0;",
    "  return Math.round(((next - prev) / prev) * 1000) / 10;",
    "}",
    "```",
    "",
    "- Hire one more support engineer before the January renewals.",
    "- Move the onboarding FAQ into the help centre to deflect tickets.",
    `- Re-run this comparison after the ${n % 2 ? "board" : "team"} meeting.`,
  ].join("\n");
}
