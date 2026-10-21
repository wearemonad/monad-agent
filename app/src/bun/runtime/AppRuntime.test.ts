import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { installAppLog } from "../services/AppLog";
import { createQuitGuard, makeAppRuntime } from "./AppRuntime";
import { BackgroundRuns } from "../services/BackgroundRuns";
import { backgroundLoops } from "./BackgroundLoops";

let dir: string;
let logFile: string;
let uninstall: () => void;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-runtime-"));
  logFile = path.join(dir, "monad.log");
  uninstall = installAppLog(logFile);
});
afterEach(() => {
  uninstall();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** monad.log lines minus the leading ISO timestamp. */
const logLines = () =>
  fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => l.replace(/^\S+ /, ""));

describe("makeAppRuntime", () => {
  test("Effect logs land in monad.log in the existing [level] [tag] format", async () => {
    const rt = makeAppRuntime(Layer.empty);
    await rt.runPromise(Effect.logWarning("[scheduler] tick took 61s"));
    await rt.dispose();
    expect(logLines()).toEqual(["[warn] [scheduler] tick took 61s"]);
  });

  test("log annotations are appended as key=value", async () => {
    const rt = makeAppRuntime(Layer.empty);
    await rt.runPromise(
      Effect.logInfo("[runs] finished").pipe(
        Effect.annotateLogs({ workspaceId: "ws-1", runId: "r-9" }),
      ),
    );
    await rt.dispose();
    expect(logLines()).toEqual([
      "[info] [runs] finished workspaceId=ws-1 runId=r-9",
    ]);
  });

  test("background loops log through the app logger and stop on dispose", async () => {
    let runs = 0;
    const rt = makeAppRuntime(
      backgroundLoops([
        {
          name: "watch-folders",
          firstDelay: 0,
          every: 5,
          run: () => {
            runs++;
            if (runs === 1) throw new Error("disk unplugged");
          },
        },
      ]),
    );
    await rt.runPromise(Effect.void); // build the layer: loops start
    await Bun.sleep(30);
    await rt.dispose();
    const afterDispose = runs;
    await Bun.sleep(30);
    expect(runs).toBe(afterDispose);
    expect(runs).toBeGreaterThan(1);
    expect(logLines()).toEqual([
      "[error] [watch-folders] run failed: disk unplugged",
    ]);
  });
});

describe("the app's runtime at startup", () => {
  test("hands out BackgroundRuns synchronously and starts the loops", async () => {
    let loopRuns = 0;
    const rt = makeAppRuntime(
      Layer.mergeAll(
        BackgroundRuns.layer,
        backgroundLoops([
          { name: "tick", firstDelay: 0, every: 5, run: () => void loopRuns++ },
        ]),
      ),
    );
    // index.ts does this while constructing AgentService — no await there.
    const runs = rt.runSync(Effect.service(BackgroundRuns));
    expect(runs.isBusy("/ws")).toBe(false);
    await Bun.sleep(20);
    expect(loopRuns).toBeGreaterThan(0);
    await rt.dispose();
  });
});

/** Electrobun's before-quit event: a handler vetoes by setting response. */
const beforeQuit = () => ({}) as { response?: { allow: boolean } };

describe("createQuitGuard", () => {
  test("vetoes the first quit, disposes, then quits for real", async () => {
    const steps: string[] = [];
    const guard = createQuitGuard({
      dispose: async () => void steps.push("dispose"),
      quit: () => void steps.push("quit"),
      timeoutMs: 1_000,
    });
    const first = beforeQuit();
    guard.onBeforeQuit(first);
    expect(first.response).toEqual({ allow: false });
    await Bun.sleep(5);
    expect(steps).toEqual(["dispose", "quit"]);
    expect(logLines()).toEqual([
      "[info] [app] quitting — stopping background work",
      expect.stringMatching(
        /^\[info\] \[app\] background work stopped in \d+ms$/,
      ),
    ]);
    // quit() re-emits before-quit; this time it goes through.
    const second = beforeQuit();
    guard.onBeforeQuit(second);
    expect(second.response).toBeUndefined();
  });

  test("a dispose that hangs is abandoned after the timeout and the app still quits", async () => {
    let quits = 0;
    const guard = createQuitGuard({
      dispose: () => new Promise<void>(() => {}),
      quit: () => void quits++,
      timeoutMs: 20,
    });
    guard.onBeforeQuit(beforeQuit());
    await Bun.sleep(5);
    expect(quits).toBe(0);
    await Bun.sleep(30);
    expect(quits).toBe(1);
    expect(logLines()).toContain(
      "[warn] [app] cleanup still running after 0.02s — quitting anyway",
    );
  });

  test("a dispose that fails is logged and the app still quits", async () => {
    let quits = 0;
    const guard = createQuitGuard({
      dispose: () => Promise.reject(new Error("finalizer blew up")),
      quit: () => void quits++,
      timeoutMs: 1_000,
    });
    guard.onBeforeQuit(beforeQuit());
    await Bun.sleep(5);
    expect(quits).toBe(1);
    expect(logLines()).toContain(
      "[error] [app] cleanup failed: finalizer blew up",
    );
  });

  test("quitting again during cleanup is vetoed without a second dispose", async () => {
    let disposes = 0;
    let quits = 0;
    let finish = () => {};
    const guard = createQuitGuard({
      dispose: () => {
        disposes++;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      quit: () => void quits++,
      timeoutMs: 1_000,
    });
    guard.onBeforeQuit(beforeQuit());
    const again = beforeQuit();
    guard.onBeforeQuit(again);
    expect(again.response).toEqual({ allow: false });
    finish();
    await Bun.sleep(5);
    expect([disposes, quits]).toEqual([1, 1]);
  });

  test("an update restart is let through without cleanup", async () => {
    let disposes = 0;
    const guard = createQuitGuard({
      dispose: async () => void disposes++,
      quit: () => {},
      timeoutMs: 1_000,
    });
    // Electrobun's applyUpdate() asks before-quit once and cancels the
    // install on a veto, so the restart must be allowed straight through.
    const restart = beforeQuit();
    await guard.duringUpdateRestart(async () => guard.onBeforeQuit(restart));
    expect(restart.response).toBeUndefined();
    expect(disposes).toBe(0);
  });

  test("an update that didn't restart leaves later quits guarded", async () => {
    const guard = createQuitGuard({
      dispose: async () => {},
      quit: () => {},
      timeoutMs: 1_000,
    });
    await guard
      .duringUpdateRestart(() => Promise.reject(new Error("bundle missing")))
      .catch(() => {});
    const later = beforeQuit();
    guard.onBeforeQuit(later);
    expect(later.response).toEqual({ allow: false });
  });
});
