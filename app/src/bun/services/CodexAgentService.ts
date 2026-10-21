import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { Input, ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { AgentStreamEvent, ChatItem, RunOptions } from "../../shared/ipc";
import type { CodexAuthStrategy } from "../auth/CodexAuth";
import type { CodexThreadStore, CodexThreadRecord } from "./CodexThreadStore";
import { loadWorkspaceEnv } from "./envFile";
import { summarize } from "./PermissionBroker";

/** Every current Codex model has a 272K window; the meter uses it until a
 *  model-specific number is known. */
const CODEX_CONTEXT_WINDOW = 272_000;

/** Tool output shown in the chat is capped like the Claude path's. */
const MAX_TOOL_OUTPUT = 2000;

/** `codex exec` wraps every command in the user's login shell
 *  (`/bin/zsh -lc 'ls -la'`) — show the command itself. Exported for tests. */
export function unwrapShellCommand(command: string): string {
  const m = command.match(/^\S*\/?(?:ba|z)?sh -l?c (.*)$/s);
  if (!m) return command;
  const inner = m[1].trim();
  if (
    inner.length >= 2 &&
    (inner[0] === "'" || inner[0] === '"') &&
    inner.endsWith(inner[0])
  ) {
    return inner.slice(1, -1);
  }
  return inner;
}

function mcpResultText(
  item: Extract<ThreadItem, { type: "mcp_tool_call" }>,
): string {
  if (item.error) return item.error.message;
  return (item.result?.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
}

/** Translates one turn's Codex ThreadEvents into the AgentStreamEvents the
 *  chat already renders. Stateful per run: agent messages that grow via
 *  item.updated become text deltas, and a tool item seen only at completion
 *  still gets its call event before its result. Exported for tests. */
export class CodexEventMapper {
  private textSoFar = new Map<string, number>();
  private startedTools = new Set<string>();
  /** Non-fatal warnings Codex reports as "error" items (deprecated config,
   *  trimmed skill descriptions…). Kept out of the chat; the owner logs them. */
  warnings: string[] = [];

  constructor(private runId: string) {}

  map(event: ThreadEvent): AgentStreamEvent[] {
    switch (event.type) {
      case "item.started":
      case "item.updated":
        return this.progress(event.item);
      case "item.completed":
        return this.complete(event.item);
      default:
        return [];
    }
  }

  private toolCall(item: ThreadItem): AgentStreamEvent[] {
    if (this.startedTools.has(item.id)) return [];
    const call = describeTool(item);
    if (!call) return [];
    this.startedTools.add(item.id);
    return [
      {
        kind: "tool-call",
        runId: this.runId,
        toolUseId: item.id,
        name: call.name,
        inputSummary: call.summary,
      },
    ];
  }

  private progress(item: ThreadItem): AgentStreamEvent[] {
    if (item.type === "agent_message") {
      const seen = this.textSoFar.get(item.id) ?? 0;
      if (item.text.length <= seen) return [];
      this.textSoFar.set(item.id, item.text.length);
      return [
        { kind: "text-delta", runId: this.runId, text: item.text.slice(seen) },
      ];
    }
    if (item.type === "reasoning" || item.type === "error") return [];
    // A todo list is rendered once, in its final state.
    if (item.type === "todo_list") return [];
    return this.toolCall(item);
  }

  private complete(item: ThreadItem): AgentStreamEvent[] {
    const runId = this.runId;
    switch (item.type) {
      case "agent_message":
        this.textSoFar.delete(item.id);
        return item.text ? [{ kind: "text", runId, text: item.text }] : [];
      case "reasoning":
        return item.text ? [{ kind: "thinking", runId, text: item.text }] : [];
      case "error":
        this.warnings.push(item.message);
        return [];
      default: {
        const result = describeResult(item);
        return [
          ...this.toolCall(item),
          {
            kind: "tool-result",
            runId,
            toolUseId: item.id,
            output: result.output.slice(0, MAX_TOOL_OUTPUT),
            isError: result.isError,
          },
        ];
      }
    }
  }
}

function describeTool(
  item: ThreadItem,
): { name: string; summary: string } | null {
  switch (item.type) {
    case "command_execution": {
      const command = unwrapShellCommand(item.command);
      return { name: "Bash", summary: summarize("Bash", { command }) };
    }
    case "file_change": {
      const files = item.changes.map((c) => `${c.kind} ${c.path}`).join(", ");
      return { name: "Edit", summary: `Edit: ${files}`.slice(0, 200) };
    }
    case "mcp_tool_call": {
      const name = `mcp__${item.server}__${item.tool}`;
      return { name, summary: summarize(name, item.arguments) };
    }
    case "web_search":
      return {
        name: "WebSearch",
        summary: summarize("WebSearch", { query: item.query }),
      };
    case "todo_list":
      return {
        name: "TodoWrite",
        summary: `TodoWrite: ${item.items.length} step${item.items.length === 1 ? "" : "s"}`,
      };
    default:
      return null;
  }
}

function describeResult(item: ThreadItem): {
  output: string;
  isError: boolean;
} {
  switch (item.type) {
    case "command_execution":
      return {
        output: item.aggregated_output,
        isError:
          item.status === "failed" ||
          (item.exit_code !== undefined && item.exit_code !== 0),
      };
    case "file_change":
      return {
        output: item.status === "completed" ? "Applied." : "Patch failed.",
        isError: item.status === "failed",
      };
    case "mcp_tool_call":
      return { output: mcpResultText(item), isError: item.status === "failed" };
    case "todo_list":
      return {
        output: item.items
          .map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`)
          .join("\n"),
        isError: false,
      };
    default:
      return { output: "", isError: false };
  }
}

/** Folds stream events into the ChatItems persisted for history replay —
 *  the same shape the webview's own reducer produces live. */
function appendTranscript(items: ChatItem[], e: AgentStreamEvent): void {
  switch (e.kind) {
    case "text":
      items.push({ type: "assistant", text: e.text });
      break;
    case "thinking":
      items.push({ type: "thinking", text: e.text });
      break;
    case "tool-call":
      items.push({
        type: "tool",
        toolUseId: e.toolUseId,
        name: e.name,
        inputSummary: e.inputSummary,
        pending: true,
      });
      break;
    case "tool-result": {
      const tool = items.find(
        (i) => i.type === "tool" && i.toolUseId === e.toolUseId,
      );
      if (tool?.type === "tool") {
        tool.output = e.output;
        tool.isError = e.isError;
        tool.pending = false;
      }
      break;
    }
    case "run-error":
      items.push({ type: "error", text: e.error });
      break;
    case "image":
      items.push({ type: "image", path: e.path, name: e.name });
      break;
  }
}

const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;

/** How the composer's run options map onto Codex: the reasoning level is
 *  the thread's model_reasoning_effort, speed is the service tier. Unknown
 *  levels are dropped (Codex then uses the model's default). Exported for
 *  tests. */
export function codexRunConfig(o: RunOptions | undefined): {
  effort?: ModelReasoningEffort;
  serviceTier: "fast" | "default";
} {
  const levels: ModelReasoningEffort[] = [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ];
  const effort = levels.find((l) => l === o?.effort);
  return {
    ...(effort ? { effort } : {}),
    serviceTier: o?.speed === "fast" ? "fast" : "default",
  };
}

/** Codex's home folder (config, sessions, generated images). */
export function codexHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Images Codex's image tool produced for a thread during this turn.
 *  `codex exec` reports nothing about them in its event stream — the tool
 *  just writes `$CODEX_HOME/generated_images/<threadId>/<id>.png` — so the
 *  turn's output is found by mtime. The chat shows them from there: Monad
 *  keeps no copy of its own (the user saves the ones they want). Exported
 *  for tests. */
export function findGeneratedImages(
  home: string,
  threadId: string,
  sinceMs: number,
): { path: string; name: string }[] {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) return [];
  const source = path.join(home, "generated_images", threadId);
  let names: string[];
  try {
    names = fs.readdirSync(source).filter((n) => IMAGE_FILE.test(n));
  } catch {
    return []; // no images for this thread
  }
  return names
    .map((name) => {
      try {
        return { name, mtime: fs.statSync(path.join(source, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(
      (f): f is { name: string; mtime: number } => !!f && f.mtime >= sinceMs,
    )
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ name }) => ({ path: path.join(source, name), name }));
}

type ActiveCodexRun = {
  abort: AbortController;
  workspacePath: string;
  /** Thread the run continues ("" until a new thread reports its id). */
  threadId: string;
};

/** Interactive chat runs on OpenAI models, driven through the Codex harness
 *  (`codex exec --experimental-json`, one process per turn). Emits the same
 *  AgentStreamEvents as AgentService, so the chat, notifications and run
 *  plumbing need no OpenAI-specific path.
 *
 *  What Codex brings is its own: shell + apply_patch tools inside the
 *  workspace-write sandbox, with no per-tool approval prompts (approval
 *  policy "never" — the sandbox is the boundary). Monad's in-process tools
 *  (Google, memory, artifacts) and skills are Claude-runtime features and
 *  aren't wired in here. */
export class CodexAgentService {
  private runs = new Map<string, ActiveCodexRun>();

  constructor(
    private emit: (event: AgentStreamEvent) => void,
    private threads: CodexThreadStore,
    /** Fired when a thread is created or updated — refreshes the sidebar. */
    private onSessionsChanged: () => void = () => {},
    /** Per-workspace credentials entered in Settings (Keychain-backed). */
    private getAppEnv: (
      workspaceId: string,
    ) => Record<string, string> = () => ({}),
    /** Append-only per-workspace audit trail; must never throw. */
    private logActivity: (
      workspacePath: string,
      entry: { kind: string; detail: string; runId?: string },
    ) => void = () => {},
    /** Monad persona + working-memory snapshot, as developer instructions. */
    private getInstructions: (
      workspaceId: string,
      workspacePath: string,
    ) => string = () => "",
  ) {}

  /** Is a run in flight for this thread? */
  private busyThread(workspacePath: string, threadId: string): boolean {
    for (const r of this.runs.values()) {
      if (r.workspacePath === workspacePath && r.threadId === threadId)
        return true;
    }
    return false;
  }

  startRun(opts: {
    workspaceId: string;
    workspacePath: string;
    prompt: string;
    runId?: string;
    resumeSessionId?: string;
    model?: string;
    /** Composer reasoning level / service tier (see codexRunConfig). */
    runOptions?: RunOptions;
    auth: CodexAuthStrategy;
  }): string {
    if (
      opts.resumeSessionId &&
      this.busyThread(opts.workspacePath, opts.resumeSessionId)
    ) {
      throw new Error("A run is already active in this thread.");
    }
    opts.auth.validate(); // throw a friendly error before spawning anything
    const runId = opts.runId ?? randomUUID();
    const abort = new AbortController();
    this.runs.set(runId, {
      abort,
      workspacePath: opts.workspacePath,
      threadId: opts.resumeSessionId ?? "",
    });
    void this.execute(runId, abort, opts);
    return runId;
  }

  abortRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.abort.abort();
    return true;
  }

  private async execute(
    runId: string,
    abort: AbortController,
    opts: {
      workspaceId: string;
      workspacePath: string;
      prompt: string;
      resumeSessionId?: string;
      model?: string;
      runOptions?: RunOptions;
      auth: CodexAuthStrategy;
    },
  ): Promise<void> {
    const log = (kind: string, detail: string) =>
      this.logActivity(opts.workspacePath, { kind, detail, runId });
    log("run-started", opts.prompt.replace(/\s+/g, " ").slice(0, 160));
    const startedAt = Date.now();
    const now = () => new Date().toISOString();
    const existing = opts.resumeSessionId
      ? this.threads.read(opts.workspacePath, opts.resumeSessionId)
      : null;
    const record: CodexThreadRecord = existing ?? {
      threadId: opts.resumeSessionId ?? "",
      workspaceId: opts.workspaceId,
      provider: opts.auth.id,
      model: opts.model ?? "",
      title: opts.prompt.replace(/\s+/g, " ").trim().slice(0, 60),
      createdAt: now(),
      updatedAt: now(),
      items: [],
    };
    record.provider = opts.auth.id;
    record.model = opts.model ?? record.model;
    record.items.push({ type: "user", text: opts.prompt });
    const save = () => {
      if (!record.threadId) return;
      record.updatedAt = now();
      try {
        this.threads.write(opts.workspacePath, record);
      } catch (e) {
        log("session", `codex thread save failed: ${String(e).slice(0, 120)}`);
      }
    };
    const emit = (e: AgentStreamEvent) => {
      appendTranscript(record.items, e);
      this.emit(e);
    };

    const mapper = new CodexEventMapper(runId);
    let started = false;
    const announce = () => {
      if (started || !record.threadId) return;
      started = true;
      const run = this.runs.get(runId);
      if (run) run.threadId = record.threadId;
      save();
      this.onSessionsChanged();
      this.emit({
        kind: "run-started",
        runId,
        sessionId: record.threadId,
        ...(opts.model ? { model: opts.model } : {}),
      });
    };

    let failure = "";
    try {
      const {
        codexPathOverride,
        apiKey,
        env: authEnv,
      } = opts.auth.codexOptions();
      // process.env < workspace .env < Settings-entered credentials < auth
      // overrides — the same precedence as Claude runs.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...loadWorkspaceEnv(opts.workspacePath),
        ...this.getAppEnv(opts.workspaceId),
        ...authEnv,
      };
      for (const key of Object.keys(env)) {
        if (env[key] === "") delete env[key];
      }
      const run = codexRunConfig(opts.runOptions);
      const instructions = this.getInstructions(
        opts.workspaceId,
        opts.workspacePath,
      );
      const codex = new Codex({
        ...(codexPathOverride ? { codexPathOverride } : {}),
        ...(apiKey ? { apiKey } : {}),
        env,
        config: {
          // Monad workspaces carry their instructions in CLAUDE.md; Codex
          // reads AGENTS.md first and falls back to this.
          project_doc_fallback_filenames: ["CLAUDE.md"],
          ...(instructions ? { developer_instructions: instructions } : {}),
          // Explicit both ways, so the composer's pick wins over the user's
          // own config.toml default.
          service_tier: run.serviceTier,
        },
      });
      const threadOptions = {
        workingDirectory: opts.workspacePath,
        skipGitRepoCheck: true,
        // The sandbox is the permission boundary: writes stay inside the
        // workspace, and nothing prompts mid-run (exec has no UI to ask).
        sandboxMode: "workspace-write" as const,
        approvalPolicy: "never" as const,
        ...(opts.model ? { model: opts.model } : {}),
        ...(run.effort ? { modelReasoningEffort: run.effort } : {}),
      };
      const thread = opts.resumeSessionId
        ? codex.resumeThread(opts.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);
      const { events } = await thread.runStreamed(codexInput(opts.prompt), {
        signal: abort.signal,
      });
      for await (const event of events) {
        if (event.type === "thread.started") {
          record.threadId = event.thread_id;
          announce();
          continue;
        }
        // A resumed thread knows its id up front; announce on the turn.
        if (event.type === "turn.started") {
          announce();
          continue;
        }
        if (event.type === "turn.failed") {
          failure = event.error.message;
          continue;
        }
        if (event.type === "error") {
          failure = event.message;
          continue;
        }
        if (event.type === "turn.completed") {
          const u = event.usage;
          log(
            "usage",
            `in ${u.input_tokens} (cached ${u.cached_input_tokens}) · out ${u.output_tokens}`,
          );
          continue;
        }
        for (const e of mapper.map(event)) emit(e);
      }
      for (const w of mapper.warnings) log("codex-warning", w.slice(0, 200));
      if (abort.signal.aborted) throw new Error("aborted");
      announce();
      // Images generated this turn (with a little slack for clock skew
      // between the file write and our start stamp).
      try {
        const images = findGeneratedImages(
          codexHome(env),
          record.threadId,
          startedAt - 2_000,
        );
        for (const img of images) {
          log("image", `generated ${img.name}`);
          emit({ kind: "image", runId, path: img.path, name: img.name });
        }
      } catch (e) {
        log("image", `collect failed: ${String(e).slice(0, 120)}`);
      }
      log(
        "timing",
        `codex · run ${Date.now() - startedAt}ms${failure ? " · failed" : ""}`,
      );
      if (failure) {
        const error = friendlyCodexError(failure);
        log("run-error", error.slice(0, 200));
        emit({ kind: "run-error", runId, error });
      } else {
        log("run-finished", "1 turn");
        this.emit({
          kind: "run-finished",
          runId,
          sessionId: record.threadId,
          numTurns: 1,
          contextWindow: CODEX_CONTEXT_WINDOW,
        });
      }
    } catch (e) {
      if (abort.signal.aborted) {
        log("run-error", "stopped by user");
        emit({
          kind: "run-error",
          runId,
          error: "Stopped by the user.",
          aborted: true,
        });
      } else {
        const error = friendlyCodexError(
          failure || String((e as Error)?.message ?? e),
        );
        log("run-error", error.slice(0, 200));
        emit({ kind: "run-error", runId, error });
      }
    } finally {
      this.runs.delete(runId);
      save();
      this.onSessionsChanged();
    }
  }
}

/** The composer appends attachments as "[Attached for context — read these
 *  files: /a.png, /b.jpg]". Claude reads image files with its Read tool;
 *  Codex can't view an image through its shell, so attached images are
 *  handed over as image inputs (the text still names them). Exported for
 *  tests. */
export function codexInput(prompt: string): Input {
  const marker = prompt.match(
    /\[Attached for context — read these files: ([^\]]+)\]\s*$/,
  );
  if (!marker) return prompt;
  const images = marker[1]
    .split(", ")
    .map((p) => p.trim())
    .filter((p) => /\.(png|jpe?g|gif|webp)$/i.test(p));
  if (images.length === 0) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((path) => ({ type: "local_image" as const, path })),
  ];
}

/** Codex reports API failures as a JSON blob inside the message — pull out
 *  the human sentence, and point at the fix when it's a sign-in problem. */
export function friendlyCodexError(raw: string): string {
  let message = raw;
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(start)) as {
        message?: string;
        error?: { message?: string };
      };
      message = parsed.error?.message ?? parsed.message ?? raw;
    } catch {
      // not JSON — keep the raw text
    }
  }
  if (/not logged in|401|unauthorized|login/i.test(message)) {
    return `${message}\nHint: sign in to Codex in Settings → Providers → OpenAI, or use an OpenAI API key.`;
  }
  if (/ENOENT|not found/i.test(message) && /codex/i.test(message)) {
    return `${message}\nHint: check the Codex CLI install in Settings → Providers → OpenAI.`;
  }
  return message;
}
