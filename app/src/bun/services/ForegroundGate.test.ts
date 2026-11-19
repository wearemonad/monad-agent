import { describe, expect, test } from "bun:test";
import { type GateClock, ForegroundGate } from "./ForegroundGate";

/** A manual clock: time moves only when the test advances it, firing any
 *  timers that fall due on the way. */
function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: GateClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  /** Advance by `ms`, firing due timers in time order. */
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  }
  return { clock, advance };
}

const SEC = 1000;

describe("ForegroundGate", () => {
  test("busy for the first minute after launch, idle 5 s after that", async () => {
    const { clock, advance } = fakeClock();
    const gate = new ForegroundGate({ clock });
    expect(gate.isBusy()).toBe(true);
    await advance(59 * SEC);
    expect(gate.isBusy()).toBe(true);
    // Not busy any more at 60 s — but "idle" needs 5 s of quiet.
    await advance(2 * SEC);
    expect(gate.isBusy()).toBe(false);
    expect(gate.isIdle()).toBe(false);
    await advance(3 * SEC); // 64 s
    expect(gate.isIdle()).toBe(false);
    await advance(1 * SEC); // 65 s
    expect(gate.isIdle()).toBe(true);
  });

  test("a streaming Turn keeps it busy; idle 5 s after the last one ends", async () => {
    const { clock, advance } = fakeClock();
    const gate = new ForegroundGate({ clock, launchedAt: -10 * 60 * SEC });
    expect(gate.isIdle()).toBe(true);
    gate.turnStarted("run-a");
    gate.turnStarted("run-b");
    await advance(10 * 60 * SEC);
    expect(gate.isBusy()).toBe(true);
    gate.turnEnded("run-a");
    expect(gate.isBusy()).toBe(true); // run-b still streams
    gate.turnEnded("run-b");
    expect(gate.isBusy()).toBe(false);
    await advance(4 * SEC);
    expect(gate.isIdle()).toBe(false);
    await advance(1 * SEC);
    expect(gate.isIdle()).toBe(true);
  });

  test("opening a Thread counts as busy for 2 s", async () => {
    const { clock, advance } = fakeClock();
    const gate = new ForegroundGate({ clock, launchedAt: -10 * 60 * SEC });
    gate.threadOpened();
    expect(gate.isBusy()).toBe(true);
    await advance(2 * SEC);
    expect(gate.isBusy()).toBe(false);
    await advance(5 * SEC);
    expect(gate.isIdle()).toBe(true);
  });

  test("whenIdle waits for idle, re-arming when the app gets busy again", async () => {
    const { clock, advance } = fakeClock();
    const gate = new ForegroundGate({ clock });
    let released = false;
    void gate.whenIdle().then(() => {
      released = true;
    });
    await advance(62 * SEC);
    gate.turnStarted("run-a"); // busy again before the 5 s of quiet
    await advance(30 * SEC);
    expect(released).toBe(false);
    gate.turnEnded("run-a");
    await advance(4 * SEC);
    expect(released).toBe(false);
    await advance(1 * SEC);
    expect(released).toBe(true);
  });

  test("whenIdle releases after maxWaitMs even while busy", async () => {
    const { clock, advance } = fakeClock();
    const gate = new ForegroundGate({ clock });
    gate.turnStarted("run-a"); // never ends
    let released = false;
    void gate.whenIdle({ maxWaitMs: 10 * 60 * SEC }).then(() => {
      released = true;
    });
    await advance(10 * 60 * SEC - 1);
    expect(released).toBe(false);
    await advance(1);
    expect(released).toBe(true);
  });

  test("whenIdle resolves at once when already idle", async () => {
    const { clock } = fakeClock();
    const gate = new ForegroundGate({ clock, launchedAt: -10 * 60 * SEC });
    let released = false;
    void gate.whenIdle().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(true);
  });

  test("a Turn its agent no longer runs stops counting as busy", async () => {
    const { clock, advance } = fakeClock();
    const live = new Set(["run-a"]);
    const gate = new ForegroundGate({
      clock,
      launchedAt: -10 * 60 * SEC,
      isTurnLive: (runId) => live.has(runId),
    });
    gate.turnStarted("run-a");
    let released = false;
    void gate.whenIdle().then(() => {
      released = true;
    });
    await advance(60 * SEC);
    expect(gate.isBusy()).toBe(true);
    live.delete("run-a"); // died without a finished/error event
    await advance(30 * SEC); // noticed on the next liveness check
    expect(gate.isBusy()).toBe(false);
    await advance(5 * SEC);
    expect(released).toBe(true);
  });
});
