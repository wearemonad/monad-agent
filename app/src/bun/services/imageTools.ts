import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  formatImageMarker,
  type GeneratedImage,
  IMAGE_SOURCE_LABELS,
  IMAGES_SERVER,
  type ImageRequest,
  type ImageSource,
} from "../../shared/images";

/** What the tool needs from the backend: one image request, settled into
 *  images or the sentence the user should read. */
export type GenerateImage = (
  req: ImageRequest,
) => Promise<
  | { ok: true; images: GeneratedImage[]; source: ImageSource; model?: string }
  | { ok: false; message: string }
>;

/** In-process MCP server giving the agent image generation — whichever model
 *  Settings → Image models routes to (Codex's gpt-image by default). */
export function buildImageToolsServer(generate: GenerateImage) {
  return createSdkMcpServer({
    name: IMAGES_SERVER,
    version: "1.0.0",
    instructions:
      "Generates images and shows them in the chat. Use generate_image whenever the user asks you to create, draw, design or render a picture, illustration, logo, mockup or photo. You can't see the result, so don't describe it in detail.",
    tools: [buildGenerateImageTool(generate)],
  });
}

/** Exported separately so tests can drive the handler. */
export function buildGenerateImageTool(generate: GenerateImage) {
  return tool(
    "generate_image",
    "Generate one image from a text prompt and show it to the user in the chat. Write a complete, specific prompt: subject, style, composition, lighting, any text to render (quoted exactly). Takes 10–60 seconds.",
    {
      prompt: z.string().min(1).describe("Full description of the image"),
      aspect: z
        .enum(["square", "portrait", "landscape"])
        .optional()
        .describe("Shape of the image (default square)"),
    },
    async ({ prompt, aspect }) => {
      const result = await generate({ prompt, ...(aspect ? { aspect } : {}) });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Image generation failed. Tell the user exactly this, in your own reply: ${result.message}`,
            },
          ],
          isError: true,
        };
      }
      const by = `${IMAGE_SOURCE_LABELS[result.source]}${result.model ? ` (${result.model})` : ""}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `Generated ${result.images.length} image(s) with ${by}. They are already shown in the chat — don't repeat file paths; one short sentence is enough.`,
          },
          { type: "text" as const, text: formatImageMarker(result.images) },
        ],
      };
    },
  );
}
