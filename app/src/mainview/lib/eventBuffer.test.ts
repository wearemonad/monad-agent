import { describe, expect, test } from "bun:test";
import { createEventBuffer, type FrameScheduler } from "./eventBuffer";

/** A hand-cranked scheduler: frames and timers run only when the test says. */
function fakeScheduler() {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const sched: FrameScheduler = {
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    setTimer: (cb) => {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
  };
  const runAll = (m: Map<number, () => void>) => {
    const cbs = [...m.values()];
    m.clear();
    for (const cb of cbs) cb();
  };
  return {
    sched,
    frame: () => runAll(frames),
    timeout: () => runAll(timers),
    pending: () => frames.size + timers.size,
  };
}

describe("event buffer", () => {
  test("events pushed within a frame are applied once, as one batch, in order", () => {
    const f = fakeScheduler();
    const batches: number[][] = [];
    const buf = createEventBuffer<number>((b) => batches.push(b), f.sched);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(batches).toEqual([]);
    f.frame();
    expect(batches).toEqual([[1, 2, 3]]);
  });

  test("a hidden window (no frames) still flushes on the timeout fallback", () => {
    const f = fakeScheduler();
    const batches: number[][] = [];
    const buf = createEventBuffer<number>((b) => batches.push(b), f.sched);
    buf.push(1);
    f.timeout();
    expect(batches).toEqual([[1]]);
    // the frame that never ran was cancelled — nothing left scheduled
    expect(f.pending()).toBe(0);
  });

  test("flush() applies synchronously and cancels the scheduled flush", () => {
    const f = fakeScheduler();
    const batches: number[][] = [];
    const buf = createEventBuffer<number>((b) => batches.push(b), f.sched);
    buf.push(1);
    buf.flush();
    expect(batches).toEqual([[1]]);
    expect(f.pending()).toBe(0);
    buf.flush(); // empty: no-op
    expect(batches).toEqual([[1]]);
  });

  test("events after a flush start a new batch", () => {
    const f = fakeScheduler();
    const batches: number[][] = [];
    const buf = createEventBuffer<number>((b) => batches.push(b), f.sched);
    buf.push(1);
    f.frame();
    buf.push(2);
    f.frame();
    expect(batches).toEqual([[1], [2]]);
  });
});
