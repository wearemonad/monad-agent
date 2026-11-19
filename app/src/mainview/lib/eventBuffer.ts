/** How the buffer schedules its flush — the browser's frame + timer APIs in
 *  the app, a hand-cranked fake in tests. */
export type FrameScheduler = {
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
};

export const browserScheduler: FrameScheduler = {
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (cb, ms) => window.setTimeout(cb, ms),
  clearTimer: (id) => window.clearTimeout(id),
};

export type EventBuffer<E> = {
  push: (event: E) => void;
  /** Apply everything buffered now — for messages whose meaning depends on
   *  the events before them being applied first. */
  flush: () => void;
};

/** Collects events and applies them as one batch per animation frame, so a
 *  burst of stream events costs one store update (and one render) instead of
 *  one each. requestAnimationFrame doesn't run while the window is hidden, so
 *  a timer flushes then — state stays current and the buffer can't grow. */
export function createEventBuffer<E>(
  apply: (batch: E[]) => void,
  sched: FrameScheduler = browserScheduler,
  fallbackMs = 250,
): EventBuffer<E> {
  let buffer: E[] = [];
  let frame: number | null = null;
  let timer: number | null = null;

  const flush = () => {
    if (frame !== null) sched.cancelFrame(frame);
    if (timer !== null) sched.clearTimer(timer);
    frame = timer = null;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    apply(batch);
  };

  return {
    push(event) {
      buffer.push(event);
      if (frame === null) frame = sched.requestFrame(flush);
      if (timer === null) timer = sched.setTimer(flush, fallbackMs);
    },
    flush,
  };
}
