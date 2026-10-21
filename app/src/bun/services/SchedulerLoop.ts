import type { LoopSpec } from "../runtime/BackgroundLoops";
import { HEARTBEAT_MS } from "./SchedulerService";

/** What the loops drive — SchedulerService in the app. */
export interface SchedulerDriver {
  /** One scheduler pass; must start nothing once `signal` has aborted. */
  tick: (now: undefined, signal: AbortSignal) => Promise<void>;
  /** Log the "alive" status line. */
  heartbeat: () => void;
}

/** A check (due jobs + connectivity probe) taking longer than this is
 *  abandoned: its signal aborts so it starts nothing, the timeout is logged
 *  and the next check runs on schedule. The probe alone is bounded at 5 s,
 *  so this only trips on something genuinely wedged — which used to block
 *  every later check behind a `ticking` flag. */
export const TICK_TIMEOUT_MS = 2 * 60_000;

/** The scheduler's timing, owned by the app runtime. */
export function schedulerLoops(scheduler: SchedulerDriver): LoopSpec[] {
  return [
    {
      name: "scheduler tick",
      firstDelay: 15_000,
      every: 60_000,
      timeout: TICK_TIMEOUT_MS,
      run: (signal) => scheduler.tick(undefined, signal),
    },
    // Its own loop, so "alive" keeps appearing in the log even while a check
    // is wedged — log silence then means the runtime itself stopped.
    {
      name: "scheduler heartbeat",
      firstDelay: HEARTBEAT_MS,
      every: HEARTBEAT_MS,
      run: () => scheduler.heartbeat(),
    },
  ];
}
