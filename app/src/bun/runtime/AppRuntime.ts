import { format } from "node:util";
import {
  Layer,
  Logger,
  ManagedRuntime,
  References,
  type LogLevel,
} from "effect";

const CONSOLE_METHOD: Record<
  LogLevel.LogLevel,
  "error" | "warn" | "info" | "debug" | null
> = {
  All: "debug",
  Fatal: "error",
  Error: "error",
  Warn: "warn",
  Info: "info",
  Debug: "debug",
  Trace: "debug",
  None: null,
};

/** Effect's log lines go through console, which AppLog mirrors into
 *  monad.log (with its timestamp, level and secret redaction) — so Export
 *  Diagnostics sees one log whether a line came from Effect or not.
 *  Annotations (workspaceId, runId, …) trail the message as key=value. */
export const appLogger = Logger.make((o) => {
  const method = CONSOLE_METHOD[o.logLevel];
  if (!method) return;
  const parts = Array.isArray(o.message) ? o.message : [o.message];
  const annotations = Object.entries(
    o.fiber.getRef(References.CurrentLogAnnotations),
  ).map(([k, v]) => ` ${k}=${typeof v === "string" ? v : format(v)}`);
  console[method](format(...parts) + annotations.join(""));
});

const appLoggerLayer = Logger.layer([appLogger]);

/** The backend's one runtime: built at startup, disposed on quit. The
 *  logger is provided *to* the layer (not merged beside it) so fibers the
 *  layer forks while building — the background loops — log through it too. */
export function makeAppRuntime<R, E>(layer: Layer.Layer<R, E, never>) {
  return ManagedRuntime.make(layer.pipe(Layer.provideMerge(appLoggerLayer)));
}

/** Electrobun's `before-quit` event, reduced to what the guard touches. */
export interface BeforeQuitEvent {
  response?: { allow: boolean };
}

/** Electrobun's quit is synchronous: `before-quit` handlers can't await, and
 *  shutdown force-exits within 5 s. Async cleanup therefore vetoes the first
 *  quit, disposes (bounded), then calls quit() again — which re-emits
 *  `before-quit`, and this time it's let through. Crashes, force-quit and
 *  update installs never reach the cleanup: persisted state plus launch-time
 *  recovery stays the guarantee, finalizers are only a convenience. */
export function createQuitGuard(opts: {
  dispose: () => Promise<void>;
  quit: () => void;
  timeoutMs: number;
}) {
  let state: "running" | "disposing" | "done" = "running";
  let updating = false;
  return {
    onBeforeQuit(event: BeforeQuitEvent): void {
      if (state === "done" || updating) return;
      event.response = { allow: false };
      if (state === "disposing") return;
      state = "disposing";
      console.info("[app] quitting — stopping background work");
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `[app] cleanup still running after ${opts.timeoutMs / 1000}s — quitting anyway`,
          );
          resolve();
        }, opts.timeoutMs);
      });
      const cleanup = opts.dispose().then(
        () =>
          console.info(
            `[app] background work stopped in ${Date.now() - started}ms`,
          ),
        (e: unknown) =>
          console.error(
            `[app] cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      );
      void Promise.race([cleanup, deadline]).then(() => {
        clearTimeout(timer);
        state = "done";
        opts.quit();
      });
    },
    /** Run Updater.applyUpdate(): it asks before-quit once and cancels the
     *  install on a veto, so quits are let through for its duration only —
     *  a no-op or failed install leaves later quits guarded again. */
    async duringUpdateRestart<A>(apply: () => Promise<A>): Promise<A> {
      updating = true;
      try {
        return await apply();
      } finally {
        updating = false;
      }
    },
  };
}
