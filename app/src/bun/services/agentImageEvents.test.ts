import { beforeEach, describe, expect, test } from "bun:test";
import { formatImageMarker } from "../../shared/images";
import type { AgentStreamEvent } from "../../shared/ipc";
import { AgentService } from "./AgentService";

// Drives AgentService.normalize with the SDK message shapes a generate_image
// call produces: the tool_use, then its tool_result one message later.

let events: AgentStreamEvent[];
let agent: AgentService;

const normalize = (msg: unknown) =>
  (agent as any).normalize("run1", "sess1", msg, "/tmp");

const toolUse = (id: string, input: unknown) => ({
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id, name: "mcp__images__generate_image", input },
    ],
  },
});
const toolResult = (id: string, content: unknown, isError = false) => ({
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, content, is_error: isError },
    ],
  },
});

beforeEach(() => {
  events = [];
  agent = new AgentService(
    (e) => events.push(e),
    {} as any,
    () => ({}) as any,
    () => ({}),
    () => true,
  );
});

describe("normalize: generate_image", () => {
  test("a generated image is shown in the chat, not as a tool row", () => {
    normalize(toolUse("g1", { prompt: "a fox" }));
    expect(events).toEqual([]);
    normalize(
      toolResult("g1", [
        { type: "text", text: "Generated 1 image(s) with OpenAI." },
        {
          type: "text",
          text: formatImageMarker([
            { path: "/imgs/b1/image-1.png", name: "image-1.png" },
          ]),
        },
      ]),
    );
    expect(events).toEqual([
      {
        kind: "image",
        runId: "run1",
        path: "/imgs/b1/image-1.png",
        name: "image-1.png",
      },
    ]);
  });

  test("a failed generation stays visible as a tool call with its message", () => {
    normalize(toolUse("g2", { prompt: "a fox" }));
    normalize(
      toolResult(
        "g2",
        [
          {
            type: "text",
            text: "Image generation failed. … sign-in has expired.",
          },
        ],
        true,
      ),
    );
    expect(events.map((e) => e.kind)).toEqual(["tool-call", "tool-result"]);
    const result = events[1] as Extract<
      AgentStreamEvent,
      { kind: "tool-result" }
    >;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("sign-in has expired");
  });
});
