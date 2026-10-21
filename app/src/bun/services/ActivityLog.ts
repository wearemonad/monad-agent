import * as fs from "node:fs";
import * as path from "node:path";

/** One line in the per-workspace append-only agent action log. Conventional
 *  kinds: run-started · run-finished · run-error · tool · permission ·
 *  background-denied · capture. */
export type ActivityEntry = {
  ts: string;
  kind: string;
  detail: string;
  runId?: string;
};

/** Append-only audit trail of what the agent did in a workspace: runs, tool
 *  calls, permission outcomes, capture events. JSONL at .monad/activity.jsonl —
 *  human-greppable, trivially parseable, never rewritten. Logging must never
 *  break a run, so every append swallows its own errors. */
export class ActivityLog {
  append(workspacePath: string, entry: Omit<ActivityEntry, "ts">): void {
    try {
      const dir = path.join(workspacePath, ".monad");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "activity.jsonl"),
        `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      );
    } catch {
      // a full disk or read-only workspace must not sink the run itself
    }
  }

  logPath(workspacePath: string): string {
    return path.join(workspacePath, ".monad", "activity.jsonl");
  }
}
