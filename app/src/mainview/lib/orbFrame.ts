import {
  MODE_FRAMES,
  type OrbSize,
  paintFrame,
  resolvePreset,
} from "thinking-orbs/engine";

/** The moment the library itself freezes on for reduced-motion users. */
const STILL_T = 0.6;

const cache = new Map<string, string>();

/** One still frame of the "working" thinking orb as an image URL, drawn once
 *  per size and light/dark and shared by every sidebar row. Rows then hold an
 *  <img> — no canvas, no animation loop, no per-orb theme observer — and get
 *  their motion from a compositor-only CSS pulse. Empty string when no 2D
 *  canvas is available. */
export function orbFrameUrl(size: OrbSize, dark: boolean): string {
  // dpr is in the key: a window moved to a Retina display gets a sharp frame.
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const key = `${size}:${dpr}:${dark ? "dark" : "light"}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  let url = "";
  if (ctx) {
    const { mode, opts } = resolvePreset("working", size);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintFrame(ctx, MODE_FRAMES[mode](size, STILL_T, opts), dark);
    url = canvas.toDataURL("image/png");
  }
  cache.set(key, url);
  return url;
}
