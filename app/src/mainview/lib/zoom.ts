/** UI zoom (View → Zoom In / Zoom Out / Actual Size, ⌘+/⌘−/⌘0), implemented
 *  as a root font-size scale: Tailwind v4 sizes text and spacing in rem, so
 *  scaling <html> scales the whole layout together — while the px-calibrated
 *  titlebar offsets (--titlebar-toggle-x / --titlebar-content-x, aligned to
 *  the system-drawn traffic lights) deliberately stay put. The CSS `zoom`
 *  property would drag those along and misalign the native chrome. */

const ZOOM_KEY = "monad-zoom";
/** Chrome-style ladder. 1 must be a member so reset lands exactly on it. */
const LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];

let level = ((): number => {
  const z = Number(localStorage.getItem(ZOOM_KEY));
  return LEVELS.includes(z) ? z : 1;
})();

function apply() {
  // A percentage of the default (16px), not absolute px, so a system-level
  // font preference still shines through underneath the zoom.
  document.documentElement.style.fontSize =
    level === 1 ? "" : `${level * 100}%`;
}
apply(); // module load runs before first render — no flash of unzoomed UI

function set(z: number) {
  level = z;
  if (z === 1) localStorage.removeItem(ZOOM_KEY);
  else localStorage.setItem(ZOOM_KEY, String(z));
  apply();
}

export function zoomIn() {
  set(LEVELS[Math.min(LEVELS.indexOf(level) + 1, LEVELS.length - 1)]);
}

export function zoomOut() {
  set(LEVELS[Math.max(LEVELS.indexOf(level) - 1, 0)]);
}

export function zoomReset() {
  set(1);
}
