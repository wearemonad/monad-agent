import * as fs from "node:fs";
import * as path from "node:path";
import { Effect, Schedule } from "effect";
import type {
  GeneratedImage,
  ImageAspect,
  ImageProviderId,
  ImageRequest,
} from "../../../shared/images";
import {
  ImageAuthFailed,
  ImageContentBlocked,
  ImageNotProduced,
  ImageProviderError,
  ImageQuotaExhausted,
  ImageRateLimited,
  type ImageFailure,
} from "./ImageFailure";

/** One way of turning a prompt into image files. */
export interface ImageProvider {
  readonly id: ImageProviderId | "codex";
  readonly generate: (
    req: ImageRequest,
  ) => Effect.Effect<GeneratedImage[], ImageFailure>;
}

export type HttpProviderOptions = {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  /** Root folder for generated images; each request gets a subfolder. */
  outDir: string;
};

/** What a vendor's error body says beyond its status code. */
type FailureHint = "quota" | "blocked" | "auth";

/** A non-2xx answer, sorted by what the user can do about it. `hint` is the
 *  vendor's own error code, read by each provider. */
function httpFailure(
  provider: ImageProviderId,
  status: number,
  detail: string,
  hint?: FailureHint,
): ImageFailure {
  // 402 Payment Required: out of credits on a prepaid account.
  if (hint === "quota" || status === 402)
    return new ImageQuotaExhausted({ provider, detail });
  if (hint === "blocked") return new ImageContentBlocked({ provider, detail });
  if (status === 429) return new ImageRateLimited({ provider, detail });
  if (hint === "auth" || status === 401 || status === 403)
    return new ImageAuthFailed({ provider, reason: "invalid", detail });
  return new ImageProviderError({
    provider,
    detail,
    status,
    transient: status >= 500 || status === 408,
  });
}

/** Thrown inside a request to carry a typed failure out of tryPromise. */
class Failed {
  constructor(readonly failure: ImageFailure) {}
}

/** Retry what a retry can fix — 5xx, timeouts, dropped connections — twice,
 *  backing off. Rate limits and everything else surface at once: the user
 *  is waiting in a chat, and a provider's per-minute window outlasts any
 *  backoff worth sitting through. */
export function withTransientRetry<A>(
  effect: Effect.Effect<A, ImageFailure>,
): Effect.Effect<A, ImageFailure> {
  return effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential("2 seconds"),
      times: 2,
      while: (f) => f._tag === "ImageProviderError" && f.transient,
    }),
  );
}

/** Write decoded images into a fresh `outDir/<batch>/` folder. */
function saveImages(outDir: string, images: DecodedImage[]): GeneratedImage[] {
  const dir = path.join(outDir, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return images.map(({ bytes, ext }, i) => {
    const name = `image-${i + 1}.${ext}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return { path: file, name };
  });
}

type DecodedImage = { bytes: Uint8Array; ext: string };

/** File extension for an image MIME type (png when unknown). */
function extFor(mime: string | undefined): string {
  const sub = mime?.split("/")[1]?.split(";")[0]?.toLowerCase();
  if (sub === "jpeg" || sub === "jpg") return "jpg";
  if (sub === "webp") return "webp";
  return "png";
}

/** Decode a `data:image/…;base64,…` URL, or null when it isn't one. */
function fromDataUrl(url: string): DecodedImage | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return null;
  return { bytes: Buffer.from(m[2]!, "base64"), ext: extFor(m[1]) };
}

/** What one vendor's JSON API looks like; jsonImageProvider does the rest
 *  (HTTP, failure sorting, retries, saving). */
type VendorSpec<Body> = {
  id: ImageProviderId;
  request: (req: ImageRequest) => {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  /** A non-2xx body's message and the vendor's error code, if it has one. */
  error: (body: Body | null) => { detail?: string; hint?: FailureHint };
  /** A 2xx body's images — or a failure some vendors report with a 200
   *  (a safety block). `fetch` is for vendors that answer with URLs. */
  images: (
    body: Body,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ) => Promise<DecodedImage[] | ImageFailure>;
};

function jsonImageProvider<Body>(
  spec: VendorSpec<Body>,
  opts: HttpProviderOptions,
): ImageProvider {
  const fetch = opts.fetch ?? globalThis.fetch;
  const provider = spec.id;
  return {
    id: provider,
    generate: (req) =>
      withTransientRetry(
        Effect.tryPromise({
          try: async (signal) => {
            const { url, headers, body } = spec.request(req);
            const res = await fetch(url, {
              method: "POST",
              signal,
              headers: { "content-type": "application/json", ...headers },
              body: JSON.stringify(body),
            });
            const text = await res.text();
            let parsed: Body | null = null;
            try {
              parsed = JSON.parse(text) as Body;
            } catch {
              // a proxy's HTML error page, an empty body — keep the status
            }
            if (!res.ok) {
              const { detail, hint } = spec.error(parsed);
              throw new Failed(
                httpFailure(
                  provider,
                  res.status,
                  detail || text.slice(0, 200) || `HTTP ${res.status}`,
                  hint,
                ),
              );
            }
            if (!parsed) {
              throw new Failed(
                new ImageProviderError({
                  provider,
                  detail: `Unexpected response: ${text.slice(0, 200)}`,
                  status: res.status,
                  transient: false,
                }),
              );
            }
            const out = await spec.images(parsed, fetch, signal);
            if (!Array.isArray(out)) throw new Failed(out);
            if (out.length === 0) {
              throw new Failed(
                new ImageNotProduced({
                  provider,
                  detail: "The response contained no image.",
                }),
              );
            }
            return saveImages(opts.outDir, out);
          },
          catch: (e) =>
            e instanceof Failed
              ? e.failure
              : new ImageProviderError({
                  provider,
                  detail: String((e as Error)?.message ?? e),
                  // fetch rejects only when no response arrived
                  transient: true,
                }),
        }),
      ),
  };
}

const OPENAI_SIZE: Record<ImageAspect, string> = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};

type OpenAIBody = {
  data?: { b64_json?: string }[];
  error?: { message?: string; code?: string };
};

function openaiHint(code: string | undefined): FailureHint | undefined {
  if (code === "insufficient_quota" || code === "billing_hard_limit_reached")
    return "quota";
  if (code === "moderation_blocked" || code === "content_policy_violation")
    return "blocked";
  return undefined;
}

/** OpenAI's Images API (gpt-image models). */
export function openaiImageProvider(opts: HttpProviderOptions): ImageProvider {
  return jsonImageProvider<OpenAIBody>(
    {
      id: "openai",
      request: (req) => ({
        url: "https://api.openai.com/v1/images/generations",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: {
          model: opts.model,
          prompt: req.prompt,
          size: OPENAI_SIZE[req.aspect ?? "square"],
          n: 1,
        },
      }),
      error: (body) => ({
        detail: body?.error?.message,
        hint: openaiHint(body?.error?.code),
      }),
      images: async (body) =>
        (body.data ?? [])
          .map((d) => d.b64_json)
          .filter((b): b is string => !!b)
          .map((b) => ({ bytes: Buffer.from(b, "base64"), ext: "png" })),
    },
    opts,
  );
}

const GEMINI_ASPECT: Record<ImageAspect, string> = {
  square: "1:1",
  portrait: "2:3",
  landscape: "3:2",
};

type GeminiBody = {
  candidates?: {
    content?: {
      parts?: {
        text?: string;
        thought?: boolean;
        inlineData?: { mimeType?: string; data?: string };
      }[];
    };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: {
    message?: string;
    status?: string;
    details?: { reason?: string }[];
  };
};

/** finishReasons meaning Gemini's safety filters stopped the output. */
const GEMINI_BLOCKED =
  /^(SAFETY|IMAGE_SAFETY|PROHIBITED_CONTENT|IMAGE_PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_RECITATION)$/;

/** Google's Gemini API (Nano Banana image models). */
export function geminiImageProvider(opts: HttpProviderOptions): ImageProvider {
  return jsonImageProvider<GeminiBody>(
    {
      id: "gemini",
      request: (req) => ({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
        headers: { "x-goog-api-key": opts.apiKey },
        body: {
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: GEMINI_ASPECT[req.aspect ?? "square"] },
          },
        },
      }),
      error: (body) => ({
        detail: body?.error?.message,
        hint: body?.error?.details?.some((d) => d.reason === "API_KEY_INVALID")
          ? "auth"
          : undefined,
      }),
      images: async (body) => {
        const blocked =
          body.promptFeedback?.blockReason ??
          (GEMINI_BLOCKED.test(body.candidates?.[0]?.finishReason ?? "")
            ? body.candidates?.[0]?.finishReason
            : undefined);
        if (blocked) {
          return new ImageContentBlocked({
            provider: "gemini",
            detail: `Gemini declined the request (${blocked}).`,
          });
        }
        return (body.candidates?.[0]?.content?.parts ?? [])
          .filter((p) => !p.thought && p.inlineData?.data)
          .map((p) => ({
            bytes: Buffer.from(p.inlineData!.data!, "base64"),
            ext: extFor(p.inlineData!.mimeType),
          }));
      },
    },
    opts,
  );
}

const FAL_SIZE: Record<ImageAspect, string> = {
  square: "square_hd",
  portrait: "portrait_4_3",
  landscape: "landscape_4_3",
};

type FalBody = {
  images?: { url?: string; content_type?: string }[];
  /** A string, or FastAPI-style validation entries. */
  detail?: string | { msg?: string; type?: string }[];
};

function falError(body: FalBody | null): {
  detail?: string;
  hint?: FailureHint;
} {
  const d = body?.detail;
  const entries = Array.isArray(d) ? d : [];
  const detail =
    typeof d === "string" ? d : entries.map((e) => e.msg).join("; ");
  if (entries.some((e) => e.type === "content_policy_violation"))
    return { detail, hint: "blocked" };
  if (/exhausted balance|top up your balance/i.test(detail))
    return { detail, hint: "quota" };
  return { detail };
}

/** fal.ai's synchronous endpoint — one key, many models (Flux, Recraft…).
 *  It answers with links to the images, fetched here before saving. */
export function falImageProvider(opts: HttpProviderOptions): ImageProvider {
  return jsonImageProvider<FalBody>(
    {
      id: "fal",
      request: (req) => ({
        url: `https://fal.run/${opts.model.split("/").map(encodeURIComponent).join("/")}`,
        headers: { authorization: `Key ${opts.apiKey}` },
        body: {
          prompt: req.prompt,
          image_size: FAL_SIZE[req.aspect ?? "square"],
          num_images: 1,
        },
      }),
      error: falError,
      images: async (body, fetch, signal) => {
        const out: DecodedImage[] = [];
        for (const img of body.images ?? []) {
          if (!img.url) continue;
          const inline = fromDataUrl(img.url);
          if (inline) {
            out.push(inline);
            continue;
          }
          const res = await fetch(img.url, { signal });
          if (!res.ok) {
            return httpFailure(
              "fal",
              res.status,
              `Image download failed (HTTP ${res.status}).`,
            );
          }
          out.push({
            bytes: new Uint8Array(await res.arrayBuffer()),
            ext: extFor(
              img.content_type ?? res.headers.get("content-type") ?? undefined,
            ),
          });
        }
        return out;
      },
    },
    opts,
  );
}

type OpenRouterBody = {
  choices?: {
    message?: { images?: { image_url?: { url?: string } }[] };
  }[];
  error?: { code?: number; message?: string };
};

/** OpenRouter: image-capable models behind chat completions. */
export function openrouterImageProvider(
  opts: HttpProviderOptions,
): ImageProvider {
  return jsonImageProvider<OpenRouterBody>(
    {
      id: "openrouter",
      request: (req) => ({
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          // OpenRouter's app attribution headers.
          "http-referer": "https://github.com/wearemonad/monad-agent",
          "x-title": "Monad",
        },
        body: {
          model: opts.model,
          messages: [{ role: "user", content: req.prompt }],
          modalities: ["image", "text"],
          image_config: {
            aspect_ratio: GEMINI_ASPECT[req.aspect ?? "square"],
          },
        },
      }),
      error: (body) => ({ detail: body?.error?.message }),
      images: async (body) =>
        (body.choices?.[0]?.message?.images ?? [])
          .map((i) => (i.image_url?.url ? fromDataUrl(i.image_url.url) : null))
          .filter((i): i is DecodedImage => !!i),
    },
    opts,
  );
}

/** The API-key provider for `id`. */
export function makeHttpImageProvider(
  id: ImageProviderId,
  opts: HttpProviderOptions,
): ImageProvider {
  switch (id) {
    case "openai":
      return openaiImageProvider(opts);
    case "gemini":
      return geminiImageProvider(opts);
    case "fal":
      return falImageProvider(opts);
    case "openrouter":
      return openrouterImageProvider(opts);
  }
}
