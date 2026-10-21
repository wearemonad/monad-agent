import { Data, Effect, Layer, Schedule } from "effect";

/** A background task the app runtime owns: runs once after `firstDelay`,
 *  then `every` ms after each run finishes, until the runtime is disposed.
 *  Runs never overlap — a slow run delays the next instead of stacking. */
export interface LoopSpec {
  /** Log tag — failures are logged as `[name] …`. */
  readonly name: string;
  /** Milliseconds after startup before the first run. */
  readonly firstDelay: number;
  /** Milliseconds between runs; omit for a one-shot startup task. */
  readonly every?: number;
  /** Milliseconds a single run may take before it's aborted and logged;
   *  the loop then carries on with its next run. Omit for no limit. */
  readonly timeout?: number;
  /** The signal aborts on timeout or when the runtime is disposed mid-run. */
  readonly run: (signal: AbortSignal) => void | Promise<void>;
}

/** One run of a loop threw or rejected. Logged, never fatal to the loop. */
export class LoopRunError extends Data.TaggedError("LoopRunError")<{
  readonly loop: string;
  readonly cause: unknown;
}> {
  override get message() {
    const c = this.cause;
    return c instanceof Error ? c.message : String(c);
  }
}

const ownedLoop = (spec: LoopSpec) => {
  const attempt = Effect.tryPromise({
    try: async (signal) => spec.run(signal),
    catch: (cause) => new LoopRunError({ loop: spec.name, cause }),
  });
  const once = (
    spec.timeout === undefined
      ? attempt
      : attempt.pipe(Effect.timeout(spec.timeout))
  ).pipe(
    Effect.catchTag("LoopRunError", (e) =>
      Effect.logError(`[${e.loop}] run failed: ${e.message}`),
    ),
    Effect.catchTag("TimeoutError", () =>
      Effect.logWarning(
        `[${spec.name}] run timed out after ${Math.round((spec.timeout ?? 0) / 1000)}s`,
      ),
    ),
  );
  const body =
    spec.every === undefined
      ? once
      : once.pipe(Effect.repeat(Schedule.spaced(spec.every)));
  return Effect.sleep(spec.firstDelay).pipe(
    Effect.andThen(body),
    Effect.forkScoped,
  );
};

/** Every loop as a fiber scoped to the layer: building it starts them,
 *  closing the scope (runtime dispose) stops them. */
export const backgroundLoops = (specs: readonly LoopSpec[]) =>
  Layer.effectDiscard(Effect.forEach(specs, ownedLoop, { discard: true }));
