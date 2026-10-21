import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { fakeStream } from "./fakeSdkStream";
import {
  BACKGROUND_STALL_MS,
  BackgroundRuns,
  type RunOutcome,
} from "./BackgroundRuns";

type Msg = { type: string; n?: number };

let rt: ManagedRuntime.ManagedRuntime<
  BackgroundRuns | TestClock.TestClock,
  never
>;
afterEach(() => rt?.dispose());

let logs: string[] = [];

async function setup() {
  logs = [];
  // Wall time (Date.now in the app) moves with the test clock while awake;
  // during OS sleep it jumps while timers stay frozen.
  let wall = 1_000_000;
  rt = ManagedRuntime.make(
    BackgroundRuns.layerWith({ now: () => wall }).pipe(
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(
        Logger.layer([
          Logger.make((o) => {
            const parts = Array.isArray(o.message) ? o.message : [o.message];
            logs.push(`${o.logLevel} ${parts.join(" ")}`);
          }),
        ]),
      ),
    ),
  );
  const runs = await rt.runPromise(Effect.service(BackgroundRuns));
  /** Awake time passing, in small steps like real timers. */
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; left -= 10_000) {
      const step = Math.min(10_000, left);
      wall += step;
      await rt.runPromise(TestClock.adjust(step));
      await settle();
    }
  };
  /** The machine sleeping: wall time jumps, no timer fires. */
  const osSleep = (ms: number) => {
    wall += ms;
  };
  return { runs, advance, osSleep };
}

/** Let fibers and the fake stream's promises settle. */
const settle = () => Bun.sleep(1);

/** Start one run on a fresh fake stream; collect its outcomes. */
function launch(
  runs: BackgroundRuns["Service"],
  runId = "r1",
  workspacePath = "/ws",
) {
  const stream = fakeStream<Msg>();
  const outcomes: RunOutcome<Msg>[] = [];
  const started = runs.start({
    runId,
    workspacePath,
    open: stream.open,
    onMessage: () => {},
    onOutcome: (o) => void outcomes.push(o),
  });
  return { stream, outcomes, started };
}

describe("BackgroundRuns", () => {
  test("a stream that reaches a result finishes once, with that result", async () => {
    const { runs } = await setup();
    const stream = fakeStream<Msg>();
    const outcomes: RunOutcome<Msg>[] = [];
    const seen: Msg[] = [];
    runs.start({
      runId: "r1",
      workspacePath: "/ws",
      open: stream.open,
      onMessage: (m) => void seen.push(m),
      onOutcome: (o) => void outcomes.push(o),
    });
    stream.push({ type: "assistant", n: 1 });
    stream.push({ type: "result", n: 2 });
    stream.end();
    await settle();
    expect(seen).toEqual([
      { type: "assistant", n: 1 },
      { type: "result", n: 2 },
    ]);
    expect(outcomes).toEqual([
      { _tag: "Finished", result: { type: "result", n: 2 } },
    ]);
  });

  test("a stream that ends without a result is reported as such", async () => {
    const { runs } = await setup();
    const { stream, outcomes } = launch(runs);
    stream.push({ type: "assistant" });
    stream.end();
    await settle();
    expect(outcomes).toEqual([{ _tag: "EndedWithoutResult" }]);
  });

  test("a stream that throws fails with the thrown error", async () => {
    const { runs } = await setup();
    const { stream, outcomes } = launch(runs);
    const boom = new Error("CLI exited 1");
    stream.fail(boom);
    await settle();
    expect(outcomes).toEqual([{ _tag: "Failed", cause: boom }]);
  });

  test("a throw after the result still counts as finished, once", async () => {
    const { runs } = await setup();
    const { stream, outcomes } = launch(runs);
    stream.push({ type: "result" });
    stream.fail(new Error("pipe closed"));
    await settle();
    expect(outcomes).toEqual([
      { _tag: "Finished", result: { type: "result" } },
    ]);
  });

  test("one run per workspace: a second start is refused, other workspaces aren't", async () => {
    const { runs } = await setup();
    expect(launch(runs, "r1", "/ws-a").started).toBe(true);
    expect(runs.isBusy("/ws-a")).toBe(true);
    expect(launch(runs, "r2", "/ws-a").started).toBe(false);
    expect(launch(runs, "r3", "/ws-b").started).toBe(true);
  });

  test("the slot is free by the time the outcome is reported", async () => {
    const { runs } = await setup();
    const stream = fakeStream<Msg>();
    let chained: boolean | undefined;
    runs.start({
      runId: "r1",
      workspacePath: "/ws",
      open: stream.open,
      onMessage: () => {},
      // e.g. ingest chaining the files that arrived mid-run
      onOutcome: () => {
        chained = launch(runs, "r2", "/ws").started;
      },
    });
    stream.push({ type: "result" });
    stream.end();
    await settle();
    expect(chained).toBe(true);
  });

  test("a user stop aborts the stream and reports a stop, once", async () => {
    const { runs } = await setup();
    const { stream, outcomes } = launch(runs);
    stream.push({ type: "assistant" });
    await settle();
    expect(runs.stop("r1")).toBe(true);
    await settle();
    expect(stream.aborted).toBe(true);
    expect(outcomes).toEqual([{ _tag: "Stopped" }]);
    expect(runs.isBusy("/ws")).toBe(false);
    expect(runs.stop("r1")).toBe(false); // already over
  });

  test("stopping a run that doesn't exist is a no-op", async () => {
    const { runs } = await setup();
    expect(runs.stop("nope")).toBe(false);
  });

  test("a silent run times out after the stall window, once", async () => {
    const { runs, advance } = await setup();
    const { stream, outcomes } = launch(runs);
    await advance(BACKGROUND_STALL_MS);
    expect(outcomes).toEqual([]);
    await advance(60_000);
    expect(outcomes).toEqual([{ _tag: "TimedOut" }]);
    expect(stream.aborted).toBe(true);
    expect(runs.isBusy("/ws")).toBe(false);
  });

  test("every message restarts the silence window", async () => {
    const { runs, advance } = await setup();
    const { stream, outcomes } = launch(runs);
    await advance(BACKGROUND_STALL_MS - 60_000);
    stream.push({ type: "assistant" });
    await settle();
    await advance(BACKGROUND_STALL_MS - 60_000);
    expect(outcomes).toEqual([]);
    await advance(2 * 60_000);
    expect(outcomes).toEqual([{ _tag: "TimedOut" }]);
  });

  test("waking from sleep restarts the window instead of killing the run", async () => {
    const { runs, advance, osSleep } = await setup();
    const { outcomes } = launch(runs);
    await advance(10 * 60_000);
    osSleep(2 * 3600_000); // lid closed for two hours
    await advance(60_000); // first check after wake: the window restarts here
    await advance(BACKGROUND_STALL_MS);
    expect(outcomes).toEqual([]);
    await advance(60_000);
    expect(outcomes).toEqual([{ _tag: "TimedOut" }]);
  });

  test("quitting the app interrupts the run — distinct from a user stop", async () => {
    const { runs } = await setup();
    const { stream, outcomes } = launch(runs);
    stream.push({ type: "assistant" });
    await settle();
    await rt.dispose();
    expect(stream.aborted).toBe(true);
    expect(outcomes).toEqual([{ _tag: "Interrupted" }]);
  });

  test("a failure while opening the stream fails the run and frees the slot", async () => {
    const { runs } = await setup();
    const outcomes: RunOutcome<Msg>[] = [];
    const cause = new Error("Ollama didn't start");
    runs.start<Msg>({
      runId: "r1",
      workspacePath: "/ws",
      open: async () => {
        throw cause;
      },
      onMessage: () => {},
      onOutcome: (o) => void outcomes.push(o),
    });
    await settle();
    expect(outcomes).toEqual([{ _tag: "Failed", cause }]);
    expect(runs.isBusy("/ws")).toBe(false);
  });

  test("an outcome handler that throws is logged, not lost", async () => {
    const { runs } = await setup();
    const stream = fakeStream<Msg>();
    runs.start<Msg>({
      runId: "r1",
      workspacePath: "/ws",
      open: stream.open,
      onMessage: () => {},
      onOutcome: () => {
        throw new Error("listener blew up");
      },
    });
    stream.end();
    await settle();
    expect(logs).toEqual([
      "Error [runs] r1: outcome handler failed: listener blew up",
    ]);
    expect(runs.isBusy("/ws")).toBe(false);
  });
});
