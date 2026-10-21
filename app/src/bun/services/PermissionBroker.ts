import { randomUUID } from "node:crypto";
import { Deferred, Effect } from "effect";
import type { PermissionRequest } from "../../shared/ipc";

type Pending = {
  /** The user's answer; completed once — by a click, the timeout, or a
   *  run-wide denial, whichever comes first. */
  answer: Deferred.Deferred<boolean>;
  runId: string;
  toolName: string;
  /** The workspace that OWNS this request — the run's workspace, captured at
   *  ask() time. "Always allow" must persist the grant here, not to whatever
   *  workspace happens to be active when the user clicks (they may have
   *  switched while the run kept prompting). */
  workspaceId: string;
};

const TIMEOUT_MS = 5 * 60 * 1000; // agent subprocess is blocked while waiting

/** Correlates SDK canUseTool callbacks with approve/deny answers from the UI. */
export class PermissionBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private push: (req: PermissionRequest) => void,
    private opts: {
      /** Runs the wait (the app runtime: its logger and clock). */
      run?: (effect: Effect.Effect<boolean>) => Promise<boolean>;
    } = {},
  ) {}

  /** Called from the SDK's canUseTool. Resolves when the user answers;
   *  denied after five minutes unanswered, or if the wait is cut short. */
  ask(
    runId: string,
    toolName: string,
    input: unknown,
    workspaceId: string,
  ): Promise<boolean> {
    const requestId = randomUUID();
    const answer = Deferred.makeUnsafe<boolean>();
    this.pending.set(requestId, { answer, runId, toolName, workspaceId });
    this.push({
      requestId,
      runId,
      toolName,
      inputSummary: summarize(toolName, input),
      input,
    });
    const wait = Deferred.await(answer).pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT_MS,
        orElse: () => Effect.succeed(false),
      }),
      Effect.ensuring(Effect.sync(() => this.pending.delete(requestId))),
    );
    const run = this.opts.run ?? ((e) => Effect.runPromise(e));
    return run(wait).catch(() => false);
  }

  /** Tool name of a still-pending request (for "always allow" persistence). */
  toolNameOf(requestId: string): string | undefined {
    return this.pending.get(requestId)?.toolName;
  }

  /** Owning workspace of a still-pending request (for "always allow"). */
  workspaceIdOf(requestId: string): string | undefined {
    return this.pending.get(requestId)?.workspaceId;
  }

  respond(requestId: string, allow: boolean): boolean {
    return this.settle(requestId, allow);
  }

  /** Deny everything outstanding for a run (abort/quit) so the SDK never hangs. */
  denyAllForRun(runId: string): void {
    for (const [id, p] of this.pending) {
      if (p.runId === runId) this.settle(id, false);
    }
  }

  private settle(requestId: string, allow: boolean): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    return Deferred.doneUnsafe(p.answer, Effect.succeed(allow));
  }
}

export function summarize(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]) => {
    for (const k of keys)
      if (typeof i[k] === "string" && i[k]) return i[k] as string;
    return "";
  };
  // Never dump raw input values: this string is shown in permission cards AND
  // written verbatim to the workspace's shareable .monad/activity.jsonl, and
  // arbitrary tool inputs can carry credentials. Unknown-shaped inputs are
  // summarized by their key names only.
  const detail =
    first(
      "command",
      "file_path",
      "path",
      "pattern",
      "url",
      "query",
      "prompt",
    ) || `(${Object.keys(i).slice(0, 8).join(", ") || "no input"})`;
  return `${toolName}: ${redactSecrets(String(detail)).slice(0, 200)}`;
}

/** Mask common credential shapes (API keys, tokens, JWTs) in a display string.
 *  Belt-and-braces for the known-key paths above — e.g. a Bash command line
 *  that embeds a key, or a URL with a bearer token. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\bsk-(ant-)?[A-Za-z0-9_-]{8,}/g, "sk-…redacted")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "gh…redacted")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, "xox…redacted")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA…redacted")
    .replace(
      /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "jwt…redacted",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1…redacted");
}
