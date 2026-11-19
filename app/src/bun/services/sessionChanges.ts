import { dequal } from "dequal";
import type { SessionChanges, SessionSummary } from "../../shared/ipc";

/** Remembers the Thread rows last sent to the webview per workspace, so a
 *  sessionsChanged push carries only the rows that actually changed — a Turn
 *  ending sends one row, not every list in the sidebar. */
export class SessionChangeTracker {
  private sent = new Map<string, Map<string, SessionSummary>>();

  /** The rows that differ from what was last sent (and record `rows` as
   *  sent), or null when nothing changed. */
  diff(workspaceId: string, rows: SessionSummary[]): SessionChanges | null {
    const prev = this.sent.get(workspaceId) ?? new Map();
    const next = new Map(rows.map((r) => [r.sessionId, r]));
    const upsert = rows.filter((r) => !dequal(prev.get(r.sessionId), r));
    const remove = [...prev.keys()].filter((id) => !next.has(id));
    this.sent.set(workspaceId, next);
    if (!upsert.length && !remove.length) return null;
    return { workspaceId, upsert, remove };
  }

  /** Record a full list as sent (snapshot responses) without diffing. */
  reset(workspaceId: string, rows: SessionSummary[]): void {
    this.sent.set(workspaceId, new Map(rows.map((r) => [r.sessionId, r])));
  }

  /** Forget a workspace (removed) so a later re-add starts clean. */
  forget(workspaceId: string): void {
    this.sent.delete(workspaceId);
  }
}
