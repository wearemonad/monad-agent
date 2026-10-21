import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CodexEventMapper,
  codexInput,
  codexRunConfig,
  findGeneratedImages,
  friendlyCodexError,
  unwrapShellCommand,
} from "./CodexAgentService";

describe("unwrapShellCommand", () => {
  test("strips the login-shell wrapper codex exec adds", () => {
    expect(unwrapShellCommand("/bin/zsh -lc ls")).toBe("ls");
    expect(unwrapShellCommand("/bin/zsh -lc 'ls -la knowledge'")).toBe(
      "ls -la knowledge",
    );
    expect(unwrapShellCommand('bash -c "grep -r foo ."')).toBe("grep -r foo .");
  });

  test("leaves unwrapped commands alone", () => {
    expect(unwrapShellCommand("git status")).toBe("git status");
  });
});

describe("CodexEventMapper", () => {
  test("grows agent messages as deltas, then emits the authoritative text", () => {
    const m = new CodexEventMapper("r1");
    const item = { id: "i1", type: "agent_message" as const, text: "Hel" };
    expect(m.map({ type: "item.started", item })).toEqual([
      { kind: "text-delta", runId: "r1", text: "Hel" },
    ]);
    expect(
      m.map({ type: "item.updated", item: { ...item, text: "Hello" } }),
    ).toEqual([{ kind: "text-delta", runId: "r1", text: "lo" }]);
    expect(
      m.map({ type: "item.completed", item: { ...item, text: "Hello!" } }),
    ).toEqual([{ kind: "text", runId: "r1", text: "Hello!" }]);
  });

  test("a command becomes a Bash call/result pair", () => {
    const m = new CodexEventMapper("r1");
    const base = {
      id: "c1",
      type: "command_execution" as const,
      command: "/bin/zsh -lc ls",
      aggregated_output: "",
    };
    const started = m.map({
      type: "item.started",
      item: { ...base, status: "in_progress" },
    });
    expect(started).toEqual([
      {
        kind: "tool-call",
        runId: "r1",
        toolUseId: "c1",
        name: "Bash",
        inputSummary: "Bash: ls",
      },
    ]);
    const done = m.map({
      type: "item.completed",
      item: {
        ...base,
        aggregated_output: "CLAUDE.md\n",
        exit_code: 0,
        status: "completed",
      },
    });
    // The call was already announced — only the result follows.
    expect(done).toEqual([
      {
        kind: "tool-result",
        runId: "r1",
        toolUseId: "c1",
        output: "CLAUDE.md\n",
        isError: false,
      },
    ]);
  });

  test("a tool seen only at completion still gets its call first", () => {
    const m = new CodexEventMapper("r1");
    const events = m.map({
      type: "item.completed",
      item: {
        id: "f1",
        type: "file_change",
        changes: [{ path: "knowledge/a.md", kind: "add" }],
        status: "completed",
      },
    });
    expect(events.map((e) => e.kind)).toEqual(["tool-call", "tool-result"]);
  });

  test("non-zero exit codes are errors", () => {
    const m = new CodexEventMapper("r1");
    const [, result] = m.map({
      type: "item.completed",
      item: {
        id: "c2",
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
        status: "completed",
      },
    });
    expect(result).toMatchObject({ kind: "tool-result", isError: true });
  });

  test("warning items stay out of the chat", () => {
    const m = new CodexEventMapper("r1");
    expect(
      m.map({
        type: "item.completed",
        item: { id: "e1", type: "error", message: "deprecated config" },
      }),
    ).toEqual([]);
    expect(m.warnings).toEqual(["deprecated config"]);
  });
});

describe("friendlyCodexError", () => {
  test("pulls the message out of Codex's JSON error blob", () => {
    const raw =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-x\' model is not supported."}}';
    expect(friendlyCodexError(raw)).toBe("The 'gpt-x' model is not supported.");
  });

  test("points sign-in failures at Settings", () => {
    expect(friendlyCodexError("401 Unauthorized")).toContain(
      "Settings → Providers → OpenAI",
    );
  });
});

describe("codexInput", () => {
  test("plain prompts pass through unchanged", () => {
    expect(codexInput("hello")).toBe("hello");
  });

  test("attached images become image inputs alongside the text", () => {
    const prompt =
      "What's this?\n\n[Attached for context — read these files: /w/.monad/attachments/a.png, /w/.monad/attachments/b.JPG, /w/notes.txt]";
    expect(codexInput(prompt)).toEqual([
      { type: "text", text: prompt },
      { type: "local_image", path: "/w/.monad/attachments/a.png" },
      { type: "local_image", path: "/w/.monad/attachments/b.JPG" },
    ]);
  });
});

describe("findGeneratedImages", () => {
  test("finds this turn's images where Codex left them, without copying", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-images-"));
    try {
      const thread = "01a0f650-2687-7190-9a70-c83580d35e82";
      const dir = path.join(home, "generated_images", thread);
      fs.mkdirSync(dir, { recursive: true });
      const old = path.join(dir, "exec-old.png");
      fs.writeFileSync(old, "old");
      fs.utimesSync(old, new Date(1000), new Date(1000));
      fs.writeFileSync(path.join(dir, "exec-new.png"), "new");
      fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");

      expect(findGeneratedImages(home, thread, Date.now() - 60_000)).toEqual([
        { path: path.join(dir, "exec-new.png"), name: "exec-new.png" },
      ]);
      expect(fs.readdirSync(dir).sort()).toEqual([
        "exec-new.png",
        "exec-old.png",
        "notes.txt",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a thread without images, or a hostile id, yields nothing", () => {
    expect(findGeneratedImages("/nonexistent", "t-1", 0)).toEqual([]);
    expect(findGeneratedImages("/tmp", "../../etc", 0)).toEqual([]);
  });
});

describe("codexRunConfig", () => {
  test("maps the reasoning level and service tier", () => {
    expect(codexRunConfig({ effort: "ultra", speed: "fast" })).toEqual({
      effort: "ultra",
      serviceTier: "fast",
    });
  });

  test("unknown levels fall back to Codex's default; standard is explicit", () => {
    expect(codexRunConfig({ effort: "ultracode" })).toEqual({
      serviceTier: "default",
    });
    expect(codexRunConfig(undefined)).toEqual({ serviceTier: "default" });
  });
});
