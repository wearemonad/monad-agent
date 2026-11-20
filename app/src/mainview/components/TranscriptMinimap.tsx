import { type MouseEvent, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import {
  currentTurn,
  type MinimapTurn,
  plainLine,
  previewText,
  tickTopPercent,
  turnAtPointer,
  turnsInView,
  type VisibleRowsStore,
} from "../lib/transcriptMinimap";

/** Fewer turns than this and there's nothing to navigate. */
const MIN_TURNS = 2;
/** Space per tick until the rail hits its cap. */
const TICK_SPACING_PX = 8;

/** A tick shrinks with its distance from the hovered one: a small fisheye
 *  that shows where the pointer is without a cursor. Scale only (compositor). */
const FISHEYE = ["scale-x-100", "scale-x-[0.667]", "scale-x-[0.417]"];

/** The rail at the transcript's left edge, after T3 Code's TimelineMinimap:
 *  one tick per turn, brighter while that turn is on screen. Hovering (or
 *  arrowing through it from the keyboard) previews a turn — your message and
 *  the start of its answer — and clicking or Enter jumps there. */
export function TranscriptMinimap({
  turns,
  visible,
  onJump,
}: {
  turns: MinimapTurn[];
  visible: VisibleRowsStore;
  onJump: (turn: MinimapTurn) => void;
}) {
  const range = useSyncExternalStore(visible.subscribe, visible.get);
  const [active, setActive] = useState<number | null>(null);

  if (turns.length < MIN_TURNS) return null;

  const starts = turns.map((t) => t.rowIndex);
  const inView = range ? turnsInView(starts, range) : [];
  const current = range ? currentTurn(starts, range) : null;
  const activeIndex = active !== null && active < turns.length ? active : null;
  const activeTurn = activeIndex === null ? null : turns[activeIndex];
  const preview = activeTurn && {
    user: plainLine(activeTurn.user) || "Your message",
    answer: activeTurn.answer ? previewText(activeTurn.answer) : "",
  };

  const fromPointer = (e: MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return turnAtPointer({
      count: turns.length,
      top: rect.top,
      height: rect.height,
      y: e.clientY,
    });
  };
  const move = (delta: number) =>
    setActive((i) =>
      Math.max(0, Math.min(turns.length - 1, (i ?? current ?? 0) + delta)),
    );

  return (
    <div
      className={cn(
        // Overlays the transcript's left gutter. With a wide enough window
        // the gutter is free and the rail always shows; narrower, the column
        // reaches the edge and the rail appears only while pointed at.
        "pointer-events-none absolute inset-y-0 left-0 z-10 w-18",
        "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 @min-[54rem]/transcript:opacity-100",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto absolute top-1/2 -translate-y-1/2",
          // Without a gutter the column's text starts 24px in: keep the
          // (invisible until hovered) hit strip inside that padding so it
          // never catches a click or selection meant for the text.
          "left-0 w-4 @min-[54rem]/transcript:left-3 @min-[54rem]/transcript:w-8",
        )}
        style={{
          // Grows with the Thread, capped clear of the composer (so the
          // preview of an end tick, centred on it, still fits).
          height: `min(${(turns.length - 1) * TICK_SPACING_PX}px, max(4rem, calc(100% - 15rem)))`,
        }}
      >
        <button
          type="button"
          aria-label={`Jump to message: ${preview?.user ?? plainLine(turns[current ?? 0]?.user ?? "")}`}
          className="absolute inset-0 cursor-pointer rounded-sm outline-none before:absolute before:inset-x-0 before:-inset-y-2 focus-visible:ring-2 focus-visible:ring-ring/50"
          // A text-selection drag passing over the rail isn't pointing at it.
          onMouseMove={(e) => e.buttons === 0 && setActive(fromPointer(e))}
          onMouseLeave={() => setActive(null)}
          onMouseDown={(e) => e.preventDefault()}
          onFocus={() => setActive((i) => i ?? current ?? 0)}
          onBlur={() => setActive(null)}
          onClick={(e) => {
            // A pointer click jumps to the tick under it. Enter and Space
            // are handled in onKeyDown; a click with no pointer (a screen
            // reader's) takes the picked turn, else the one being read.
            const index =
              e.detail === 0 ? (activeIndex ?? current) : fromPointer(e);
            const turn = index === null ? undefined : turns[index];
            if (turn) onJump(turn);
          }}
          onKeyDown={(e) => {
            switch (e.key) {
              case "ArrowDown":
                move(1);
                break;
              case "ArrowUp":
                move(-1);
                break;
              case "Home":
                setActive(0);
                break;
              case "End":
                setActive(turns.length - 1);
                break;
              case "Enter":
              case " ": {
                const turn = turns[activeIndex ?? current ?? 0];
                if (turn) onJump(turn);
                break;
              }
              default:
                return;
            }
            e.preventDefault();
          }}
        >
          {turns.map((turn, i) => {
            const distance =
              activeIndex === null ? null : Math.abs(i - activeIndex);
            return (
              <span
                key={turn.key}
                aria-hidden
                style={{ top: `${tickTopPercent(i, turns.length)}%` }}
                className={cn(
                  "absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-[scale,background-color] duration-150 ease-out motion-reduce:transition-[background-color]",
                  distance === 0
                    ? "bg-foreground/70"
                    : inView[i]
                      ? "bg-foreground/45"
                      : "bg-muted-foreground/25",
                  distance === null || distance > 2
                    ? "scale-x-[0.333]"
                    : FISHEYE[distance],
                )}
              />
            );
          })}
        </button>
        {preview && activeIndex !== null && (
          // Display only: it covers the column, and the rail keeps tracking.
          <div
            className="pointer-events-none absolute left-9 w-80 -translate-y-1/2 rounded-xl bg-popover/90 p-3 text-left text-popover-foreground shadow-xl ring-1 ring-foreground/10 backdrop-blur"
            style={{ top: `${tickTopPercent(activeIndex, turns.length)}%` }}
          >
            <p className="truncate text-sm font-medium leading-5">
              {preview.user}
            </p>
            {preview.answer && (
              <p className="mt-1 line-clamp-3 text-sm leading-5 text-muted-foreground">
                {preview.answer}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
