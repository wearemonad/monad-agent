import { describe, expect, test } from "bun:test";
import { parseImageToolResult } from "../../shared/images";
import { buildGenerateImageTool, type GenerateImage } from "./imageTools";

// The generate_image tool the Claude agent calls. It answers the model in
// text, and carries the image paths in a form the chat (live and replayed)
// reads back.

const call = (generate: GenerateImage, input: Record<string, unknown>) =>
  buildGenerateImageTool(generate).handler(input as any, {});

describe("generate_image", () => {
  test("a generated image comes back as a result the chat can show", async () => {
    const asked: unknown[] = [];
    const generate: GenerateImage = async (req) => {
      asked.push(req);
      return {
        ok: true,
        images: [{ path: "/imgs/b1/image-1.png", name: "image-1.png" }],
        source: "gemini",
        model: "gemini-3.1-flash-image-preview",
      };
    };

    const result = await call(generate, {
      prompt: "a red fox",
      aspect: "landscape",
    });

    expect(asked).toEqual([{ prompt: "a red fox", aspect: "landscape" }]);
    expect(result.isError).toBeFalsy();
    expect(parseImageToolResult(result.content)).toEqual([
      { path: "/imgs/b1/image-1.png", name: "image-1.png" },
    ]);
    const text = result.content.map((c: any) => c.text).join("\n");
    expect(text).toContain("Google Gemini");
  });

  test("a failure is an error result carrying the user-facing message", async () => {
    const generate: GenerateImage = async () => ({
      ok: false,
      message:
        "Your Codex sign-in has expired. Sign in again in Settings → Providers → OpenAI.",
    });

    const result = await call(generate, { prompt: "a red fox" });

    expect(result.isError).toBe(true);
    expect(parseImageToolResult(result.content)).toEqual([]);
    const text = result.content.map((c: any) => c.text).join("\n");
    expect(text).toContain("Your Codex sign-in has expired.");
  });
});
