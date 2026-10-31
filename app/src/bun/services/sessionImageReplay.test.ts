import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { formatImageMarker } from "../../shared/images";
import { SessionStore } from "./SessionStore";
import {
  aiTitleLine,
  withTempClaudeHome,
  writeSession,
} from "./sessionFixtures";

// Reopening a thread replays its transcript. A generate_image call must come
// back as the image it produced, the same as it looked live.

let home: ReturnType<typeof withTempClaudeHome>;
beforeEach(() => {
  home = withTempClaudeHome();
});
afterEach(() => home.restore());

/** Transcript lines chained by parentUuid, as the CLI writes them. */
function transcript(
  sessionId: string,
  cwd: string,
  messages: { role: "user" | "assistant"; content: unknown }[],
) {
  let parent: string | null = null;
  return messages.map(({ role, content }) => {
    const uuid = randomUUID();
    const line = {
      parentUuid: parent,
      isSidechain: false,
      message: { role, content },
      type: role,
      uuid,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId,
    };
    parent = uuid;
    return line;
  });
}

const useImageTool = (id: string) => ({
  role: "assistant" as const,
  content: [
    {
      type: "tool_use",
      id,
      name: "mcp__images__generate_image",
      input: { prompt: "a red fox" },
    },
  ],
});

describe("history replay: generate_image", () => {
  test("a generated image replays as the image", async () => {
    const sid = randomUUID();
    writeSession(home.workspace, sid, [
      ...transcript(sid, home.workspace, [
        { role: "user", content: "Draw a fox" },
        useImageTool("g1"),
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "g1",
              content: [
                { type: "text", text: "Generated 1 image(s) with OpenAI." },
                {
                  type: "text",
                  text: formatImageMarker([
                    { path: "/imgs/b1/image-1.png", name: "image-1.png" },
                  ]),
                },
              ],
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here's your fox." }],
        },
      ]),
      aiTitleLine(sid, "Fox"),
    ]);

    const { items } = await new SessionStore().history(home.workspace, sid);

    expect(items).toEqual([
      { type: "user", text: "Draw a fox" },
      { type: "image", path: "/imgs/b1/image-1.png", name: "image-1.png" },
      { type: "assistant", text: "Here's your fox." },
    ]);
  });

  test("a failed generation replays as a tool row with its message", async () => {
    const sid = randomUUID();
    writeSession(home.workspace, sid, [
      ...transcript(sid, home.workspace, [
        { role: "user", content: "Draw a fox" },
        useImageTool("g2"),
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "g2",
              is_error: true,
              content: [
                {
                  type: "text",
                  text: "Image generation failed. Codex isn't signed in.",
                },
              ],
            },
          ],
        },
      ]),
      aiTitleLine(sid, "Fox"),
    ]);

    const { items } = await new SessionStore().history(home.workspace, sid);

    expect(items[1]).toMatchObject({
      type: "tool",
      toolUseId: "g2",
      isError: true,
      output: "Image generation failed. Codex isn't signed in.",
    });
  });
});
