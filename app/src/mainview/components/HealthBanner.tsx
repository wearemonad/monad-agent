import { useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../rpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Proactive health-check results — "Twenty key expired, fix in Settings"
 *  instead of a support email. The sidebar banner stays one line; clicking it
 *  opens a dialog with the full list. Dismiss hides it until the next check
 *  finds something different (or the app restarts). */
export function HealthBanner() {
  const allIssues = useStore((s) => s.healthIssues);
  const activeWorkspaceId = useStore(
    (s) => s.workspaces.find((w) => w.active)?.id,
  );
  // App-wide issues (no workspace — e.g. the Claude CLI login) show in every
  // workspace; the rest only where they apply.
  const issues = allIssues.filter(
    (i) => i.workspaceId === "" || i.workspaceId === activeWorkspaceId,
  );

  const [dismissed, setDismissed] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const key = issues
    .map((i) => `${i.workspaceId}:${i.source}:${i.message}`)
    .join("|");
  if (issues.length === 0 || dismissed === key) return null;

  const recheck = async () => {
    setRechecking(true);
    try {
      await api.runHealthCheck();
    } finally {
      setRechecking(false);
    }
  };

  return (
    <Dialog>
      {/* Dismiss is a sibling of the trigger (buttons can't nest in HTML),
          positioned over its right edge to keep the one-line pill look. */}
      <div className="relative w-full">
        <DialogTrigger
          render={
            <Button variant="warning" className="justify-start w-full pr-8">
              <AlertTriangle size={14} className="text-warning shrink-0" />
              <span className="flex-1 text-left hover:text-warning">
                {issues.length} health{" "}
                {issues.length === 1 ? "issue" : "issues"}
              </span>
            </Button>
          }
        />
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 mt-px">
          <Button
            variant="ghost"
            size="icon-xs"
            title="Dismiss until something changes"
            onClick={() => setDismissed(key)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-warning" />
            {issues.length} health {issues.length === 1 ? "issue" : "issues"}
          </DialogTitle>
          <DialogDescription>
            Found by the proactive checks (launch + daily) — most are fixed in
            Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto space-y-1.5 -mx-1 px-1">
          {issues.map((i) => (
            <div
              key={`${i.workspaceId}:${i.source}`}
              className="rounded-lg bg-muted/60 border border-border/60 px-3 py-2"
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                {i.workspaceName && (
                  <span className="text-xs font-medium text-foreground">
                    {i.workspaceName}
                  </span>
                )}
                <span className="text-[0.625rem] uppercase tracking-wide text-warning bg-warning/15 rounded-sm px-1.5 py-0.5">
                  {i.source}
                </span>
              </div>
              <p className="text-xs text-muted-foreground wrap-break-word">
                {i.message}
              </p>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={rechecking}
            onClick={() => void recheck()}
          >
            {rechecking ? (
              <Loader2 size={13} className="mr-1.5 animate-spin" />
            ) : (
              <RefreshCw size={13} className="mr-1.5" />
            )}
            Re-run checks
          </Button>
          <Button
            onClick={() => {
              useStore.getState().setSettingsOpen(true);
            }}
          >
            Open Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
