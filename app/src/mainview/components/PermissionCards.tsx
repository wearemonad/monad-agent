import { useEffect, useMemo } from "react";
import { ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "../store";
import { api } from "../rpc";

/** Tools powerful enough that a reflexive Enter must never approve them. These
 *  require a deliberate click (Bash can run anything; a Gmail draft is one
 *  click from send; MCP tools reach external systems). */
function isSensitiveTool(toolName: string): boolean {
  return (
    toolName === "Bash" ||
    toolName === "Write" ||
    toolName === "Edit" ||
    toolName.startsWith("mcp__")
  );
}

/** Inline permission requests, rendered in the chat transcript where the
 *  pending tool call already lives — the rest of the app (sidebar, settings,
 *  scrollback) stays usable while the agent waits. Only interactive chat runs
 *  ask; background runs (ingest, scheduled jobs) never reach here. */
export function PermissionCards() {
  const allRequests = useStore((s) => s.permissionQueue);
  const runThreads = useStore((s) => s.runThreads);
  const activeThreadKey = useStore((s) => s.activeThreadKey);
  // Only THIS thread's requests render here — a parallel thread's cards wait
  // in its own transcript (the sidebar badges the thread as needing input).
  const queue = useMemo(
    () => allRequests.filter((r) => runThreads[r.runId] === activeThreadKey),
    [allRequests, runThreads, activeThreadKey],
  );
  const first = queue[0];

  // Enter approves / Esc denies the oldest request — but ONLY when nothing else
  // holds focus (activeElement is the body). After clicking any button (a
  // thread, "Ingest now", an accordion) focus sits on that button, so a
  // reflexive Enter would otherwise approve an unread card AND re-fire the
  // button. Esc-to-deny is always safe, so it isn't gated. Enter never
  // approves a sensitive tool — those need an explicit click.
  useEffect(() => {
    if (!first) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void api.respondPermission(first.requestId, false);
        return;
      }
      if (e.key !== "Enter") return;
      if (document.activeElement !== document.body) return;
      if (isSensitiveTool(first.toolName)) return;
      void api.respondPermission(first.requestId, true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [first]);

  if (queue.length === 0) return null;
  return (
    <div className="space-y-2">
      {queue.map((req, i) => (
        <div
          key={req.requestId}
          className="max-w-[90%] rounded-xl border border-warning/30 bg-warning/8 px-4 py-3"
        >
          <div className="flex items-center gap-1.5 text-sm text-foreground font-medium">
            <ShieldQuestion size={14} className="text-warning shrink-0" />
            Allow <span className="font-mono text-warning">{req.toolName}</span>
            ?
          </div>
          <pre className="bg-background/60 rounded-md p-2.5 my-2 text-xs text-foreground whitespace-pre-wrap max-h-40 overflow-y-auto">
            {req.inputSummary}
          </pre>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void api.respondPermission(req.requestId, true)}
            >
              Allow{i === 0 && !isSensitiveTool(req.toolName) && " (Enter)"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void api.respondPermission(req.requestId, false)}
            >
              Deny{i === 0 && " (Esc)"}
            </Button>
            <button
              type="button"
              className="ml-auto text-[0.6875rem] text-muted-foreground hover:text-foreground truncate"
              title={`Allow and never ask again for ${req.toolName} in this workspace`}
              onClick={() =>
                void api.respondPermission(req.requestId, true, true)
              }
            >
              Always allow in this workspace
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
