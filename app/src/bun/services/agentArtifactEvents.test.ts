import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentStreamEvent } from "../../shared/ipc";
import { AgentService } from "./AgentService";
import { buildArtifactTools } from "./artifactTools";

// Drives AgentService.normalize (the SDK-message → stream-event translator)
// with synthetic assistant/user messages, the same shapes the SDK emits.
let ws: string;
let events: AgentStreamEvent[];
let agent: AgentService;

const normalize = (msg: unknown) =>
  (agent as any).normalize("run1", "sess1", msg, ws);

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, isError = false) => ({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: "ok",
        is_error: isError,
      },
    ],
  },
});

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-agent-artifacts-"));
  events = [];
  agent = new AgentService(
    (e) => events.push(e),
    {} as any,
    () => ({}) as any,
    () => ({}),
    () => true,
  );
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("normalize: artifact tool calls", () => {
  test("successful create emits one artifact event instead of the tool pair", async () => {
    // The tool actually runs between tool_use and tool_result — simulate that.
    normalize(
      toolUse("t1", "mcp__artifacts__artifact_create", {
        id: "dash",
        type: "html",
        title: "Dash",
        content: "<p>v1</p>",
      }),
    );
    expect(events).toEqual([]); // held back until the result confirms success
    await buildArtifactTools(ws)
      .find((t) => t.name === "artifact_create")!
      .handler(
        {
          id: "dash",
          type: "html",
          title: "Dash",
          content: "<p>v1</p>",
        } as any,
        {},
      );
    normalize(toolResult("t1"));
    expect(events).toEqual([
      {
        kind: "artifact",
        runId: "run1",
        artifactId: "dash",
        artifactType: "html",
        title: "Dash",
        op: "create",
        content: "<p>v1</p>",
      },
    ]);
  });

  test("failed artifact call falls back to a visible tool-call + error result", () => {
    normalize(
      toolUse("t2", "mcp__artifacts__artifact_update", {
        id: "ghost",
        old_str: "a",
        new_str: "b",
      }),
    );
    normalize(toolResult("t2", true));
    expect(events.map((e) => e.kind)).toEqual(["tool-call", "tool-result"]);
    expect(events[1]).toMatchObject({ toolUseId: "t2", isError: true });
  });

  test("non-artifact tools still emit the generic pair", () => {
    normalize(toolUse("t3", "Read", { file_path: "/x" }));
    normalize(toolResult("t3"));
    expect(events.map((e) => e.kind)).toEqual(["tool-call", "tool-result"]);
  });
});

describe("normalize: draft_email tool calls", () => {
  const input = {
    to: "darrel@example.com",
    subject: "Quote",
    variants: [{ label: "Brief", body: "Hi." }],
  };

  test("successful draft_email emits one email-draft event", () => {
    normalize(toolUse("e1", "mcp__email__draft_email", input));
    expect(events).toEqual([]);
    normalize(toolResult("e1"));
    expect(events).toEqual([
      {
        kind: "email-draft",
        runId: "run1",
        draft: {
          to: "darrel@example.com",
          cc: undefined,
          subject: "Quote",
          variants: input.variants,
        },
      },
    ]);
  });

  test("errored draft_email falls back to the visible tool pair", () => {
    normalize(toolUse("e2", "mcp__email__draft_email", input));
    normalize(toolResult("e2", true));
    expect(events.map((e) => e.kind)).toEqual(["tool-call", "tool-result"]);
  });

  test("unparseable input renders as a generic tool call", () => {
    normalize(
      toolUse("e3", "mcp__email__draft_email", {
        to: "",
        subject: "",
        variants: [],
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["tool-call"]);
  });
});
