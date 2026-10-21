import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import type { AgentStreamEvent } from "../../shared/ipc";
import type { AuthStrategy } from "../auth/AuthStrategy";
import { AgentSessions } from "./AgentSession";
import { AgentService } from "./AgentService";
import { fakeLiveSdk } from "./fakeLiveSdk";
import { PermissionBroker } from "./PermissionBroker";
import { withTempClaudeHome } from "./sessionFixtures";

// Interactive (live) sessions driven through AgentService's public API with
// fake CLI processes: prewarm, turns on a warm process, Stop, provider
// switches, eviction, idle expiry, permissions — and exactly one terminal
// event per turn.

const auth = (id: string) =>
  ({
    id,
    validate: () => {},
    sdkOptions: () => ({}),
  }) as unknown as AuthStrategy;
const subscription = auth("subscription-cli");

let home: ReturnType<typeof withTempClaudeHome>;
let events: AgentStreamEvent[];
let sdk: ReturnType<typeof fakeLiveSdk>;
let broker: PermissionBroker;
let agent: AgentService;
let rt: ManagedRuntime.ManagedRuntime<
  AgentSessions | TestClock.TestClock,
  never
>;
let sessions: AgentSessions["Service"];

beforeEach(async () => {
  home = withTempClaudeHome();
  events = [];
  sdk = fakeLiveSdk();
  rt = ManagedRuntime.make(
    AgentSessions.layer.pipe(Layer.provideMerge(TestClock.layer())),
  );
  sessions = await rt.runPromise(Effect.service(AgentSessions));
  broker = new PermissionBroker(() => {});
  agent = new AgentService(
    (e) => events.push(e),
    broker,
    () => subscription,
    () => ({}),
    () => false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { liveQuery: sdk.query, sessions },
  );
});
afterEach(async () => {
  await rt.dispose();
  home.restore();
});

const settle = () => Bun.sleep(5);
/** Time passing on Effect's clock (idle expiry, the settle fallback). */
async function advance(ms: number) {
  await rt.runPromise(TestClock.adjust(ms));
  await settle();
}
const of = (runId: string) =>
  events.filter((e) => "runId" in e && e.runId === runId);
const terminal = (runId: string) =>
  of(runId).filter((e) => e.kind === "run-finished" || e.kind === "run-error");

function send(
  prompt: string,
  runId: string,
  extra: Record<string, unknown> = {},
) {
  return agent.startRun({
    workspaceId: "ws",
    workspacePath: home.workspace,
    prompt,
    runId,
    ...extra,
  });
}

test("prewarm → first turn → warm turn, all on one process", async () => {
  agent.prewarm({ workspaceId: "ws", workspacePath: home.workspace });
  await settle();
  expect(sdk.processes.length).toBe(1);
  const cli = sdk.processes[0]!;
  expect(cli.inputs).toEqual([]);

  send("Hello", "t1");
  await settle();
  cli.init("s1");
  cli.say("Hi there");
  cli.result();
  await settle();
  expect(of("t1").map((e) => e.kind)).toEqual([
    "run-started",
    "text",
    "run-finished",
  ]);

  send("And then?", "t2", { resumeSessionId: "s1" });
  await settle();
  cli.say("Then this");
  cli.result();
  await settle();
  expect(sdk.processes.length).toBe(1);
  expect(cli.inputs).toEqual(["Hello", "And then?"]);
  expect(of("t2").map((e) => e.kind)).toEqual([
    "run-started",
    "text",
    "run-finished",
  ]);
});

test("a provider switch retires the idle process and boots a new one", async () => {
  agent.prewarm({ workspaceId: "ws", workspacePath: home.workspace });
  await settle();
  send("Hello", "t1", { auth: auth("api-key") });
  await settle();
  expect(sdk.processes.length).toBe(2);
  expect(sdk.processes[0]!.inputEnded).toBe(true);
  expect(sdk.processes[1]!.inputs).toEqual(["Hello"]);
});

test("Stop releases the turn at once, swallows its late output, and the process serves the next turn", async () => {
  send("Write a novel", "t1");
  await settle();
  const cli = sdk.processes[0]!;
  cli.onInterrupt = "hang";
  cli.init("s1");
  cli.say("Chapter one");
  await settle();

  expect(agent.abortRun("t1")).toBe(true);
  expect(terminal("t1")).toEqual([
    {
      kind: "run-error",
      runId: "t1",
      error: "Stopped by the user.",
      aborted: true,
    },
  ]);
  expect(cli.interrupts).toBe(1);
  cli.say("Chapter two (late)");
  cli.result({ is_error: true, subtype: "error_during_execution" });
  await settle();
  expect(of("t1").filter((e) => e.kind === "text").length).toBe(1);
  expect(terminal("t1").length).toBe(1);

  send("Shorter please", "t2", { resumeSessionId: "s1" });
  await settle();
  cli.say("A haiku");
  cli.result();
  await settle();
  expect(sdk.processes.length).toBe(1);
  expect(cli.killed).toBe(false);
  expect(terminal("t2")).toEqual([
    expect.objectContaining({ kind: "run-finished", runId: "t2" }),
  ]);
});

test("a process that dies mid-turn ends the turn with one error and no stale deltas", async () => {
  send("Hello", "t1");
  await settle();
  const cli = sdk.processes[0]!;
  cli.init("s1");
  cli.delta("Hal");
  cli.crash();
  await Bun.sleep(80); // past the 60 ms delta flush
  expect(terminal("t1")).toEqual([
    { kind: "run-error", runId: "t1", error: "CLI exited with code 1" },
  ]);
  expect(of("t1").some((e) => e.kind === "text-delta")).toBe(false);

  send("Again", "t2", { resumeSessionId: "s1" });
  await settle();
  expect(sdk.processes.length).toBe(2);
});

test("permission requests belong to their own workspace and run; Stop denies only its own", async () => {
  const requests: { requestId: string; runId: string }[] = [];
  broker = new PermissionBroker((r) => requests.push(r));
  agent = new AgentService(
    (e) => events.push(e),
    broker,
    () => subscription,
    () => ({}),
    () => false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { liveQuery: sdk.query, sessions },
  );
  agent.startRun({
    workspaceId: "acme",
    workspacePath: home.workspace,
    prompt: "a",
    runId: "a1",
  });
  agent.startRun({
    workspaceId: "home",
    workspacePath: `${home.workspace}-2`,
    prompt: "b",
    runId: "b1",
  });
  await settle();
  const [cliA, cliB] = sdk.processes;
  const ask = (cli: typeof cliA) =>
    cli!.options!.canUseTool!("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "x",
    } as never);
  const answerA = ask(cliA);
  const answerB = ask(cliB);
  await settle();
  expect(requests.map((r) => r.runId)).toEqual(["a1", "b1"]);
  expect(broker.workspaceIdOf(requests[0]!.requestId)).toBe("acme");
  expect(broker.workspaceIdOf(requests[1]!.requestId)).toBe("home");

  agent.abortRun("a1");
  expect(await answerA).toMatchObject({ behavior: "deny" });
  expect(broker.workspaceIdOf(requests[1]!.requestId)).toBe("home");
  broker.respond(requests[1]!.requestId, true);
  expect(await answerB).toMatchObject({ behavior: "allow" });
});

test("a fourth warm process evicts the oldest idle one, never a busy one", async () => {
  send("busy", "t1");
  await settle();
  for (const thread of ["s2", "s3"]) {
    agent.prewarm({
      workspaceId: "ws",
      workspacePath: home.workspace,
      resumeSessionId: thread,
    });
    await settle();
  }
  agent.prewarm({
    workspaceId: "ws",
    workspacePath: home.workspace,
    resumeSessionId: "s4",
  });
  await settle();
  const [busy, oldestIdle, newerIdle, fresh] = sdk.processes;
  expect(busy!.inputEnded).toBe(false);
  expect(oldestIdle!.inputEnded).toBe(true);
  expect(newerIdle!.inputEnded).toBe(false);
  expect(fresh).toBeDefined();
});

test("an idle process closes itself after 10 minutes, and is killed if it lingers", async () => {
  send("Hello", "t1");
  await settle();
  const cli = sdk.processes[0]!;
  cli.lingers = true;
  cli.init("s1");
  cli.result();
  await settle();

  await advance(10 * 60_000 - 1);
  expect(cli.inputEnded).toBe(false);
  await advance(1);
  expect(cli.inputEnded).toBe(true);
  expect(cli.killed).toBe(false);
  await advance(5_000);
  expect(cli.killed).toBe(true);

  send("Back again", "t2", { resumeSessionId: "s1" });
  await settle();
  expect(sdk.processes.length).toBe(2);
});

test("a new turn before the idle deadline keeps the process", async () => {
  send("Hello", "t1");
  await settle();
  const cli = sdk.processes[0]!;
  cli.init("s1");
  cli.result();
  await settle();
  await advance(9 * 60_000);
  send("Still here", "t2", { resumeSessionId: "s1" });
  await settle();
  await advance(2 * 60_000);
  expect(cli.inputEnded).toBe(false);
  cli.result();
  await settle();
  await advance(10 * 60_000);
  expect(cli.inputEnded).toBe(true);
});

test("a Stop the CLI never acknowledges falls back to retiring the process", async () => {
  send("Write a novel", "t1");
  await settle();
  const cli = sdk.processes[0]!;
  cli.onInterrupt = "hang";
  cli.lingers = true;
  cli.init("s1");
  await settle();
  agent.abortRun("t1");
  await advance(4_999);
  expect(cli.inputEnded).toBe(false);
  await advance(1);
  expect(cli.inputEnded).toBe(true);
  await advance(5_000);
  expect(cli.killed).toBe(true);
  expect(terminal("t1").length).toBe(1);

  send("Shorter please", "t2", { resumeSessionId: "s1" });
  await settle();
  expect(sdk.processes.length).toBe(2);
});

test("quitting kills every live process", async () => {
  agent.prewarm({ workspaceId: "ws", workspacePath: home.workspace });
  send("Hello", "t1", { resumeSessionId: "other" });
  await settle();
  expect(sdk.processes.length).toBe(2);
  await rt.dispose();
  await settle();
  expect(sdk.processes.map((p) => p.killed)).toEqual([true, true]);
});

test("a process that exits cleanly mid-turn still ends the turn, once", async () => {
  send("Hello", "t1");
  await settle();
  const cli = sdk.processes[0]!;
  cli.init("s1");
  cli.say("Hal");
  cli.exit();
  await settle();
  expect(terminal("t1")).toEqual([
    {
      kind: "run-error",
      runId: "t1",
      error: "The run ended without a result.",
    },
  ]);
});

test("a model or effort change between turns is applied in place on the warm process", async () => {
  send("Hello", "t1");
  await settle();
  const cli = sdk.processes[0]!;
  cli.init("s1");
  cli.result();
  await settle();
  send("Think harder", "t2", {
    resumeSessionId: "s1",
    model: "opus",
    runOptions: { effort: "max" },
  });
  await settle();
  expect(sdk.processes.length).toBe(1);
  expect(cli.models).toEqual(["opus"]);
  expect(cli.flags).toEqual([expect.objectContaining({ effortLevel: "max" })]);
  expect(cli.inputs).toEqual(["Hello", "Think harder"]);
});
