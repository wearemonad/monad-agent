import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ImageProviderId, ImageSource } from "../../../shared/images";
import type { ImageProvider } from "./httpProviders";
import { ImageGeneration, type ImageSettings } from "./ImageGeneration";

// Which image model answers a request, given what's set in Settings → Image
// models. Providers are fakes that record they were asked.

function harness(settings: ImageSettings) {
  const asked: { source: ImageSource; apiKey?: string; model?: string }[] = [];
  const fake = (
    source: ImageSource,
    apiKey?: string,
    model?: string,
  ): ImageProvider => ({
    id: source,
    generate: () =>
      Effect.sync(() => {
        asked.push({ source, apiKey, model });
        return [{ path: `/img/${source}.png`, name: `${source}.png` }];
      }),
  });
  const layer = ImageGeneration.layer({
    settings: () => settings,
    makeProvider: (id: ImageProviderId, o) => fake(id, o.apiKey, o.model),
    codex: fake("codex"),
  });
  const generate = (prompt = "a fox") =>
    Effect.runPromise(
      Effect.gen(function* () {
        const images = yield* ImageGeneration;
        return yield* images.generate({ prompt });
      }).pipe(Effect.provide(layer)),
    );
  return { generate, asked };
}

describe("ImageGeneration routing", () => {
  test("with no image API key, it generates through Codex", async () => {
    const { generate, asked } = harness({ keys: {}, models: {} });
    const result = await generate();
    expect(result.source).toBe("codex");
    expect(asked).toEqual([
      { source: "codex", apiKey: undefined, model: undefined },
    ]);
  });

  test("with one key set, that provider is used, with its default model", async () => {
    const { generate, asked } = harness({
      keys: { gemini: "g-key" },
      models: {},
    });
    const result = await generate();
    expect(result.source).toBe("gemini");
    expect(asked).toEqual([
      {
        source: "gemini",
        apiKey: "g-key",
        model: "gemini-3.1-flash-image-preview",
      },
    ]);
  });

  test("with several keys, the user's chosen default answers", async () => {
    const { generate } = harness({
      defaultProvider: "openrouter",
      keys: { openai: "sk", gemini: "g", openrouter: "or" },
      models: {},
    });
    expect((await generate()).source).toBe("openrouter");
  });

  test("a default whose key was removed falls back to a provider that has one", async () => {
    const { generate } = harness({
      defaultProvider: "fal",
      keys: { fal: null, gemini: "g" },
      models: {},
    });
    expect((await generate()).source).toBe("gemini");
  });

  test("the model picked in Settings overrides the provider's default", async () => {
    const { generate, asked } = harness({
      keys: { fal: "f" },
      models: { fal: "fal-ai/recraft/v3/text-to-image" },
    });
    const result = await generate();
    expect(asked[0]!.model).toBe("fal-ai/recraft/v3/text-to-image");
    expect(result.model).toBe("fal-ai/recraft/v3/text-to-image");
  });
});
