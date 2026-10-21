import { describe, expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { PermissionBroker, redactSecrets, summarize } from "./PermissionBroker";
import type { PermissionRequest } from "../../shared/ipc";

/** Drive the broker by capturing the request it pushes to the UI, then answer
 *  it out of band — mirroring the RPC round-trip. */
function harness() {
  const pushed: PermissionRequest[] = [];
  const broker = new PermissionBroker((req) => pushed.push(req));
  return { broker, pushed, last: () => pushed[pushed.length - 1] };
}

describe("PermissionBroker workspace attribution (H1)", () => {
  test("a pending request remembers the run's OWN workspace, not the active one", async () => {
    const { broker, last } = harness();
    const p = broker.ask("run-1", "Bash", { command: "ls" }, "ws-acme");
    const req = last();
    // The user switches to another workspace and clicks "always allow": the
    // grant must key off the request's captured workspace, not "ws-personal".
    expect(broker.workspaceIdOf(req.requestId)).toBe("ws-acme");
    expect(broker.toolNameOf(req.requestId)).toBe("Bash");
    broker.respond(req.requestId, true);
    expect(await p).toBe(true);
    // once settled, the record is gone
    expect(broker.workspaceIdOf(req.requestId)).toBeUndefined();
  });
});

describe("PermissionBroker settling", () => {
  test("respond resolves the awaiting promise", async () => {
    const { broker, last } = harness();
    const p = broker.ask("r", "Read", {}, "ws");
    broker.respond(last().requestId, false);
    expect(await p).toBe(false);
  });

  test("denyAllForRun settles every outstanding request for a dead run as denied", async () => {
    const { broker, pushed } = harness();
    const a = broker.ask("run-1", "Bash", { command: "ls" }, "ws");
    const b = broker.ask("run-1", "Write", { file_path: "x" }, "ws");
    const other = broker.ask("run-2", "Read", {}, "ws");
    broker.denyAllForRun("run-1");
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    // unrelated run untouched
    expect(broker.workspaceIdOf(pushed[2].requestId)).toBe("ws");
    broker.respond(pushed[2].requestId, true);
    expect(await other).toBe(true);
  });

  test("responding to an unknown request id is a no-op", () => {
    const { broker } = harness();
    expect(broker.respond("nope", true)).toBe(false);
  });
});

// runtime#11: summaries reach permission cards AND the workspace's shareable
// activity log — raw input values (which may be credentials) must never leak.
describe("summarize redaction", () => {
  test("unknown-shaped inputs are summarized by key names, not values", () => {
    const s = summarize("mcp__x__store_secret", {
      token: "sk-ant-abc123def456ghi789",
      note: "x",
    });
    expect(s).not.toContain("abc123def456ghi789");
    expect(s).toContain("token");
  });

  test("credential shapes embedded in known keys are masked", () => {
    const s = summarize("Bash", {
      command:
        "curl -H 'Authorization: Bearer sk-ant-api03-verysecretkey1234' https://api",
    });
    expect(s).not.toContain("verysecretkey1234");
    expect(s).toContain("redacted");
  });

  test("redactSecrets masks common token shapes but keeps ordinary text", () => {
    expect(redactSecrets("run sk-ant-api03-AAAABBBBCCCC now")).not.toContain(
      "AAAABBBBCCCC",
    );
    expect(
      redactSecrets("push ghp_ABCDEFGHIJKLMNOP1234 to repo"),
    ).not.toContain("ABCDEFGHIJKLMNOP");
    expect(redactSecrets("ls inbox/ && cat notes.md")).toBe(
      "ls inbox/ && cat notes.md",
    );
  });
});

describe("PermissionBroker timeout", () => {
  test("an unanswered request is denied after five minutes, and forgotten", async () => {
    const rt = ManagedRuntime.make(TestClock.layer());
    const pushed: PermissionRequest[] = [];
    const broker = new PermissionBroker((req) => pushed.push(req), {
      run: (effect) => rt.runPromise(effect),
    });
    let answer: boolean | undefined;
    void broker.ask("run-1", "Bash", { command: "ls" }, "ws").then((a) => {
      answer = a;
    });
    await Bun.sleep(1);
    await rt.runPromise(TestClock.adjust(5 * 60_000 - 1));
    await Bun.sleep(1);
    expect(answer).toBeUndefined();
    await rt.runPromise(TestClock.adjust(1));
    await Bun.sleep(1);
    expect(answer).toBe(false);
    expect(broker.workspaceIdOf(pushed[0]!.requestId)).toBeUndefined();
    expect(broker.respond(pushed[0]!.requestId, true)).toBe(false);
    await rt.dispose();
  });
});
