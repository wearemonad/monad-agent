/** Chunked base64 of a file's bytes. A spread over the whole array
 *  (`String.fromCharCode(...new Uint8Array(buf))`) throws
 *  "Maximum call stack size exceeded" for anything past a few hundred KB —
 *  which is every image — so encode in 32KB windows. Used by both the
 *  drop-to-ingest and paste-attachment paths. */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Compact token counts the way model specs are quoted: 79k, 200k, 1m.
 *  Shared by the composer's context ring and the model picker. */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Run an action on Enter and consume the key. A key event the webview leaves
 *  unhandled reaches AppKit, which answers it with the system alert beep — so
 *  every handler that acts on a key must also claim it. Modified presses
 *  (⌘↩, ⇧↩) fall through untouched. */
export function onEnter(run: () => void) {
  return (e: import("react").KeyboardEvent) => {
    if (e.key !== "Enter" || e.metaKey || e.shiftKey || e.altKey || e.ctrlKey)
      return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };
}

/** "2m ago", "3h ago", "69d ago" — T3-style relative timestamps. */
export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
