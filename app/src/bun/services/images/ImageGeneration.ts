import { Context, Effect, Layer } from "effect";
import {
  DEFAULT_IMAGE_MODELS,
  IMAGE_PROVIDER_IDS,
  type GeneratedImage,
  type ImageProviderId,
  type ImageRequest,
  type ImageSource,
} from "../../../shared/images";
import type { ImageProvider } from "./httpProviders";
import type { ImageFailure } from "./ImageFailure";

/** What Settings → Image models holds. Keys come from the Keychain. */
export type ImageSettings = {
  /** The user's pick among the providers that have a key. */
  defaultProvider?: ImageProviderId;
  keys: Partial<Record<ImageProviderId, string | null>>;
  /** Per-provider model override; DEFAULT_IMAGE_MODELS otherwise. */
  models: Partial<Record<ImageProviderId, string>>;
};

export type ImageResult = {
  images: GeneratedImage[];
  source: ImageSource;
  /** The model that made them (absent for Codex, which picks its own). */
  model?: string;
};

/** Which provider answers, per the settings: the chosen default if it still
 *  has a key, else the first provider with one, else Codex. */
export function chooseImageSource(
  s: ImageSettings,
): { id: ImageProviderId; apiKey: string; model: string } | "codex" {
  const keyed = IMAGE_PROVIDER_IDS.filter((id) => !!s.keys[id]);
  const id =
    s.defaultProvider && keyed.includes(s.defaultProvider)
      ? s.defaultProvider
      : keyed[0];
  if (!id) return "codex";
  return {
    id,
    apiKey: s.keys[id]!,
    model: s.models[id] || DEFAULT_IMAGE_MODELS[id],
  };
}

/** Owner of image generation: reads the settings on every request, so a key
 *  added or removed in Settings applies to the very next image. */
export class ImageGeneration extends Context.Service<
  ImageGeneration,
  {
    readonly generate: (
      req: ImageRequest,
    ) => Effect.Effect<ImageResult, ImageFailure>;
  }
>()("monad/ImageGeneration") {
  static layer(deps: {
    settings: () => ImageSettings;
    makeProvider: (
      id: ImageProviderId,
      opts: { apiKey: string; model: string },
    ) => ImageProvider;
    codex: ImageProvider;
  }) {
    return Layer.succeed(ImageGeneration, {
      generate: (req) =>
        Effect.gen(function* () {
          const choice = chooseImageSource(deps.settings());
          if (choice === "codex") {
            const images = yield* deps.codex.generate(req);
            return { images, source: "codex" as const };
          }
          const provider = deps.makeProvider(choice.id, choice);
          const images = yield* provider.generate(req);
          return { images, source: choice.id, model: choice.model };
        }).pipe(Effect.withSpan("ImageGeneration.generate")),
    });
  }
}
