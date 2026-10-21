import { useState } from "react";
import { Check, Copy, Loader2, Mail, Send } from "lucide-react";
import type { EmailDraftData } from "../../shared/ipc";
import { cn } from "@/lib/utils";
import { useStore } from "../store";
import { api } from "../rpc";

type ActionState =
  | { phase: "idle" }
  | { phase: "working"; label: string }
  | { phase: "done"; label: string }
  | { phase: "error"; label: string };

/** Inline email-draft card (Claude-Desktop-style): variant tabs, subject, body,
 *  and human-clicked actions. The agent only presented this data — every path
 *  to Gmail/outbox starts with a click here. */
export function EmailDraftCard({ draft }: { draft: EmailDraftData }) {
  const workspaces = useStore((s) => s.workspaces);
  const googleConnected = !!workspaces.find((w) => w.active)?.drive?.email;
  const [variantIdx, setVariantIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [action, setAction] = useState<ActionState>({ phase: "idle" });

  const variant =
    draft.variants[Math.min(variantIdx, draft.variants.length - 1)];
  const busy = action.phase === "working";
  const done = action.phase === "done";

  const copy = async () => {
    await navigator.clipboard.writeText(variant.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const saveDraft = async (): Promise<string | null> => {
    const res = await api.emailCreateDraft({
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      body: variant.body,
    });
    if (res.error) {
      setAction({ phase: "error", label: res.error });
      return null;
    }
    if (res.outboxFile) {
      setAction({
        phase: "done",
        label: `Saved to outbox/${res.outboxFile} — send it from the Outbox panel`,
      });
      return null;
    }
    return res.draftId ?? null;
  };

  const onSaveDraft = async () => {
    setAction({ phase: "working", label: "Saving draft…" });
    const draftId = await saveDraft();
    if (draftId) {
      setAction({
        phase: "done",
        label:
          "Saved to Gmail drafts — review and send from the Outbox panel or Gmail",
      });
      useStore.getState().bumpGmailDrafts();
    }
  };

  const onSend = async () => {
    setAction({ phase: "working", label: "Sending…" });
    const active = useStore.getState().workspaces.find((w) => w.active);
    const draftId = await saveDraft();
    if (!draftId || !active) return;
    const res = await api.gmailSendDraft(active.id, draftId);
    setAction(
      res.ok
        ? { phase: "done", label: `Sent to ${draft.to}` }
        : {
            phase: "error",
            label: res.error ?? "Send failed — the draft is still in Gmail",
          },
    );
    // A failed send leaves the freshly created draft in Gmail; either way
    // the Outbox panel's list may have changed.
    useStore.getState().bumpGmailDrafts();
  };

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-border bg-muted/40 overflow-hidden">
      {draft.variants.length > 1 && (
        <div className="flex items-center gap-1.5 px-3 pt-3 pb-2 border-b border-border flex-wrap">
          {draft.variants.map((v, i) => (
            <button
              type="button"
              key={v.label}
              onClick={() => setVariantIdx(i)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors",
                i === variantIdx
                  ? "bg-muted text-foreground border border-border"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "w-4 h-4 rounded-full text-[0.625rem] flex items-center justify-center",
                  i === variantIdx
                    ? "bg-brand/15 text-brand"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {String.fromCharCode(65 + i)}
              </span>
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className="px-4 py-2.5 border-b border-border flex gap-2 text-sm">
        <span className="text-muted-foreground shrink-0">To:</span>
        <span className="text-foreground truncate">{draft.to}</span>
        {draft.cc && (
          <>
            <span className="text-muted-foreground shrink-0">Cc:</span>
            <span className="text-foreground truncate">{draft.cc}</span>
          </>
        )}
      </div>
      <div className="px-4 py-2.5 border-b border-border flex gap-2 text-sm">
        <span className="text-muted-foreground shrink-0">Subject:</span>
        <span className="text-foreground font-medium truncate">
          {draft.subject}
        </span>
      </div>
      <div className="px-4 py-3 text-sm text-foreground/90 whitespace-pre-wrap">
        {variant.body}
      </div>
      <div className="px-3 py-2.5 border-t border-border space-y-2">
        {action.phase !== "idle" && (
          <div
            className={cn(
              "text-xs flex items-start gap-1.5",
              action.phase === "error"
                ? "text-destructive"
                : done
                  ? "text-success"
                  : "text-muted-foreground",
            )}
          >
            {busy && (
              <Loader2 size={12} className="animate-spin shrink-0 mt-0.5" />
            )}
            {done && <Check size={12} className="shrink-0 mt-0.5" />}
            <span className="min-w-0">{action.label}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Copy this variant's body"
            onClick={() => void copy()}
          >
            {copied ? (
              <Check size={12} className="text-success" />
            ) : (
              <Copy size={12} />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
          {googleConnected ? (
            <>
              <button
                type="button"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
                disabled={busy || done}
                title="Create a Gmail draft — nothing is sent"
                onClick={() => void onSaveDraft()}
              >
                <Mail size={12} /> Save draft
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap shrink-0 bg-brand/15 border border-brand/30 text-brand transition-colors hover:bg-brand/25 disabled:opacity-40 disabled:pointer-events-none"
                disabled={busy || done}
                title={`Send this variant to ${draft.to} via Gmail`}
                onClick={() => void onSend()}
              >
                <Send size={12} /> Send via Gmail
              </button>
            </>
          ) : (
            <button
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap shrink-0 bg-brand/15 border border-brand/30 text-brand transition-colors hover:bg-brand/25 disabled:opacity-40 disabled:pointer-events-none"
              disabled={busy || done}
              title="No Google account connected — saves the draft to outbox/ for review"
              onClick={() => void onSaveDraft()}
            >
              <Mail size={12} /> Save to Outbox
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
