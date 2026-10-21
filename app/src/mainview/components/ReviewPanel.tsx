import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileText,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { api, refreshSidebar } from "../rpc";
import { Button } from "@/components/ui/button";

/** Ingest review queue — every knowledge doc an ingest run added or updated,
 *  detected by the app (snapshot diff), awaiting a human accept/reject.
 *  Reject restores a kept previous version of an updated doc, or reuses the
 *  Trash-safe "forget" path for a new one — so nothing is ever lost. */
export function ReviewPanel() {
  const items = useStore((s) => s.reviewItems);
  const [open, setOpen] = useState(true);

  if (items.length === 0) return null;

  const resolve = async (path: string, action: "accept" | "reject") => {
    const res = await api.resolveReview(path, action);
    if (!res.ok && res.error) {
      useStore.getState().push({ type: "info", text: res.error });
    }
    void refreshSidebar();
  };

  return (
    <div className="mt-3 rounded-lg border border-brand/30 bg-card">
      <Button
        type="button"
        variant="ghost"
        className="w-full flex items-center gap-2 px-2.5 py-2 text-sm text-foreground hover:bg-brand/8!"
        onClick={() => setOpen((o) => !o)}
      >
        <ClipboardCheck size={14} className="text-brand" />
        <span>Review</span>
        <span className="text-xs rounded-full px-1.5 bg-brand/15 text-brand">
          {items.length}
        </span>
        <span className="ml-auto text-muted-foreground">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </Button>
      {open && (
        <div className="px-3 pb-2 space-y-1">
          <p className="text-[0.6875rem] text-muted-foreground">
            Ingest filed these into the brain — check they landed right.
          </p>
          {items.map((item) => (
            <div key={item.path}>
              <div
                // relative anchors the path button's whole-row click overlay.
                className="relative flex items-center gap-1.5 rounded px-1 -mx-1 text-[0.6875rem] text-muted-foreground hover:bg-muted/50"
              >
                <FileText size={11} className="shrink-0" />
                {/* The path button is the row's only open-doc target (no onClick
                  on the div — it's not an interactive element). Its ::before
                  overlay stretches the hit area over the whole row; the
                  accept/reject buttons are positioned, which paints them above
                  the overlay so their clicks never open the doc. */}
                <button
                  type="button"
                  className="truncate flex-1 text-left hover:text-foreground before:absolute before:inset-0"
                  title={`Open knowledge/${item.path}`}
                  onClick={() => useStore.getState().openKnowledgeAt(item.path)}
                >
                  {item.path}
                </button>
                <span
                  className={cn(
                    "shrink-0 text-[0.5625rem] uppercase tracking-wide",
                    item.change === "new" ? "text-success" : "text-info",
                  )}
                >
                  {item.change}
                </span>
                <button
                  type="button"
                  className="relative shrink-0 p-0.5 rounded text-success hover:bg-success/15"
                  title={`Accept — keep this doc${item.linked?.length ? " and its entity page changes" : ""}`}
                  onClick={() => void resolve(item.path, "accept")}
                >
                  <Check size={12} />
                </button>
                <button
                  type="button"
                  className="relative shrink-0 p-0.5 rounded text-destructive hover:bg-destructive/15"
                  title={`${
                    item.revertible
                      ? "Reject — restore the version from before this change"
                      : "Reject — move to Trash and drop its INDEX line"
                  }${item.linked?.length ? ", and undo its entity page changes" : ""}`}
                  onClick={() => void resolve(item.path, "reject")}
                >
                  <X size={12} />
                </button>
              </div>
              {item.linked?.length ? (
                <p
                  className="pl-[1.125rem] text-[0.625rem] text-muted-foreground/80 truncate"
                  title="Entity pages this ingest created or updated — kept or undone together with this doc"
                >
                  + {item.linked.join(", ")}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
