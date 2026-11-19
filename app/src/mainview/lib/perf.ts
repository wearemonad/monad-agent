import type { ProfilerOnRenderCallback } from "react";
import {
  HEARTBEAT_MS,
  LAG_THRESHOLD_MS,
  type ClickSample,
  type ClickTarget,
  type LongTaskSample,
  type MessageBucket,
  type PerfReport,
  type RenderSample,
} from "../../shared/perf";
import { useStore } from "../store";

/** Webview-side performance diagnostics (PARALLEL-THREADS-PR1-MEASURE.html §2).
 *
 *  - Main-thread lag: WKWebView has no Long Tasks API, so a MessageChannel
 *    heartbeat every 50 ms stands in; a gap over 100 ms is a long task.
 *  - Render cost: <Profiler onRender={perf.onRender}> around Messages,
 *    Sidebar and SettingsPage records commits over 16 ms.
 *  - Click-to-paint: `markClick` on pointerdown, ended at the second
 *    requestAnimationFrame after the store shows the target state, with the
 *    RPC answer and the React commit as intermediate marks.
 *  - Incoming bun messages: count and approximate bytes per type.
 *
 *  Everything is sent to bun as ONE perfReport message every 2 s. Off unless
 *  settings.perfDiagnostics is on; every entry point is a cheap no-op then. */

const REPORT_EVERY_MS = 2_000;
const SLOW_RENDER_MS = 16;
/** A click whose target never shows up (a failed open) is dropped. */
const CLICK_TIMEOUT_MS = 30_000;

type PendingClick = {
  target: ClickTarget;
  sessionId?: string;
  t0: number;
  rpcAt?: number;
  storeAt?: number;
  commitAt?: number;
};

let enabled = false;
let sendReport: (report: PerfReport) => void = () => {};
let heartbeat: { stop: () => void } | null = null;
let reporter: ReturnType<typeof setInterval> | null = null;

let longTasks: LongTaskSample[] = [];
let renders: RenderSample[] = [];
let clicks: ClickSample[] = [];
let messages: MessageBucket["byType"] = {};
let windowStart = performance.now();
let pending: PendingClick | null = null;
/** Hidden-window bookkeeping: WebKit throttles timers and stops rAF while
 *  the window is hidden, so heartbeat gaps then are not work and a click
 *  can never paint. Measurements pause; the hidden time is reported. */
let hiddenMs = 0;
let hiddenSince: number | null = null;
/** Bumped on every visibility change: a heartbeat gap that spans one is
 *  not recorded. */
let visibilityEpoch = 0;

function onVisibilityChange(): void {
  const now = performance.now();
  visibilityEpoch++;
  if (document.hidden) {
    hiddenSince ??= now;
    pending = null; // it cannot paint while hidden
  } else if (hiddenSince !== null) {
    hiddenMs += now - hiddenSince;
    hiddenSince = null;
  }
}

function startHeartbeat(): { stop: () => void } {
  const channel = new MessageChannel();
  let last = performance.now();
  let epoch = visibilityEpoch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  channel.port1.onmessage = () => {
    const now = performance.now();
    const gap = now - last;
    const sawChange = epoch !== visibilityEpoch;
    last = now;
    epoch = visibilityEpoch;
    if (gap > LAG_THRESHOLD_MS && !document.hidden && !sawChange) {
      longTasks.push({ ts: Date.now(), ms: gap });
    }
    if (!stopped)
      timer = setTimeout(() => channel.port2.postMessage(0), HEARTBEAT_MS);
  };
  timer = setTimeout(() => channel.port2.postMessage(0), HEARTBEAT_MS);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      channel.port1.close();
    },
  };
}

/** Classify a Thread click at press time (see ClickTarget). */
function threadKind(sessionId?: string, workspaceId?: string): ClickTarget {
  const s = useStore.getState();
  const active = s.workspaces.find((w) => w.active)?.id;
  if (workspaceId && workspaceId !== active) return "workspace-switch";
  return sessionId && s.runningSessions[sessionId]
    ? "thread-running"
    : "thread-idle";
}

/** The store shows what the pending click asked for. */
function reached(click: PendingClick, s: ReturnType<typeof useStore.getState>) {
  return click.target === "settings"
    ? s.settingsOpen
    : !s.settingsOpen && s.resumeSessionId === click.sessionId;
}

function checkTarget(): void {
  const click = pending;
  if (!click || click.storeAt !== undefined) return;
  const now = performance.now();
  if (now - click.t0 > CLICK_TIMEOUT_MS) {
    pending = null;
    return;
  }
  if (!reached(click, useStore.getState())) return;
  click.storeAt = now;
  // Two frames: the first rAF runs before the frame that shows the change
  // is painted; the second runs once it has been.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (pending !== click) return;
      pending = null;
      const total = performance.now() - click.t0;
      clicks.push({
        ts: Date.now(),
        target: click.target,
        totalMs: total,
        ...(click.rpcAt !== undefined ? { rpcMs: click.rpcAt - click.t0 } : {}),
        commitMs: (click.commitAt ?? click.storeAt!) - click.t0,
        paintMs: total,
      });
    }),
  );
}

/** Rough payload size without serialising: string lengths plus a little per
 *  number/key. Cheap enough to run on every incoming message. */
function approxBytes(v: unknown, depth = 0): number {
  if (typeof v === "string") return v.length;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  if (!v || typeof v !== "object" || depth > 6) return 0;
  let n = 2;
  if (Array.isArray(v)) {
    for (const x of v) n += approxBytes(x, depth + 1) + 1;
  } else {
    for (const k in v) {
      n +=
        k.length +
        3 +
        approxBytes((v as Record<string, unknown>)[k], depth + 1);
    }
  }
  return n;
}

function flush(): void {
  const now = performance.now();
  const bucket: MessageBucket = {
    ts: Date.now(),
    windowMs: Math.round(now - windowStart),
    byType: messages,
  };
  windowStart = now;
  if (hiddenSince !== null) {
    hiddenMs += now - hiddenSince;
    hiddenSince = now;
  }
  const report: PerfReport = {
    longTasks,
    renders,
    clicks,
    messages: bucket,
    hiddenMs,
  };
  hiddenMs = 0;
  longTasks = [];
  renders = [];
  clicks = [];
  messages = {};
  sendReport(report);
}

export const perf = {
  /** Wire up once at startup: `send` delivers a batch to bun. The on/off
   *  state follows settings.perfDiagnostics from then on. */
  init(send: (report: PerfReport) => void): void {
    sendReport = send;
    if (document.hidden) hiddenSince = performance.now();
    document.addEventListener("visibilitychange", onVisibilityChange);
    useStore.subscribe((s) => {
      perf.setEnabled(!!s.settings?.perfDiagnostics);
      checkTarget();
    });
  },

  setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      windowStart = performance.now();
      heartbeat = startHeartbeat();
      reporter = setInterval(flush, REPORT_EVERY_MS);
    } else {
      heartbeat?.stop();
      if (reporter) clearInterval(reporter);
      heartbeat = reporter = null;
      pending = null;
      longTasks = [];
      renders = [];
      clicks = [];
      messages = {};
      hiddenMs = 0;
    }
  },

  /** pointerdown on a sidebar Thread row or a Settings entry point. A
   *  Thread click names its workspace only when it may be another one. */
  markClick(
    target: "thread" | "settings",
    sessionId?: string,
    workspaceId?: string,
  ): void {
    if (!enabled) return;
    pending = {
      target:
        target === "settings" ? "settings" : threadKind(sessionId, workspaceId),
      sessionId,
      t0: performance.now(),
    };
    checkTarget(); // already there (clicking the open Thread)
  },

  /** getSessionHistory answered: for a pending Thread click, this is the
   *  "time to RPC response" mark. */
  noteHistoryLoaded(): void {
    if (
      pending &&
      pending.storeAt === undefined &&
      pending.target !== "settings"
    ) {
      pending.rpcAt = performance.now();
    }
  },

  /** <Profiler onRender>: slow commits, and the commit of a pending click. */
  onRender: ((id, phase, actualDuration) => {
    if (!enabled) return;
    if (actualDuration > SLOW_RENDER_MS) {
      renders.push({ ts: Date.now(), id, phase, ms: actualDuration });
    }
    if (pending?.storeAt !== undefined && pending.commitAt === undefined) {
      pending.commitAt = performance.now();
    }
  }) as ProfilerOnRenderCallback,

  /** Count one incoming bun → webview message. */
  countMessage(type: string, payload: unknown): void {
    if (!enabled) return;
    const entry = messages[type] ?? { count: 0, bytes: 0 };
    messages[type] = entry;
    entry.count++;
    entry.bytes += approxBytes(payload);
  },

  /** Send what has been gathered now (perf:stress, before it finishes). */
  flushNow(): void {
    if (enabled) flush();
  },
};
