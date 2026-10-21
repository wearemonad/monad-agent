import { Context, Deferred, Effect, FiberMap, Layer } from "effect";

/** A one-shot background run that produces no SDK message for this long is
 *  treated as hung and aborted. Typical cause: a scheduled briefing started
 *  just before the laptop slept, left waiting on a connection that died with
 *  the sleep. A hung run is worse than a failed one — it holds the
 *  workspace's single background slot and its job's ran-today stamp, so
 *  nothing ever retries it. Generous on purpose: a healthy run emits a
 *  message per model turn and per tool result. */
export const BACKGROUND_STALL_MS = 20 * 60_000;
/** How often the silence watchdog looks. A check arriving more than three
 *  intervals after the previous one means the machine slept. */
const STALL_CHECK_MS = 60_000;

/** How a one-shot run ended — exactly one per run. A result message makes
 *  the run Finished no matter what the stream does afterwards. */
export type RunOutcome<M> =
  | { readonly _tag: "Finished"; readonly result: M }
  | { readonly _tag: "Failed"; readonly cause: unknown }
  | { readonly _tag: "EndedWithoutResult" }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "TimedOut" }
  /** The app is quitting (runtime disposed). Not the user's doing: owners
   *  clean up but report nothing — persisted state recovers it on launch. */
  | { readonly _tag: "Interrupted" };

/** One one-shot run (ingest, scheduled job, memory review). */
export interface RunSpec<M extends { type: string }> {
  readonly runId: string;
  readonly workspacePath: string;
  /** Open the SDK stream (after any async setup, e.g. booting Ollama). The
   *  signal aborts when the run is stopped, times out or the app quits. */
  readonly open: (
    signal: AbortSignal,
  ) => AsyncIterable<M> | Promise<AsyncIterable<M>>;
  /** Every streamed message, in order, awaited before the next. */
  readonly onMessage: (msg: M) => void | Promise<void>;
  /** Called once when the run is over. */
  readonly onOutcome: (outcome: RunOutcome<M>) => void | Promise<void>;
}

/** Race the stream against the user's Stop and the silence watchdog; the
 *  losers are interrupted, which aborts the stream's signal. */
function superviseRun<M extends { type: string }>(
  spec: RunSpec<M>,
  stop: Deferred.Deferred<void>,
  now: () => number,
): Effect.Effect<RunOutcome<M>> {
  let result: M | undefined;
  /** Whatever ends the run, a result already streamed wins. */
  const ended = (o: RunOutcome<M>): RunOutcome<M> =>
    result ? { _tag: "Finished", result } : o;
  let lastActivityAt = now();
  let lastCheckAt = lastActivityAt;

  const consume = Effect.tryPromise({
    try: async (signal): Promise<RunOutcome<M>> => {
      for await (const msg of await spec.open(signal)) {
        lastActivityAt = now();
        await spec.onMessage(msg);
        if (msg.type === "result") result = msg;
      }
      return ended({ _tag: "EndedWithoutResult" });
    },
    catch: (cause) => ended({ _tag: "Failed", cause }),
  }).pipe(Effect.catch(Effect.succeed));

  const stopped = Deferred.await(stop).pipe(
    Effect.map(() => ended({ _tag: "Stopped" })),
  );

  // Silence watchdog. Sleep-aware: a check arriving long after the previous
  // one means the machine slept, and the run gets a fresh window from wake —
  // the CLI may well recover once the network is back.
  const silent = Effect.sleep(STALL_CHECK_MS).pipe(
    Effect.map(() => {
      const t = now();
      if (t - lastCheckAt > 3 * STALL_CHECK_MS) lastActivityAt = t;
      lastCheckAt = t;
      return t - lastActivityAt > BACKGROUND_STALL_MS;
    }),
    Effect.repeat({ until: (stalled) => stalled }),
    Effect.map(() => ended({ _tag: "TimedOut" })),
  );

  return Effect.raceAllFirst([consume, stopped, silent]);
}

/** Hand the outcome to the run's owner; a throwing owner is logged. */
const report = <M extends { type: string }>(
  spec: RunSpec<M>,
  outcome: RunOutcome<M>,
) =>
  Effect.tryPromise(async () => spec.onOutcome(outcome)).pipe(
    Effect.catch((e) =>
      Effect.logError(
        `[runs] ${spec.runId}: outcome handler failed: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
      ),
    ),
  );

export class BackgroundRuns extends Context.Service<
  BackgroundRuns,
  {
    /** Start a run in its workspace's single background slot. False when
     *  that workspace already has one — two would race over knowledge/. */
    readonly start: <M extends { type: string }>(spec: RunSpec<M>) => boolean;
    readonly isBusy: (workspacePath: string) => boolean;
    /** The user's Stop. False when no such run is in flight. */
    readonly stop: (runId: string) => boolean;
  }
>()("monad/BackgroundRuns") {
  /** `now` is wall-clock time (Date.now): silence is measured in it, so a
   *  sleep gap is visible, while the checks themselves are paced by Effect's
   *  clock — frozen during sleep like any timer. */
  static readonly layerWith = (config: { now: () => number }) =>
    Layer.effect(
      BackgroundRuns,
      Effect.gen(function* () {
        const fibers = yield* FiberMap.make<string>();
        const fork = yield* FiberMap.runtime(fibers)<never>();
        /** Workspaces with a run in flight → that run's id. */
        const slots = new Map<string, string>();
        /** In-flight runs → their stop signal. */
        const stops = new Map<string, Deferred.Deferred<void>>();
        return {
          isBusy: (workspacePath) => slots.has(workspacePath),
          stop: (runId) => {
            const stop = stops.get(runId);
            return !!stop && Deferred.doneUnsafe(stop, Effect.void);
          },
          start: <M extends { type: string }>(spec: RunSpec<M>) => {
            if (slots.has(spec.workspacePath)) return false;
            slots.set(spec.workspacePath, spec.runId);
            const stop = Deferred.makeUnsafe<void>();
            stops.set(spec.runId, stop);
            fork(
              spec.runId,
              superviseRun(spec, stop, config.now).pipe(
                // Free the slot BEFORE reporting: the owner may start the
                // next run for this workspace from its outcome handler.
                Effect.ensuring(
                  Effect.sync(() => {
                    slots.delete(spec.workspacePath);
                    stops.delete(spec.runId);
                  }),
                ),
                Effect.onInterrupt(() => report(spec, { _tag: "Interrupted" })),
                Effect.flatMap((outcome) => report(spec, outcome)),
              ),
            );
            return true;
          },
        };
      }),
    );

  static readonly layer = BackgroundRuns.layerWith({ now: Date.now });
}
