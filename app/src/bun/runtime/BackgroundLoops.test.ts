import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Logger, Scope } from "effect";
import { TestClock } from "effect/testing";
import { backgroundLoops, type LoopSpec } from "./BackgroundLoops";

/** Every log line the loops emitted, as `Level message`. */
let logs: string[] = [];
const captureLogs = Logger.layer([
  Logger.make((o) => {
    const parts = Array.isArray(o.message) ? o.message : [o.message];
    logs.push(`${o.logLevel} ${parts.join(" ")}`);
  }),
]);

/** Build the loops layer under a TestClock, hand the test a clock to drive,
 *  then close the scope (what ManagedRuntime.dispose() does in the app). */
function withLoops(
  specs: LoopSpec[],
  body: (advance: (ms: number) => Promise<void>) => Promise<void>,
): Promise<void> {
  logs = [];
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(backgroundLoops(specs));
      const advance = (ms: number) =>
        Effect.runPromise(
          TestClock.adjust(ms).pipe(Effect.provideContext(context)),
        );
      const context = yield* Effect.context<TestClock.TestClock>();
      yield* Effect.promise(() => body(advance));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(TestClock.layer(), captureLogs)),
    ),
  );
}

describe("backgroundLoops", () => {
  test("first run waits for the first delay", async () => {
    let runs = 0;
    await withLoops(
      [
        {
          name: "sync",
          firstDelay: 10_000,
          every: 300_000,
          run: () => void runs++,
        },
      ],
      async (advance) => {
        await advance(9_999);
        expect(runs).toBe(0);
        await advance(1);
        expect(runs).toBe(1);
      },
    );
  });

  test("repeats on its cadence after the first run", async () => {
    let runs = 0;
    await withLoops(
      [
        {
          name: "sync",
          firstDelay: 10_000,
          every: 300_000,
          run: () => void runs++,
        },
      ],
      async (advance) => {
        await advance(10_000);
        await advance(299_999);
        expect(runs).toBe(1);
        await advance(1);
        expect(runs).toBe(2);
        await advance(600_000);
        expect(runs).toBe(4);
      },
    );
  });

  test("a startup task without a cadence runs exactly once", async () => {
    let runs = 0;
    await withLoops(
      [{ name: "memory", firstDelay: 8_000, run: () => void runs++ }],
      async (advance) => {
        await advance(8_000);
        await advance(24 * 3600_000);
        expect(runs).toBe(1);
      },
    );
  });

  test("a failing run is logged under its tag and the loop keeps going", async () => {
    let runs = 0;
    await withLoops(
      [
        {
          name: "watch-folders",
          firstDelay: 12_000,
          every: 60_000,
          run: () => {
            runs++;
            if (runs === 1) throw new Error("disk unplugged");
          },
        },
      ],
      async (advance) => {
        await advance(12_000);
        expect(logs).toEqual([
          "Error [watch-folders] run failed: disk unplugged",
        ]);
        await advance(60_000);
        expect(runs).toBe(2);
      },
    );
  });

  test("a slow run is never overlapped; the next waits a full period after it", async () => {
    let started = 0;
    let finish = () => {};
    await withLoops(
      [
        {
          name: "meeting-prep",
          firstDelay: 20_000,
          every: 300_000,
          run: () => {
            started++;
            return new Promise<void>((resolve) => (finish = resolve));
          },
        },
      ],
      async (advance) => {
        await advance(20_000);
        await advance(900_000);
        expect(started).toBe(1);
        finish();
        await Bun.sleep(1); // let the loop's fiber observe the resolution
        await advance(299_999);
        expect(started).toBe(1); // missed ticks don't pile up into a burst
        await advance(1);
        expect(started).toBe(2);
      },
    );
  });

  test("nothing runs after the owning scope closes", async () => {
    let runs = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(
          backgroundLoops([
            {
              name: "updates",
              firstDelay: 15_000,
              every: 4 * 3600_000,
              run: () => void runs++,
            },
            {
              name: "health",
              firstDelay: 30_000,
              every: 24 * 3600_000,
              run: () => void runs++,
            },
          ]),
          scope,
        );
        yield* TestClock.adjust(15_000);
        yield* Scope.close(scope, Exit.void);
        yield* TestClock.adjust(48 * 3600_000);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(runs).toBe(1);
  });

  test("closing the scope aborts a run that is still in flight", async () => {
    let aborted = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(
          backgroundLoops([
            {
              name: "health",
              firstDelay: 30_000,
              every: 24 * 3600_000,
              run: (signal) =>
                new Promise<void>(() =>
                  signal.addEventListener("abort", () => (aborted = true)),
                ),
            },
          ]),
          scope,
        );
        yield* TestClock.adjust(30_000);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(aborted).toBe(true);
  });

  test("a run past its timeout is aborted, logged, and the loop moves on", async () => {
    let started = 0;
    let aborted = 0;
    await withLoops(
      [
        {
          name: "health",
          firstDelay: 30_000,
          every: 3600_000,
          timeout: 600_000,
          run: (signal) => {
            started++;
            return new Promise<void>(() =>
              signal.addEventListener("abort", () => aborted++),
            );
          },
        },
      ],
      async (advance) => {
        await advance(30_000);
        await advance(600_000);
        expect(aborted).toBe(1);
        expect(logs).toEqual(["Warn [health] run timed out after 600s"]);
        await advance(3600_000);
        expect(started).toBe(2);
      },
    );
  });

  test("one loop failing every run leaves the others on schedule", async () => {
    let healthy = 0;
    await withLoops(
      [
        {
          name: "meeting-prep",
          firstDelay: 20_000,
          every: 300_000,
          run: () => Promise.reject(new Error("token expired")),
        },
        {
          name: "sync",
          firstDelay: 10_000,
          every: 300_000,
          run: () => void healthy++,
        },
      ],
      async (advance) => {
        await advance(10_000 + 3 * 300_000);
        expect(healthy).toBe(4);
        expect(logs.length).toBeGreaterThanOrEqual(3);
        expect(new Set(logs)).toEqual(
          new Set(["Error [meeting-prep] run failed: token expired"]),
        );
      },
    );
  });
});
