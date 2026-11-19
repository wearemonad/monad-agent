/** Performance diagnostics shared by bun and the webview: the samples each
 *  side gathers, the batch the webview sends to bun every 2 s, and the
 *  plain-text report behind Settings → Advanced → "Copy performance report".
 *  See internal/PARALLEL-THREADS-PR1-MEASURE.html. */

/** Gaps above this between two heartbeat ticks count as a lag event (bun)
 *  or a long task (webview). The recorded duration is the whole gap, the
 *  50 ms cadence included: a 150 ms event means ~100 ms of real blocking.
 *  Both sides use the same rule, so their numbers compare directly. */
export const LAG_THRESHOLD_MS = 100;
/** Heartbeat cadence on both sides. */
export const HEARTBEAT_MS = 50;
/** How far back the copied report looks. */
export const REPORT_WINDOW_MS = 15 * 60_000;

/** Bun's event loop was blocked for `ms`; `label` says what was running. */
export type LagSample = { ts: number; ms: number; label: string };
/** One bun RPC request handler: duration and response size. */
export type RpcSample = {
  ts: number;
  method: string;
  ms: number;
  bytes: number;
};
/** The webview main thread missed its heartbeat for `ms`. */
export type LongTaskSample = { ts: number; ms: number };
/** A React commit over 16 ms (Profiler actualDuration). */
export type RenderSample = {
  ts: number;
  id: string;
  phase: string;
  ms: number;
};
/** What a click opened. A Thread click is classified when it is pressed:
 *  in another workspace (the switch is part of the cost), else streaming
 *  right now, else idle (its history comes from disk). */
export type ClickTarget =
  | "thread-running"
  | "thread-idle"
  | "workspace-switch"
  | "settings";

const CLICK_LABELS: Record<ClickTarget, string> = {
  "thread-running": "running Thread",
  "thread-idle": "idle Thread",
  "workspace-switch": "other workspace",
  settings: "Settings",
};
/** pointerdown → second rAF after the store showed the target. The parts are
 *  offsets from pointerdown: when the RPC answered (thread opens only), when
 *  React committed, and when the frame painted (= totalMs). */
export type ClickSample = {
  ts: number;
  target: ClickTarget;
  totalMs: number;
  rpcMs?: number;
  commitMs: number;
  paintMs: number;
};
/** Incoming bun → webview messages over one reporting window. */
export type MessageBucket = {
  ts: number;
  windowMs: number;
  byType: Record<string, { count: number; bytes: number }>;
};

/** The window was hidden or covered for `ms`. WebKit throttles timers and
 *  stops requestAnimationFrame then, so the webview pauses its measurements
 *  and reports the hidden time instead. */
export type HiddenSample = { ts: number; ms: number };

/** The webview's batch, sent to bun as one `perfReport` message every 2 s. */
export type PerfReport = {
  longTasks: LongTaskSample[];
  renders: RenderSample[];
  clicks: ClickSample[];
  messages: MessageBucket;
  /** Time the window spent hidden during this batch (0 if none). */
  hiddenMs: number;
};

export type PerfSamples = {
  lags: LagSample[];
  rpcs: RpcSample[];
  longTasks: LongTaskSample[];
  renders: RenderSample[];
  clicks: ClickSample[];
  messages: MessageBucket[];
  hidden: HiddenSample[];
};

/** Nearest-rank percentile; 0 for an empty series. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const ms = (n: number) => String(Math.round(n));
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

type Stats = { n: number; p50: number; p95: number; max: number };
function stats(values: number[]): Stats {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : 0,
  };
}

/** Rows of `label count p50 p95 max [extra]`, worst max first. */
function table(
  groups: Map<string, number[]>,
  extra: (label: string) => string = () => "",
  limit = Infinity,
): string[] {
  const rows = [...groups].map(([label, values]) => ({
    label,
    ...stats(values),
  }));
  rows.sort((a, b) => b.max - a.max);
  const width = Math.max(5, ...rows.map((r) => r.label.length));
  return [
    `  ${"label".padEnd(width)}  count    p50    p95    max`,
    ...rows
      .slice(0, limit)
      .map(
        (r) =>
          `  ${r.label.padEnd(width)}  ${String(r.n).padStart(5)}  ${ms(r.p50).padStart(5)}  ${ms(r.p95).padStart(5)}  ${ms(r.max).padStart(5)}${extra(r.label)}`,
      ),
  ];
}

function groupBy<T>(xs: T[], key: (x: T) => string, value: (x: T) => number) {
  const out = new Map<string, number[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k) ?? [];
    out.set(k, list);
    list.push(value(x));
  }
  return out;
}

/** The text a reporter pastes into an issue: lag by label, click-to-paint,
 *  slow renders, the slowest RPCs and the message rate — over the last
 *  `windowMs`. Durations are in milliseconds. */
export function formatPerfReport(
  all: PerfSamples,
  opts: { now: number; windowMs: number; header?: string },
): string {
  const since = opts.now - opts.windowMs;
  const recent = <T extends { ts: number }>(xs: T[]) =>
    xs.filter((x) => x.ts >= since);
  const lags = recent(all.lags);
  const rpcs = recent(all.rpcs);
  const longTasks = recent(all.longTasks);
  const renders = recent(all.renders);
  const clicks = recent(all.clicks);
  const buckets = recent(all.messages);
  const hiddenMs = recent(all.hidden).reduce((sum, h) => sum + h.ms, 0);

  const out: string[] = [];
  out.push(
    `Monad performance report — last ${Math.round(opts.windowMs / 60_000)} min${opts.header ? ` · ${opts.header}` : ""}`,
    "All durations in ms.",
    ...(hiddenMs > 0
      ? [
          `Window hidden for ${(hiddenMs / 1000).toFixed(1)} s: webview stalls and clicks were not measured then.`,
        ]
      : []),
    "",
    `Bun event-loop lag: ${lags.length} events`,
  );
  if (lags.length)
    out.push(
      ...table(
        groupBy(
          lags,
          (l) => l.label,
          (l) => l.ms,
        ),
      ),
    );

  const lt = stats(longTasks.map((t) => t.ms));
  out.push(
    "",
    `Webview long tasks: ${lt.n}${lt.n ? `  p50 ${ms(lt.p50)}  p95 ${ms(lt.p95)}  max ${ms(lt.max)}` : ""}`,
  );

  out.push("", "Click-to-paint");
  if (!clicks.length) out.push("  (no clicks recorded)");
  for (const target of Object.keys(CLICK_LABELS) as ClickTarget[]) {
    const cs = clicks.filter((c) => c.target === target);
    if (!cs.length) continue;
    const t = stats(cs.map((c) => c.totalMs));
    const rpc = cs.flatMap((c) => (c.rpcMs === undefined ? [] : [c.rpcMs]));
    const parts = [
      ...(rpc.length ? [`rpc p50 ${ms(percentile(rpc, 50))}`] : []),
      `commit p50 ${ms(
        percentile(
          cs.map((c) => c.commitMs),
          50,
        ),
      )}`,
      `paint p50 ${ms(
        percentile(
          cs.map((c) => c.paintMs),
          50,
        ),
      )}`,
    ];
    out.push(
      `  ${CLICK_LABELS[target].padEnd(15)}  n=${t.n}  p50 ${ms(t.p50)}  p95 ${ms(t.p95)}  max ${ms(t.max)}  (${parts.join(" · ")})`,
    );
  }

  out.push("", `Slow renders (>16 ms): ${renders.length}`);
  if (renders.length)
    out.push(
      ...table(
        groupBy(
          renders,
          (r) => r.id,
          (r) => r.ms,
        ),
      ),
    );

  out.push("", `Slowest RPCs: ${rpcs.length} calls`);
  if (rpcs.length) {
    const bytes = groupBy(
      rpcs,
      (r) => r.method,
      (r) => r.bytes,
    );
    out.push(
      ...table(
        groupBy(
          rpcs,
          (r) => r.method,
          (r) => r.ms,
        ),
        (m) => {
          const b = bytes.get(m) ?? [];
          return `  ${kb(b.reduce((x, y) => x + y, 0) / (b.length || 1))}`;
        },
        10,
      ),
    );
  }

  out.push("", "Messages to the webview");
  const windowS = buckets.reduce((sum, b) => sum + b.windowMs, 0) / 1000 || 1;
  const byType = new Map<
    string,
    { count: number; bytes: number; peak: number }
  >();
  for (const b of buckets) {
    for (const [type, { count, bytes }] of Object.entries(b.byType)) {
      const agg = byType.get(type) ?? { count: 0, bytes: 0, peak: 0 };
      agg.count += count;
      agg.bytes += bytes;
      // A short window (the final flush) would overstate the peak rate.
      if (b.windowMs >= 1000) {
        agg.peak = Math.max(agg.peak, count / (b.windowMs / 1000));
      }
      byType.set(type, agg);
    }
  }
  if (!byType.size) out.push("  (none recorded)");
  const typeWidth = Math.max(20, ...[...byType.keys()].map((t) => t.length));
  for (const [type, agg] of [...byType].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    out.push(
      `  ${type.padEnd(typeWidth)}  ${(agg.count / windowS).toFixed(1)}/s  peak ${agg.peak.toFixed(1)}/s  ${kb(agg.bytes / windowS)}/s`,
    );
  }
  return out.join("\n");
}
