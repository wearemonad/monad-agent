import { useEffect, useRef, useState } from "react";

/** Typewriter smoothing for streamed text. Deltas arrive in bursty ~60ms
 *  chunks (the bun side coalesces them for the RPC); snapping each chunk in
 *  reads as stutter. Instead the UI reveals characters at a rate that tracks
 *  the backlog — fast enough to never fall behind the stream, slow enough
 *  that text appears to flow. */

/** Floor rate so short answers still visibly "type" (chars/second). */
const BASE_CPS = 90;
/** Backlog catch-up: each pending char adds this much rate, so the reveal
 *  self-regulates to the model's actual token speed and converges instead of
 *  lagging ever further behind on fast/long responses.
 *
 *  Tuned between two failure modes: a strong coupling (8) drains each ~60ms
 *  burst within a frame or two and then idles until the next one —
 *  burst-pause-burst reads as chunky — while a gentle one (2) held a standing
 *  backlog of (model cps − base)/2 chars, which on fast models meant the
 *  reveal ran a visible half-second behind the stream. At 4 the equilibrium
 *  backlog still exceeds one burst's worth of chars (so the cursor glides
 *  through arrival jitter without ever idling) but the standing lag is half
 *  of what 2 kept. */
const CATCHUP_PER_CHAR = 4;

/** Advance the reveal cursor by one animation frame. Pure — position is a
 *  float so fractional progress accumulates across frames. */
export function nextReveal(
  position: number,
  targetLength: number,
  dtMs: number,
): number {
  if (position >= targetLength) return targetLength;
  const backlog = targetLength - position;
  const rate = BASE_CPS + backlog * CATCHUP_PER_CHAR;
  return Math.min(targetLength, position + (rate * dtMs) / 1000);
}

/** The streamed `target` string, revealed progressively. Resets when the
 *  stream ends (empty target) or restarts. Runs one rAF loop only while
 *  there's something left to reveal. */
export function useSmoothText(target: string): string {
  const [shownLength, setShownLength] = useState(0);
  const positionRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const lastCommitRef = useRef(0);

  useEffect(() => {
    if (!target) {
      positionRef.current = 0;
      lastFrameRef.current = null;
      setShownLength(0);
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      // Real elapsed time, uncapped: a janky (or throttled) frame must not
      // slow the reveal in wall-clock terms — a capped dt made heavy
      // transcripts literally type slower. A long gap (backgrounded tab)
      // just snaps the cursor forward, which is the right catch-up anyway.
      const dt =
        lastFrameRef.current === null ? 16 : now - lastFrameRef.current;
      lastFrameRef.current = now;
      positionRef.current = nextReveal(positionRef.current, target.length, dt);
      const done = positionRef.current >= target.length;
      // ~30Hz state commits: the reveal math runs every frame for accuracy,
      // but each commit re-renders (and re-parses) the streaming tail —
      // committing at 60Hz doubles that cost for no visible smoothness gain.
      if (done || now - lastCommitRef.current >= 33) {
        lastCommitRef.current = now;
        setShownLength(Math.floor(positionRef.current));
      }
      if (!done) raf = requestAnimationFrame(tick);
      else lastFrameRef.current = null;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return target.slice(0, shownLength);
}
