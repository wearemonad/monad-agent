import { describe, expect, test } from "bun:test";
import {
  type ClickTarget,
  formatPerfReport,
  percentile,
  type PerfSamples,
} from "./perf";

const empty = (): PerfSamples => ({
  lags: [],
  rpcs: [],
  longTasks: [],
  renders: [],
  clicks: [],
  messages: [],
  hidden: [],
});

describe("percentile", () => {
  test("nearest-rank over unsorted input", () => {
    const xs = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 100)).toBe(10);
  });

  test("an empty series has no percentile", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe("formatPerfReport", () => {
  const now = 1_000_000;

  test("groups bun lag events by label with p50/p95/max", () => {
    const s = empty();
    for (const ms of [120, 140, 900])
      s.lags.push({ ts: now - 1000, ms, label: "loop:memory" });
    s.lags.push({ ts: now - 1000, ms: 200, label: "rpc:getSessionHistory" });
    const text = formatPerfReport(s, { now, windowMs: 15 * 60_000 });
    expect(text).toContain("Bun event-loop lag: 4 events");
    expect(text).toMatch(/loop:memory\s+3\s+140\s+900\s+900/);
    expect(text).toMatch(/rpc:getSessionHistory\s+1\s+200\s+200\s+200/);
    // worst label first
    expect(text.indexOf("loop:memory")).toBeLessThan(
      text.indexOf("rpc:getSessionHistory"),
    );
  });

  test("click-to-paint per kind of click, with its parts", () => {
    const s = empty();
    const click = (target: ClickTarget, total: number, rpc?: number) =>
      s.clicks.push({
        ts: now,
        target,
        totalMs: total,
        ...(rpc === undefined ? {} : { rpcMs: rpc }),
        commitMs: total - 20,
        paintMs: total,
      });
    click("thread-running", 100, 40);
    click("thread-running", 300, 200);
    click("thread-idle", 900, 700);
    click("workspace-switch", 2500, 2000);
    click("settings", 50);
    const text = formatPerfReport(s, { now, windowMs: 15 * 60_000 });
    expect(text).toMatch(
      /running Thread\s+n=2\s+p50 100\s+p95 300\s+max 300\s+\(rpc p50 40 · commit p50 80 · paint p50 100\)/,
    );
    expect(text).toMatch(/idle Thread\s+n=1\s+p50 900/);
    expect(text).toMatch(/other workspace\s+n=1\s+p50 2500/);
    expect(text).toMatch(/Settings\s+n=1\s+p50 50\s+p95 50\s+max 50/);
  });

  test("slow RPCs ranked by worst duration, with response size", () => {
    const s = empty();
    s.rpcs.push({ ts: now, method: "listSessions", ms: 30, bytes: 2048 });
    s.rpcs.push({
      ts: now,
      method: "getSessionHistory",
      ms: 800,
      bytes: 10240,
    });
    const text = formatPerfReport(s, { now, windowMs: 15 * 60_000 });
    expect(text.indexOf("getSessionHistory")).toBeLessThan(
      text.indexOf("listSessions"),
    );
    expect(text).toMatch(/getSessionHistory\s+1\s+800\s+800\s+800\s+10\.0 KB/);
  });

  test("messages per second: average over the window and the peak bucket", () => {
    const s = empty();
    s.messages.push({
      ts: now - 4000,
      windowMs: 2000,
      byType: { streamEvent: { count: 10, bytes: 1000 } },
    });
    s.messages.push({
      ts: now - 2000,
      windowMs: 2000,
      byType: { streamEvent: { count: 50, bytes: 5000 } },
    });
    const text = formatPerfReport(s, { now, windowMs: 4000 });
    // 60 messages over 4 s = 15/s; peak bucket 50 per 2 s = 25/s
    expect(text).toMatch(/streamEvent\s+15\.0\/s\s+peak 25\.0\/s\s+1\.5 KB\/s/);
  });

  test("says how long the window was hidden, when it was", () => {
    const s = empty();
    expect(formatPerfReport(s, { now, windowMs: 60_000 })).not.toContain(
      "hidden",
    );
    s.hidden.push({ ts: now - 5000, ms: 40_000 });
    s.hidden.push({ ts: now - 1000, ms: 2_500 });
    expect(formatPerfReport(s, { now, windowMs: 60_000 })).toContain(
      "Window hidden for 42.5 s",
    );
  });

  test("samples older than the window are left out", () => {
    const s = empty();
    s.lags.push({ ts: now - 20 * 60_000, ms: 5000, label: "old" });
    const text = formatPerfReport(s, { now, windowMs: 15 * 60_000 });
    expect(text).toContain("Bun event-loop lag: 0 events");
    expect(text).not.toContain("old");
  });
});
