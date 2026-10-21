/** Fetch a web page and reduce it to readable markdown-ish text for ingest.
 *  Deliberately dependency-free: the ingest agent does the real understanding —
 *  this only has to strip the chrome and keep the words. */

const MAX_TEXT = 60_000;
/** Hard cap on a fetched body. Without it, a multi-GB file at a pasted URL
 *  buffers entirely into memory (arrayBuffer/text) and can OOM the backend. */
const MAX_CLIP_BYTES = 25 * 1024 * 1024;

export type WebClip = { title: string; text: string };

/** Read a response body into a Buffer, aborting once it exceeds `maxBytes`.
 *  Checks the declared Content-Length first (fast reject) then enforces the cap
 *  while streaming, so a lying or missing header can't defeat it. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (declared && declared > maxBytes) {
    throw new Error(
      `Content too large (${Math.round(declared / 1_048_576)}MB).`,
    );
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(
        `Content exceeds ${Math.round(maxBytes / 1_048_576)}MB cap.`,
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function fetchWebClip(
  rawUrl: string,
): Promise<
  | { kind: "page"; url: string; clip: WebClip }
  | { kind: "file"; url: string; filename: string; bytes: Buffer }
> {
  const url = new URL(rawUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be ingested.");
  }
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh) Monad/0.1 company-brain",
      Accept: "text/html,application/xhtml+xml,*/*",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";

  if (!/text\/html|application\/xhtml/.test(contentType)) {
    // PDFs, images, CSVs … — hand the raw file to the ingest skill unchanged.
    const base = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const filename = decodeURIComponent(base) || `download-${url.hostname}`;
    return {
      kind: "file",
      url: url.href,
      filename,
      bytes: await readCapped(res, MAX_CLIP_BYTES),
    };
  }

  const html = (await readCapped(res, MAX_CLIP_BYTES)).toString("utf8");
  return { kind: "page", url: url.href, clip: extractReadable(html) };
}

/** Crude readability: prefer <article>/<main>, drop script/style/nav/etc., strip tags. */
export function extractReadable(html: string): WebClip {
  const title = decodeEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "",
  ).replace(/\s+/g, " ");

  let scope = html;
  for (const tag of ["article", "main"]) {
    const m = html.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "i"));
    if (m && m[0].length > 500) {
      scope = m[0];
      break;
    }
  }

  const text = decodeEntities(
    scope
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|nav|header|footer|aside|form)[\s>][\s\S]*?<\/\1>/gi,
        " ",
      )
      // keep a little structure: headings/paragraph-ish breaks become newlines
      .replace(/<\/(h[1-6]|p|div|li|tr|section|blockquote)>/gi, "\n")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT);

  return { title, text };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#?39;|&apos;/g, "'");
}
