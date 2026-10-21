import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import type { AgentStreamEvent } from "../../shared/ipc";
import type { AuthStrategy } from "../auth/AuthStrategy";
import { AgentService, BACKGROUND_STALL_MS, STALL_ERROR } from "./AgentService";
import { BackgroundRuns } from "./BackgroundRuns";
import { fakeStream } from "./fakeSdkStream";
import { withTempClaudeHome } from "./sessionFixtures";
import type { QueryFactory } from "./sdkQuery";

// One-shot background runs (ingest, scheduled jobs, memory review) driven
// through AgentService's public API with a fake SDK query: whatever the
// stream does, the run's owner hears exactly one terminal event.

const fakeAuth = {
  id: "api-key",
  validate: () => {},
  sdkOptions: () => ({}),
} as unknown as AuthStrategy;

let home: ReturnType<typeof withTempClaudeHome>;
let rt: ManagedRuntime.ManagedRuntime<
  BackgroundRuns | TestClock.TestClock,
  never
>;
let events: AgentStreamEvent[];
let streams: ReturnType<typeof fakeStream<SDKMessage>>[];
let agent: AgentService;
let wall: number;
/** Runs inside the event callback, like the app's routeAgentEvent. */
let onEvent: ((e: AgentStreamEvent) => void) | undefined;

beforeEach(async () => {
  home = withTempClaudeHome();
  events = [];
  streams = [];
  onEvent = undefined;
  wall = 1_000_000;
  rt = ManagedRuntime.make(
    BackgroundRuns.layerWith({ now: () => wall }).pipe(
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  const backgroundRuns = await rt.runPromise(Effect.service(BackgroundRuns));
  const query: QueryFactory = ({ options }) => {
    const stream = fakeStream<SDKMessage>();
    streams.push(stream);
    return stream.open(options?.abortController?.signal as AbortSignal);
  };
  agent = new AgentService(
    (e) => {
      events.push(e);
      onEvent?.(e);
    },
    { denyAllForRun: () => {} } as never,
    () => fakeAuth,
    () => ({}),
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { query, backgroundRuns },
  );
});
afterEach(async () => {
  await rt.dispose();
  home.restore();
});

const settle = () => Bun.sleep(5);
/** Awake time passing: wall clock and Effect's clock together. */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 60_000) {
    const step = Math.min(60_000, left);
    wall += step;
    await rt.runPromise(TestClock.adjust(step));
  }
  await settle();
}
const terminal = () =>
  events.filter((e) => e.kind === "run-finished" || e.kind === "run-error");

function startBackground(runId = "r1") {
  return agent.startRun({
    workspaceId: "ws",
    workspacePath: home.workspace,
    prompt: "Run the morning briefing",
    runId,
    background: true,
    hiddenSession: true,
  });
}

const init = {
  type: "system",
  subtype: "init",
  session_id: "s1",
  model: "claude-sonnet-5-5",
} as unknown as SDKMessage;
const result = (extra: Record<string, unknown> = {}) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    session_id: "s1",
    num_turns: 3,
    ...extra,
  }) as unknown as SDKMessage;

describe("one-shot background runs", () => {
  test("a run that reaches its result finishes exactly once", async () => {
    startBackground();
    streams[0].push(init);
    streams[0].push(result());
    streams[0].end();
    await settle();
    expect(events[0]).toMatchObject({
      kind: "run-started",
      runId: "r1",
      sessionId: "s1",
    });
    expect(terminal()).toEqual([
      expect.objectContaining({
        kind: "run-finished",
        runId: "r1",
        numTurns: 3,
      }),
    ]);
  });

  test("an errored result finishes once, carrying the error", async () => {
    startBackground();
    streams[0].push(init);
    streams[0].push(
      result({
        is_error: true,
        subtype: "error_during_execution",
        result: "API overloaded",
      }),
    );
    streams[0].end();
    await settle();
    expect(terminal()).toEqual([
      expect.objectContaining({
        kind: "run-finished",
        error: expect.any(String),
      }),
    ]);
  });

  test("a stream that ends without a result fails once", async () => {
    startBackground();
    streams[0].push(init);
    streams[0].end();
    await settle();
    expect(terminal()).toEqual([
      {
        kind: "run-error",
        runId: "r1",
        error: "The run ended without a result.",
      },
    ]);
  });

  test("a stream that throws fails once, with the friendly message", async () => {
    startBackground();
    streams[0].fail(new Error("spawn claude ENOENT"));
    await settle();
    expect(terminal()).toEqual([
      {
        kind: "run-error",
        runId: "r1",
        error: expect.stringContaining("Hint: check the Claude CLI install"),
      },
    ]);
  });

  test("a hung run times out after 20 silent minutes as a retryable stall", async () => {
    startBackground();
    streams[0].push(init);
    await settle();
    await advance(BACKGROUND_STALL_MS);
    expect(terminal()).toEqual([]);
    await advance(60_000);
    expect(terminal()).toEqual([
      { kind: "run-error", runId: "r1", error: STALL_ERROR },
    ]);
    expect(streams[0].aborted).toBe(true);
  });

  test("the user's Stop is reported once, as a stop", async () => {
    startBackground();
    streams[0].push(init);
    await settle();
    expect(agent.abortRun("r1")).toBe(true);
    await settle();
    expect(streams[0].aborted).toBe(true);
    expect(terminal()).toEqual([
      {
        kind: "run-error",
        runId: "r1",
        error: "Stopped by the user.",
        aborted: true,
      },
    ]);
  });

  test("a second background run in the same workspace is refused", async () => {
    startBackground("r1");
    expect(() => startBackground("r2")).toThrow(
      "A background run is already active in this workspace.",
    );
  });

  test("the owner can start the next run from the finished event", async () => {
    // Ingest chains files that arrived mid-run from its run-finished handler.
    let chained: string | Error | undefined;
    onEvent = (e) => {
      if (e.kind === "run-finished" && e.runId === "r1") {
        try {
          chained = startBackground("r2");
        } catch (err) {
          chained = err as Error;
        }
      }
    };
    startBackground("r1");
    streams[0].push(init);
    streams[0].push(result());
    streams[0].end();
    await settle();
    expect(chained).toBe("r2");
  });

  test("quitting the app aborts the run without reporting a stop or failure", async () => {
    startBackground();
    streams[0].push(init);
    await settle();
    await rt.dispose();
    await settle();
    expect(streams[0].aborted).toBe(true);
    expect(terminal()).toEqual([]);
  });
});
