import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ImageFailure } from "./ImageFailure";
import {
  falImageProvider,
  geminiImageProvider,
  openaiImageProvider,
  openrouterImageProvider,
} from "./httpProviders";

// The HTTP image providers, driven through an injected fetch that answers
// with the response shapes each vendor documents.

/** A 1×1 transparent PNG — what a provider's base64 payload decodes to. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

let outDir: string;
beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-images-"));
});
afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

type Call = { url: string; init: RequestInit };

/** A fake endpoint: each call takes the next scripted response. */
function scriptedFetch(...replies: Response[]) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    return reply.clone();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const run = <A>(e: Effect.Effect<A, ImageFailure>) => Effect.runPromiseExit(e);

function failureOf<A>(exit: Exit.Exit<A, ImageFailure>): ImageFailure {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const err = exit.cause.reasons.find((r) => r._tag === "Fail");
  if (err?._tag !== "Fail") throw new Error("expected a typed failure");
  return err.error;
}

describe("OpenAI image provider", () => {
  test("saves the returned image to disk and reports where", async () => {
    const { fetch, calls } = scriptedFetch(
      json(200, { created: 1, data: [{ b64_json: PNG_B64 }] }),
    );
    const provider = openaiImageProvider({
      apiKey: "sk-test",
      model: "gpt-image-2",
      fetch,
      outDir,
    });

    const images = await Effect.runPromise(
      provider.generate({ prompt: "a red fox", aspect: "landscape" }),
    );

    expect(images).toHaveLength(1);
    expect(fs.readFileSync(images[0]!.path)).toEqual(PNG_BYTES);
    expect(images[0]!.path.startsWith(outDir)).toBe(true);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer sk-test",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: "gpt-image-2",
      prompt: "a red fox",
      size: "1536x1024",
    });
  });

  const openai = (fetch: typeof globalThis.fetch) =>
    openaiImageProvider({
      apiKey: "sk-test",
      model: "gpt-image-2",
      fetch,
      outDir,
    });

  test("a 429 rate limit is reported as rate-limited, with OpenAI's wording", async () => {
    const { fetch } = scriptedFetch(
      json(429, {
        error: {
          message: "Rate limit reached for gpt-image-2 on images per minute.",
          type: "requests",
          code: "rate_limit_exceeded",
        },
      }),
    );
    const failure = failureOf(
      await run(openai(fetch).generate({ prompt: "x" })),
    );
    expect(failure._tag).toBe("ImageRateLimited");
    expect(failure.detail).toContain("Rate limit reached");
  });

  test("an exhausted quota is a billing problem, not a wait", async () => {
    const { fetch } = scriptedFetch(
      json(429, {
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    );
    const failure = failureOf(
      await run(openai(fetch).generate({ prompt: "x" })),
    );
    expect(failure._tag).toBe("ImageQuotaExhausted");
  });

  test("a rejected API key is an invalid credential", async () => {
    const { fetch } = scriptedFetch(
      json(401, {
        error: {
          message: "Incorrect API key provided: sk-test.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
    );
    const failure = failureOf(
      await run(openai(fetch).generate({ prompt: "x" })),
    );
    expect(failure).toMatchObject({
      _tag: "ImageAuthFailed",
      reason: "invalid",
    });
  });

  test("a safety-system rejection is reported as blocked content", async () => {
    const { fetch } = scriptedFetch(
      json(400, {
        error: {
          message:
            "Your request was rejected as a result of our safety system.",
          type: "image_generation_user_error",
          code: "moderation_blocked",
        },
      }),
    );
    const failure = failureOf(
      await run(openai(fetch).generate({ prompt: "x" })),
    );
    expect(failure._tag).toBe("ImageContentBlocked");
  });

  test("a transient server error is retried until it succeeds", async () => {
    const { fetch, calls } = scriptedFetch(
      json(503, { error: { message: "The server is overloaded." } }),
      json(200, { data: [{ b64_json: PNG_B64 }] }),
    );
    const images = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          openai(fetch).generate({ prompt: "x" }),
        );
        yield* TestClock.adjust("1 minute");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(images).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("a rate limit is not retried — the user hears about it at once", async () => {
    const { fetch, calls } = scriptedFetch(
      json(429, { error: { message: "Rate limit reached." } }),
    );
    await run(openai(fetch).generate({ prompt: "x" }));
    expect(calls).toHaveLength(1);
  });
});

describe("Gemini image provider", () => {
  const gemini = (fetch: typeof globalThis.fetch) =>
    geminiImageProvider({
      apiKey: "g-key",
      model: "gemini-3.1-flash-image-preview",
      fetch,
      outDir,
    });

  test("saves the final image part, skipping thought images", async () => {
    const THOUGHT = Buffer.from("draft").toString("base64");
    const { fetch, calls } = scriptedFetch(
      json(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: "Here is your fox." },
                {
                  inlineData: { mimeType: "image/png", data: THOUGHT },
                  thought: true,
                },
                { inlineData: { mimeType: "image/png", data: PNG_B64 } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );

    const images = await Effect.runPromise(
      gemini(fetch).generate({ prompt: "a red fox", aspect: "portrait" }),
    );

    expect(images).toHaveLength(1);
    expect(fs.readFileSync(images[0]!.path)).toEqual(PNG_BYTES);
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
    );
    expect(new Headers(calls[0]!.init.headers).get("x-goog-api-key")).toBe(
      "g-key",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      contents: [{ parts: [{ text: "a red fox" }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "2:3" },
      },
    });
  });

  test("a safety stop arrives as a 200 and is reported as blocked content", async () => {
    const { fetch } = scriptedFetch(
      json(200, {
        candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }],
      }),
    );
    const failure = failureOf(
      await run(gemini(fetch).generate({ prompt: "x" })),
    );
    expect(failure._tag).toBe("ImageContentBlocked");
  });

  test("an invalid key (a 400 from Gemini) is an invalid credential", async () => {
    const { fetch } = scriptedFetch(
      json(400, {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      }),
    );
    const failure = failureOf(
      await run(gemini(fetch).generate({ prompt: "x" })),
    );
    expect(failure).toMatchObject({
      _tag: "ImageAuthFailed",
      reason: "invalid",
    });
  });
});

describe("fal.ai image provider", () => {
  const fal = (fetch: typeof globalThis.fetch) =>
    falImageProvider({
      apiKey: "fal-key",
      model: "fal-ai/flux/schnell",
      fetch,
      outDir,
    });

  test("downloads the image the response links to", async () => {
    const { fetch, calls } = scriptedFetch(
      json(200, {
        images: [
          {
            url: "https://v3.fal.media/files/fox.png",
            width: 1024,
            height: 768,
            content_type: "image/png",
          },
        ],
        seed: 42,
      }),
      new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
    );

    const images = await Effect.runPromise(
      fal(fetch).generate({ prompt: "a red fox", aspect: "landscape" }),
    );

    expect(fs.readFileSync(images[0]!.path)).toEqual(PNG_BYTES);
    expect(calls[0]!.url).toBe("https://fal.run/fal-ai/flux/schnell");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Key fal-key",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      prompt: "a red fox",
      image_size: "landscape_4_3",
    });
    expect(calls[1]!.url).toBe("https://v3.fal.media/files/fox.png");
  });

  test("an exhausted balance is a billing problem", async () => {
    const { fetch } = scriptedFetch(
      json(403, {
        detail:
          "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.",
      }),
    );
    const failure = failureOf(await run(fal(fetch).generate({ prompt: "x" })));
    expect(failure._tag).toBe("ImageQuotaExhausted");
  });
});

describe("OpenRouter image provider", () => {
  const openrouter = (fetch: typeof globalThis.fetch) =>
    openrouterImageProvider({
      apiKey: "or-key",
      model: "google/gemini-2.5-flash-image",
      fetch,
      outDir,
    });

  test("decodes the data-URL images on the assistant message", async () => {
    const { fetch, calls } = scriptedFetch(
      json(200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Here you go.",
              images: [
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${PNG_B64}` },
                },
              ],
            },
          },
        ],
      }),
    );

    const images = await Effect.runPromise(
      openrouter(fetch).generate({ prompt: "a red fox", aspect: "square" }),
    );

    expect(fs.readFileSync(images[0]!.path)).toEqual(PNG_BYTES);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer or-key",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: "a red fox" }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "1:1" },
    });
  });

  test("running out of credits (402) is a billing problem", async () => {
    const { fetch } = scriptedFetch(
      json(402, {
        error: {
          code: 402,
          message:
            "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
        },
      }),
    );
    const failure = failureOf(
      await run(openrouter(fetch).generate({ prompt: "x" })),
    );
    expect(failure._tag).toBe("ImageQuotaExhausted");
  });
});
