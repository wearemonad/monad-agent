import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentStreamEvent } from "../../shared/ipc";
import { AgentService } from "./AgentService";

// Drives AgentService.normalize with synthetic stream_event messages (the
// includePartialMessages shapes) and checks the delta → coalesced-event path.

let events: AgentStreamEvent[];
let agent: AgentService;

const normalize = (msg: unknown) =>
  (agent as any).normalize("run1", "sess1", msg, "/tmp");
const delta = (d: Record<string, unknown>, parent: string | null = null) => ({
  type: "stream_event",
  parent_tool_use_id: parent,
  event: { type: "content_block_delta", index: 0, delta: d },
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

describe("stream deltas", () => {
  // Coalescing is the StreamMultiplexer's job (one batch per tick for every
  // run); AgentService forwards each delta as it comes, in order.
  test("deltas go straight out, in order", () => {
    normalize(delta({ type: "thinking_delta", thinking: "hmm " }));
    normalize(delta({ type: "text_delta", text: "Hel" }));
    normalize(delta({ type: "text_delta", text: "lo" }));
    expect(events).toEqual([
      { kind: "thinking-delta", runId: "run1", text: "hmm " },
      { kind: "text-delta", runId: "run1", text: "Hel" },
      { kind: "text-delta", runId: "run1", text: "lo" },
    ]);
  });

  test("the complete assistant message follows its deltas", () => {
    normalize(delta({ type: "text_delta", text: "partial" }));
    normalize({
      type: "assistant",
      message: { content: [{ type: "text", text: "partial + the rest" }] },
    });
    expect(events).toEqual([
      { kind: "text-delta", runId: "run1", text: "partial" },
      { kind: "text", runId: "run1", text: "partial + the rest" },
    ]);
  });

  test("subagent deltas (parent_tool_use_id) are ignored", async () => {
    normalize(
      delta({ type: "text_delta", text: "subagent noise" }, "toolu_123"),
    );
    expect(events).toHaveLength(0);
  });
});

describe("login-needed flag", () => {
  const authFailure = (runId: string) =>
    (agent as any).normalize(
      runId,
      "sess1",
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result:
          "Failed to authenticate: OAuth session expired and could not be refreshed",
        session_id: "sess1",
        num_turns: 1,
      },
      "/tmp",
    );

  test("subscription-CLI runs flag the CLI's expired login", () => {
    (agent as any).runAuth.set("run1", "subscription-cli");
    authFailure("run1");
    const done = events.find((e) => e.kind === "run-finished");
    expect(done).toMatchObject({
      kind: "run-finished",
      error: expect.stringContaining("OAuth session expired"),
      needsLogin: true,
    });
  });

  test("the same text from an API-key run is an ordinary error", () => {
    (agent as any).runAuth.set("run2", "api-key");
    authFailure("run2");
    const done = events.find((e) => e.kind === "run-finished") as any;
    expect(done.error).toContain("OAuth session expired");
    expect(done.needsLogin).toBeUndefined();
  });

  test("a real answer carries neither error nor flag", () => {
    (agent as any).runAuth.set("run3", "subscription-cli");
    (agent as any).normalize(
      "run3",
      "sess1",
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "All good.",
        session_id: "sess1",
        num_turns: 1,
      },
      "/tmp",
    );
    const done = events.find((e) => e.kind === "run-finished") as any;
    expect(done.error).toBeUndefined();
    expect(done.needsLogin).toBeUndefined();
  });
});
