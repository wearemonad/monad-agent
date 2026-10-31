// Image generation, shared by the bun tool server, settings, the stream
// normalizer, session replay and the webview.

/** Image models a user can connect with their own API key (Settings → Image
 *  models). With none connected, Monad generates through the local Codex CLI
 *  (gpt-image on the user's ChatGPT plan). */
export const IMAGE_PROVIDER_IDS = [
  "openai",
  "gemini",
  "fal",
  "openrouter",
] as const;
export type ImageProviderId = (typeof IMAGE_PROVIDER_IDS)[number];

/** Who actually made an image: an API-key provider, or Codex. */
export type ImageSource = ImageProviderId | "codex";

export type ImageAspect = "square" | "portrait" | "landscape";

export type ImageRequest = { prompt: string; aspect?: ImageAspect };

/** An image on disk, as the chat shows it. */
export type GeneratedImage = { path: string; name: string };

/** How each image source is named in Settings and in messages. */
export const IMAGE_SOURCE_LABELS: Record<ImageSource, string> = {
  openai: "OpenAI",
  gemini: "Google Gemini",
  fal: "fal.ai",
  openrouter: "OpenRouter",
  codex: "Codex",
};

/** Model used for each provider until the user picks another in Settings. */
export const DEFAULT_IMAGE_MODELS: Record<ImageProviderId, string> = {
  openai: "gpt-image-2",
  gemini: "gemini-3.1-flash-image-preview",
  fal: "fal-ai/flux/schnell",
  openrouter: "google/gemini-2.5-flash-image",
};

/** MCP server name — the tool surfaces as mcp__images__generate_image. */
export const IMAGES_SERVER = "images";
export const GENERATE_IMAGE_TOOL = `mcp__${IMAGES_SERVER}__generate_image`;
/** Auto-approved: it only makes a picture; nothing leaves the machine but
 *  the prompt, to the image model the user configured. */
export const IMAGES_ALLOW_RULE = `mcp__${IMAGES_SERVER}__*`;

const IMAGES_TAG = /<monad-images>([\s\S]*?)<\/monad-images>/;

/** The tool-result line that carries the image paths to the chat. */
export function formatImageMarker(images: GeneratedImage[]): string {
  return `<monad-images>${JSON.stringify(images)}</monad-images>`;
}

/** The images a generate_image result carries — from the live stream or a
 *  replayed transcript (string or text-block content). [] when none. */
export function parseImageToolResult(content: unknown): GeneratedImage[] {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              c &&
              typeof c === "object" &&
              "text" in c &&
              typeof c.text === "string"
                ? c.text
                : "",
            )
            .join("\n")
        : "";
  const m = IMAGES_TAG.exec(text);
  if (!m) return [];
  try {
    const parsed: unknown = JSON.parse(m[1]!);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is GeneratedImage =>
        !!i &&
        typeof i === "object" &&
        typeof (i as GeneratedImage).path === "string" &&
        typeof (i as GeneratedImage).name === "string",
    );
  } catch {
    return [];
  }
}
