import type { SessionSummary } from "../../shared/ipc";
import { useStore } from "../store";
import { api } from "../rpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ThreadRef = Pick<SessionSummary, "sessionId" | "title">;

/** Delete a thread the way the sidebar does: abort any live run, drop its
 *  stashed state, and (if it is the open thread) fall back to a fresh chat —
 *  all inside `api.deleteSession`. Surfaces a toast on failure. */
export async function deleteThread(thread: ThreadRef): Promise<boolean> {
  const ok = await api.deleteSession(thread.sessionId);
  if (!ok) {
    useStore.getState().push({
      type: "error",
      text: `Could not delete thread "${thread.title}".`,
    });
  }
  return ok;
}

/** In-app "Delete “title”? Yes / No" strip shared by the sidebar row and the
 *  thread panel header. window.confirm is a native WKWebView panel Electrobun
 *  may not surface, which silently cancels the delete. */
export function DeleteThreadConfirm({
  thread,
  onClose,
  className,
}: {
  thread: ThreadRef;
  /** Called after Yes (once the delete has run) or on No. */
  onClose: () => void;
  className?: string;
}) {
  const confirm = async () => {
    onClose();
    await deleteThread(thread);
  };
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 h-8 rounded-lg bg-destructive/8 text-xs",
        className,
      )}
    >
      <span className="truncate flex-1 text-destructive" title={thread.title}>
        Delete “{thread.title}”?
      </span>
      <Button size="xs" variant="destructive" onClick={() => void confirm()}>
        Yes
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="px-0 hover:bg-transparent! opacity-80 hover:opacity-100"
        onClick={onClose}
      >
        No
      </Button>
    </div>
  );
}
