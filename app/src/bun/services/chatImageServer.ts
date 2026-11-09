import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { CHAT_IMAGE_TYPES } from "./chatImages";

/** Serves generated chat images to the webview over loopback HTTP, so image
 *  bytes never cross the webview RPC bridge. Over RPC each image went out as
 *  a multi-MB base64 JSON string — read, encoded and serialized on the
 *  backend's only thread, again on every remount (each thread switch) —
 *  stalling the streams of every other running thread meanwhile. Here Bun
 *  streams the file straight from disk and the webview caches it.
 *
 *  Access control, since any local process can reach a loopback port:
 *  - a random 256-bit token, minted per launch, in every URL;
 *  - the Host header must be this server's own loopback address (DNS
 *    rebinding: a page on some other site can't make the webview's browser
 *    talk to us under a hostname it controls);
 *  - the path goes through `resolve` — the same guard readChatImage uses —
 *    so only a generated image inside an allowed folder is ever served. */
export type ChatImageServer = {
  /** The URL the webview loads `file` from (an already-resolved real path). */
  urlFor(file: string): string;
  stop(): void;
};

export function startChatImageServer(
  resolve: (file: string) => string | null,
): ChatImageServer {
  const token = randomBytes(32).toString("hex");
  const route = `/chat-image/${token}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`)
        return new Response(null, { status: 403 });
      if (req.method !== "GET" || url.pathname !== route)
        return new Response(null, { status: 404 });
      const real = resolve(url.searchParams.get("path") ?? "");
      if (!real) return new Response(null, { status: 404 });
      return new Response(Bun.file(real), {
        headers: {
          "Content-Type":
            CHAT_IMAGE_TYPES[path.extname(real).slice(1).toLowerCase()] ??
            "application/octet-stream",
          // A generated image is never rewritten — each has its own name.
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  });
  return {
    urlFor: (file) =>
      `http://127.0.0.1:${server.port}${route}?path=${encodeURIComponent(file)}`,
    stop: () => void server.stop(true),
  };
}
