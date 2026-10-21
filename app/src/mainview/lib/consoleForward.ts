import type { WebviewLogLevel } from "../../shared/ipc";

/** Forward webview console output to the bun process, where stdout actually
 *  reaches the dev terminal. Electrobun gives the native WKWebView no working
 *  inspector (isInspectable is never set, so Safari can't attach; the docked
 *  inspector crashes the app when closed, as of 2.0.1 — see index.ts), which
 *  makes this the reliable way to see frontend logs. Original console
 *  behavior is preserved; forwarding is strictly additive. */

const LEVELS: WebviewLogLevel[] = ["log", "info", "warn", "error", "debug"];

/** Render one console argument as text. Objects are JSON (depth via the
 *  serializer, capped in length); errors keep their first stack lines. */
export function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    const stack = (arg.stack ?? "").split("\n").slice(0, 4).join("\n");
    return stack || `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      const json = JSON.stringify(arg);
      return json.length > 2_000 ? `${json.slice(0, 2_000)}…` : json;
    } catch {
      return String(arg); // circular or unserializable
    }
  }
  return String(arg);
}

export function formatLogArgs(args: unknown[]): string {
  return args.map(formatLogArg).join(" ");
}

/** Patch console.* (and window error events) to ALSO send each entry through
 *  `send`. Re-entrancy guarded: a failing transport that logs its own error
 *  must not recurse into another forward. */
export function forwardConsole(
  send: (level: WebviewLogLevel, text: string) => void,
): void {
  let forwarding = false;
  const emit = (level: WebviewLogLevel, text: string) => {
    if (forwarding) return;
    forwarding = true;
    try {
      send(level, text);
    } catch {
      // transport down — the original console output above still happened
    } finally {
      forwarding = false;
    }
  };
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      emit(level, formatLogArgs(args));
    };
  }
  window.addEventListener("error", (e) => {
    emit(
      "error",
      `Uncaught: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    emit("error", `Unhandled rejection: ${formatLogArg(e.reason)}`);
  });
}
