import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Cause,
  Context,
  Effect,
  Exit,
  type Fiber,
  FiberSet,
  Layer,
  Queue,
} from "effect";

/** How long an idle live session keeps its warm CLI process before being
 *  reaped. Long enough to cover a normal think-read-reply rhythm, short enough
 *  that walking away doesn't leave subprocesses running all day. */
export const LIVE_IDLE_MS = 10 * 60_000;
/** After an interrupt (or graceful close), how long the CLI gets to settle on
 *  its own before the process is killed outright. */
export const ABORT_SETTLE_MS = 5_000;
/** User messages waiting for the CLI to read them. The SDK reads its input
 *  continuously and the owner allows one turn per thread, so this is never
 *  near full; a full queue refuses the message rather than dropping one. */
const INPUT_CAPACITY = 16;

/** The input side of a live (streaming-input) session: a bounded Effect
 *  Queue read as the SDK's prompt stream. push() refuses (false) once the
 *  input has ended, never drops; end() lets the CLI drain what's queued and
 *  exit gracefully. Exported for tests. */
export function makeInputQueue(): {
  stream: AsyncIterable<SDKUserMessage>;
  push: (msg: SDKUserMessage) => boolean;
  end: () => void;
} {
  const queue = Effect.runSync(
    Queue.bounded<SDKUserMessage, Cause.Done>(INPUT_CAPACITY),
  );
  const stream = (async function* () {
    while (true) {
      const next = await Effect.runPromiseExit(Queue.take(queue));
      if (Exit.isFailure(next)) return; // ended and drained
      yield next.value;
    }
  })();
  return {
    stream,
    push: (msg) => Queue.offerUnsafe(queue, msg),
    end: () => void Queue.endUnsafe(queue),
  };
}

/** What a live session needs from its owner (AgentService), which keeps
 *  everything SDK-specific: options, normalization, events. */
export interface SessionSpec {
  /** Spawn the CLI reading `input`. `abort` kills it. */
  readonly open: (
    input: AsyncIterable<SDKUserMessage>,
    abort: AbortController,
  ) => Promise<AsyncIterable<SDKMessage>>;
  /** Every message the CLI streams, in order. */
  readonly onMessage: (msg: SDKMessage) => void;
  /** The session started closing (asked to, idle expiry, a Stop the CLI
   *  never acknowledged): it must not be handed another turn. */
  readonly onClosing: () => void;
  /** The process is gone. `error` is why, when it failed; undefined when it
   *  exited on its own. Called once. */
  readonly onEnd: (error: unknown) => void;
}

/** One warm CLI process's lifetime. Turns, reuse and events are the
 *  owner's; this owns the process, its input and its timers. */
export interface AgentSession {
  /** Queue a user message for the CLI. False once the session is closing. */
  readonly send: (message: SDKUserMessage) => boolean;
  /** No turn in flight: the session closes itself after the idle timeout
   *  unless a turn starts first. */
  readonly idle: () => void;
  /** A turn started: cancels the idle timeout. */
  readonly busy: () => void;
  /** Stop the current turn but keep the process: `interrupt` asks the CLI.
   *  If the turn hasn't settled within the settle timeout, or the request
   *  fails, the session closes instead. */
  readonly interrupt: (interrupt: () => Promise<unknown>) => void;
  /** The current turn settled (its result arrived): cancels the fallback. */
  readonly settled: () => void;
  /** Retire: end the input so the CLI exits on its own, and kill it if it
   *  is still running after the settle timeout. */
  readonly close: () => void;
  readonly closing: boolean;
  /** The process was killed (close fallback, or the app quitting). */
  readonly killed: boolean;
}

export class AgentSessions extends Context.Service<
  AgentSessions,
  { readonly open: (spec: SessionSpec) => AgentSession }
>()("monad/AgentSessions") {
  static readonly layerWith = (config: { idleMs: number; settleMs: number }) =>
    Layer.effect(
      AgentSessions,
      Effect.gen(function* () {
        // Every session and timer is a fiber of the app runtime: quitting
        // interrupts them all, and an interrupted session kills its CLI.
        const fibers = yield* FiberSet.make();
        const fork = yield* FiberSet.runtime(fibers)<never>();
        return {
          open: (spec) => {
            const input = makeInputQueue();
            const abort = new AbortController();
            /** Asked to close (by the owner or by itself). */
            let closing = false;
            /** The process is gone. */
            let ended = false;
            const timers: Record<
              "idle" | "settle" | "kill",
              Fiber.Fiber<void> | undefined
            > = { idle: undefined, settle: undefined, kill: undefined };
            const disarm = (name: keyof typeof timers) => {
              timers[name]?.interruptUnsafe();
              timers[name] = undefined;
            };
            const arm = (
              name: keyof typeof timers,
              ms: number,
              then: () => void,
            ) => {
              disarm(name);
              timers[name] = fork(
                Effect.sleep(ms).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      timers[name] = undefined; // fired: nothing to disarm
                      then();
                    }),
                  ),
                ),
              );
            };
            const close = () => {
              if (closing || ended) return;
              closing = true;
              disarm("idle");
              disarm("settle");
              spec.onClosing();
              input.end();
              arm("kill", config.settleMs, () => abort.abort());
            };

            fork(
              Effect.tryPromise({
                try: async (signal) => {
                  signal.addEventListener("abort", () => abort.abort(), {
                    once: true,
                  });
                  for await (const msg of await spec.open(
                    input.stream,
                    abort,
                  )) {
                    spec.onMessage(msg);
                  }
                },
                catch: (e) => e,
              }).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    ended = true;
                    for (const name of ["idle", "settle", "kill"] as const)
                      disarm(name);
                    input.end();
                    spec.onEnd(
                      Exit.isSuccess(exit)
                        ? undefined
                        : Cause.hasInterruptsOnly(exit.cause)
                          ? new Error("Monad is quitting.")
                          : Cause.squash(exit.cause),
                    );
                  }),
                ),
              ),
            );

            return {
              send: (message) => !closing && !ended && input.push(message),
              idle: () => {
                if (!closing && !ended) arm("idle", config.idleMs, close);
              },
              busy: () => disarm("idle"),
              interrupt: (interrupt) => {
                if (closing || ended) return;
                arm("settle", config.settleMs, close);
                interrupt().catch(close);
              },
              settled: () => disarm("settle"),
              close,
              get closing() {
                return closing;
              },
              get killed() {
                return abort.signal.aborted;
              },
            };
          },
        };
      }),
    );

  static readonly layer = AgentSessions.layerWith({
    idleMs: LIVE_IDLE_MS,
    settleMs: ABORT_SETTLE_MS,
  });
}
