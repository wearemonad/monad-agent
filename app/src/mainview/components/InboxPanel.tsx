import { FileText, FolderOpen, Inbox, Square, Trash2, X } from "lucide-react";
import type { IngestOutcome } from "../../shared/ipc";
import { useStore } from "../store";
import { api } from "../rpc";
import { cn } from "@/lib/utils";
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
import { Spinner } from "@/components/ui/spinner";

export function InboxPanel() {
  const files = useStore((s) => s.inboxFiles);
  const ingest = useStore((s) => s.ingest);
  // Only an active ingest locks the file list (it is moving these files);
  // chat runs — this thread's or a parallel one's — don't block the inbox.
  const busy = ingest.active;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            className="justify-start w-full"
            title="Open the inbox"
          >
            <Inbox size={14} className="text-muted-foreground" />
            Inbox
            <span
              className={cn(
                "text-xs rounded-full px-1.5",
                files.length
                  ? "bg-warning/15 text-warning"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {files.length}
            </span>
            {ingest.active && <Spinner className="ml-auto size-3.5" />}
          </Button>
        }
      />
      <DialogContent className="w-140 max-w-[92vw] sm:max-w-[92vw] gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Inbox size={15} className="text-muted-foreground" />
            Inbox
            <span className="text-xs text-muted-foreground font-normal">
              {files.length} file{files.length === 1 ? "" : "s"}
            </span>
          </DialogTitle>
          <DialogDescription>
            Everything captured but not yet folded into the brain. Ingest turns
            these into knowledge docs — the results land in Review.
          </DialogDescription>
        </DialogHeader>
        {ingest.active ? (
          <p className="text-[0.6875rem] text-warning">
            Ingesting {ingest.files.length} file(s) in the background — results
            land in Review.
          </p>
        ) : (
          ingest.last && <IngestResult outcome={ingest.last} />
        )}
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Empty. Drop files anywhere, paste a URL in chat, label an email
            “Monad” in Gmail, or set a Drive/watch folder in Settings.
          </p>
        ) : (
          <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {files.map((f) => (
              <div
                key={f.name}
                className="group flex items-center gap-2 px-3 py-2 text-xs text-foreground"
                title={f.name}
              >
                <FileText
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate flex-1 min-w-0">{f.name}</span>
                <span className="text-muted-foreground shrink-0">
                  {formatSize(f.size)}
                </span>
                {/* hidden while ingest is active: it is moving these files */}
                {!busy && (
                  <button
                    type="button"
                    className="shrink-0 p-0.5 -my-0.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive focus:outline-none"
                    title="Remove from inbox (moves to Trash)"
                    onClick={() => void api.deleteInboxFile(f.name)}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          {/* hidden while ingest is active, same as the per-file remove */}
          {files.length > 0 && !busy && (
            <Button
              variant="secondary"
              className="mr-auto text-destructive hover:text-destructive"
              title="Move all inbox files to the Trash (recoverable)"
              onClick={() => void api.clearInbox()}
            >
              <Trash2 size={12} /> Clear all
            </Button>
          )}
          <Button
            variant="secondary"
            title="Reveal inbox folder in Finder"
            onClick={() => void api.revealInbox()}
          >
            <FolderOpen size={12} /> Finder
          </Button>
          {ingest.active ? (
            <Button
              variant="destructive"
              title="Stop the ingest run — files still in inbox stay put; anything already written lands in Review"
              onClick={() => void api.stopIngest()}
            >
              <Square size={12} fill="currentColor" /> Stop ingesting
            </Button>
          ) : (
            <Button
              disabled={files.length === 0 || busy}
              onClick={() => void api.ingestInbox()}
            >
              Ingest now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How the last ingest went. A clean "finished" can still mean nothing was
 *  filed (the agent couldn't read a file), so this is driven by what's left
 *  in the inbox — with the agent's own report one click away. */
function IngestResult({ outcome }: { outcome: IngestOutcome }) {
  const { status, reviewCount, leftover, summary, error } = outcome;
  const review = reviewCount
    ? `${reviewCount} doc${reviewCount === 1 ? "" : "s"} waiting in Review`
    : "nothing new for Review";
  const notDone = leftover.length
    ? ` ${leftover.join(", ")} ${leftover.length === 1 ? "is" : "are"} still in the inbox.`
    : "";
  const line =
    status === "ok"
      ? `Last ingest finished — ${review}.`
      : status === "stopped"
        ? `Last ingest was stopped — ${review}.${notDone}`
        : status === "partial"
          ? `Last ingest only partly worked — ${review}.${notDone}`
          : error
            ? `Last ingest failed: ${error}`
            : `Last ingest couldn’t process ${leftover.length === 1 ? "the file" : "these files"}.${notDone}`;
  const problem = status === "partial" || status === "failed";
  return (
    <div className="flex flex-col gap-1 text-[0.6875rem]">
      <p
        className={cn(
          status === "ok" && "text-success",
          status === "stopped" && "text-muted-foreground",
          problem && "text-destructive",
        )}
      >
        {line}
      </p>
      {summary && (
        // Open by default when something went wrong: the agent's report is
        // the only place that says WHY.
        <details open={problem} className="text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">
            Agent’s report
          </summary>
          <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-border px-2 py-1.5">
            {summary}
          </p>
        </details>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
