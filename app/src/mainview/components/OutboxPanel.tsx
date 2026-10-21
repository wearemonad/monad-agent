import { useEffect, useRef, useState } from "react";
import { Check, FileText, Mail, Send, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { GmailDraft, OutboxPreview } from "../../shared/ipc";
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
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { safeMarkdownComponents } from "./safeMarkdown";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Base64 → Blob, for previewing image outbox files via a blob URL — data:
 *  URIs of several MB choke the webview, blob URLs don't. */
function base64ToBlob(b64: string, type: string): Blob {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

/** Drafts awaiting human review: outbox/ files and, when Google is connected,
 *  the account's Gmail drafts — reviewable and sendable without leaving the app. */
export function OutboxPanel() {
  const files = useStore((s) => s.outboxFiles);
  const workspaces = useStore((s) => s.workspaces);
  const runState = useStore((s) => s.runState);
  const draftsBump = useStore((s) => s.gmailDraftsBump);
  const active = workspaces.find((w) => w.active);
  const connected = !!active?.drive;
  const [preview, setPreview] = useState<
    | (OutboxPreview & {
        name: string;
        /** Blob URL for pdf/image content — rendered by <embed>/<img>. */
        url?: string;
      })
    | null
  >(null);

  // Blob URLs hold the file bytes alive until revoked — release on close/swap.
  useEffect(() => {
    const url = preview?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview]);
  const [drafts, setDrafts] = useState<GmailDraft[]>([]);
  const [draftsError, setDraftsError] = useState("");
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [review, setReview] = useState<GmailDraft | null>(null);

  const loadDrafts = async () => {
    if (!active || !connected) {
      setDrafts([]);
      return;
    }
    const requestedId = active.id;
    setLoadingDrafts(true);
    setDraftsError("");
    const res = await api.gmailListDrafts(requestedId);
    // Discard a response that arrived after the user switched workspaces —
    // otherwise the panel would show (and act on) another account's drafts.
    if (
      useStore.getState().workspaces.find((w) => w.active)?.id !== requestedId
    )
      return;
    if (res.error) setDraftsError(res.error);
    setDrafts(res.drafts);
    setLoadingDrafts(false);
  };

  // Load on startup/workspace change, after each run, and whenever an email
  // card saves/sends a draft — even with the panel closed, the badge must
  // reflect a just-created draft on its own.
  // The list is the set of things that should TRIGGER a reload, not everything
  // the body reads. loadDrafts is rebuilt every render, so listing it would
  // refetch forever.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps, see above
  useEffect(() => {
    if (connected && runState !== "running") void loadDrafts();
  }, [active?.id, connected, runState, draftsBump]);

  const count = files.length + drafts.length;

  return (
    <>
      <Dialog>
        <DialogTrigger
          render={
            <Button variant="outline" className="justify-start w-full">
              <Send size={14} className="text-muted-foreground" />
              Outbox
              <span
                className={cn(
                  "text-xs rounded-full px-1.5",
                  count
                    ? "bg-brand/15 text-brand"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
              {loadingDrafts && <Spinner className="ml-auto size-3.5" />}
            </Button>
          }
        />
        <DialogContent className="w-140 max-w-[92vw] sm:max-w-[92vw] gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send size={15} className="text-muted-foreground" />
              Outbox
              <span className="text-xs text-muted-foreground font-normal">
                {count} item{count === 1 ? "" : "s"}
              </span>
            </DialogTitle>
            <DialogDescription>
              Work the agent has drafted and left for you: Gmail drafts to
              review and send, and files written to{" "}
              <span className="font-mono">outbox/</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[52vh] overflow-y-auto space-y-4">
            {connected && (
              <div className="space-y-1">
                <p className="text-[0.625rem] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                  Email drafts
                  {loadingDrafts && <Spinner />}
                </p>
                {drafts.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground text-left hover:bg-muted"
                    title={`To: ${d.to} — review & send`}
                    onClick={() => {
                      setReview(d);
                    }}
                  >
                    <Mail
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="truncate flex-1">{d.subject}</span>
                    <span className="truncate max-w-[40%] text-muted-foreground">
                      {d.to}
                    </span>
                  </button>
                ))}
                {drafts.length === 0 && !loadingDrafts && !draftsError && (
                  <p className="text-xs text-muted-foreground px-0.5">
                    No email drafts.
                  </p>
                )}
                {draftsError && (
                  <p className="text-xs text-destructive">{draftsError}</p>
                )}
              </div>
            )}
            <div className="space-y-1">
              <p className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                Files
              </p>
              {files.length === 0 && (
                <p className="text-xs text-muted-foreground px-0.5">
                  No drafts waiting for review.
                </p>
              )}
              {files.map((f) => (
                <div
                  key={f.name}
                  className="relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-foreground hover:bg-muted"
                >
                  {/* The whole row opens the preview, not just the name — the
                      button's ::after overlay covers the row's padding too.
                      Archive sits above the overlay (relative), so it never
                      opens the preview. */}
                  <button
                    type="button"
                    className="truncate text-left flex-1 flex items-center gap-2 after:absolute after:inset-0"
                    title={`Preview ${f.name}`}
                    onClick={() =>
                      void api.readOutbox(f.name).then((r) => {
                        const url =
                          r.kind === "image"
                            ? URL.createObjectURL(
                                base64ToBlob(r.content, r.mime ?? ""),
                              )
                            : undefined;
                        setPreview({ name: f.name, ...r, url });
                      })
                    }
                  >
                    <FileText
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{f.name}</span>
                  </button>
                  <button
                    type="button"
                    className="relative text-muted-foreground hover:text-foreground shrink-0"
                    title="Archive (moves to outbox/archive)"
                    onClick={() => void api.archiveOutbox(f.name)}
                  >
                    <Check size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => void api.revealOutbox()}>
              Open in Finder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!preview}
        onOpenChange={(next) => {
          if (!next) setPreview(null);
        }}
      >
        <DialogContent className="w-160 max-w-[90vw] sm:max-w-[90vw] gap-3">
          <DialogHeader>
            <DialogTitle className="truncate">{preview?.name}</DialogTitle>
            <DialogDescription>
              A file the agent left in{" "}
              <span className="font-mono">outbox/</span>.
            </DialogDescription>
          </DialogHeader>
          {preview?.kind === "pdf" ? (
            <PdfPreview b64={preview.content} />
          ) : preview?.kind === "image" && preview.url ? (
            <div className="max-h-[60vh] overflow-y-auto">
              <img
                src={preview.url}
                alt={preview.name}
                className="max-w-full mx-auto rounded-md outline outline-black/10 -outline-offset-1 dark:outline-white/10"
              />
            </div>
          ) : preview?.kind === "binary" ? (
            <p className="text-sm text-muted-foreground">
              This file can’t be previewed here — use Open to view it in its
              default app.
            </p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto prose prose-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={safeMarkdownComponents}
              >
                {preview?.content ?? ""}
              </ReactMarkdown>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                if (preview) void api.archiveOutbox(preview.name);
                setPreview(null);
              }}
            >
              Archive
            </Button>
            <Button variant="secondary" onClick={() => void api.revealOutbox()}>
              Open in Finder
            </Button>
            {preview && preview.kind !== "markdown" && (
              <Button onClick={() => void api.openOutbox(preview.name)}>
                Open
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {review && active && (
        <DraftReviewModal
          draft={review}
          workspaceId={active.id}
          accountEmail={active.drive?.email ?? ""}
          onClose={() => setReview(null)}
          onDone={(removedId) => {
            setDrafts((ds) => ds.filter((d) => d.id !== removedId));
            setReview(null);
          }}
        />
      )}
    </>
  );
}

/** Rasterizes a PDF's pages onto canvases with pdf.js — the system webview
 *  (WKWebView) shows a blank box for blob/data PDFs in <embed>/<iframe>, so
 *  native PDF rendering isn't an option here. */
function PdfPreview({ b64 }: { b64: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    (async () => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdf = await getDocument({ data: bytes }).promise;
      const width = container.clientWidth || 600;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        if (cancelled) return;
        const scale = width / page.getViewport({ scale: 1 }).width;
        // Render at device resolution, display at CSS width — crisp on retina.
        const viewport = page.getViewport({
          scale: scale * (window.devicePixelRatio || 1),
        });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = "100%";
        canvas.className = "rounded-md";
        container.appendChild(canvas);
        await page.render({ canvas, viewport }).promise;
      }
    })().catch((e: unknown) => {
      if (!cancelled)
        setError(e instanceof Error ? e.message : "PDF could not be parsed.");
    });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [b64]);
  return (
    <div className="max-h-[60vh] overflow-y-auto">
      {error && (
        <p className="text-xs text-destructive">
          Couldn’t render the PDF ({error}) — use Open to view it in its default
          app.
        </p>
      )}
      <div ref={containerRef} className="space-y-2" />
    </div>
  );
}

/** Full review of one Gmail draft: recipients, subject, body — then send or
 *  discard right here. Send is two-step so a stray click can't email anyone. */
function DraftReviewModal({
  draft,
  workspaceId,
  accountEmail,
  onClose,
  onDone,
}: {
  draft: GmailDraft;
  workspaceId: string;
  accountEmail: string;
  onClose: () => void;
  onDone: (removedId: string) => void;
}) {
  // Where the dialog puts focus on open. Without this the focus trap lands on
  // the first tabbable control — "Discard draft" — and a stray Enter would
  // delete the draft outright. Send is the safe target: it is two-step, so the
  // first Enter only arms the confirmation.
  const sendRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"send" | "discard" | null>(null);
  const [error, setError] = useState("");

  const send = async () => {
    setBusy("send");
    setError("");
    const res = await api.gmailSendDraft(workspaceId, draft.id);
    setBusy(null);
    if (!res.ok) return setError(res.error ?? "Send failed.");
    onDone(draft.id);
  };

  const discard = async () => {
    setBusy("discard");
    setError("");
    const res = await api.gmailDeleteDraft(workspaceId, draft.id);
    setBusy(null);
    if (!res.ok) return setError(res.error ?? "Delete failed.");
    onDone(draft.id);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="w-160 max-w-[90vw] sm:max-w-[90vw] gap-3"
        initialFocus={sendRef}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 truncate">
            <Mail size={14} className="text-muted-foreground shrink-0" />
            {draft.subject}
          </DialogTitle>
          <DialogDescription>
            Review before sending — nothing leaves the app until you confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="pb-3 border-b border-border/60 text-xs space-y-1">
          <p>
            <span className="text-muted-foreground inline-block w-12">
              From
            </span>
            <span className="text-foreground">{accountEmail}</span>
          </p>
          <p>
            <span className="text-muted-foreground inline-block w-12">To</span>
            <span className="text-foreground">
              {draft.to || "(no recipient)"}
            </span>
          </p>
          {draft.cc && (
            <p>
              <span className="text-muted-foreground inline-block w-12">
                Cc
              </span>
              <span className="text-foreground">{draft.cc}</span>
            </p>
          )}
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">
            {draft.body || draft.snippet}
          </pre>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-xs text-destructive truncate flex-1">
              {error}
            </span>
          )}
          {!error && <span className="flex-1" />}
          <Button
            variant="destructive"
            size="sm"
            disabled={!!busy}
            onClick={() => void discard()}
          >
            {busy === "discard" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Trash2 />
            )}
            Discard draft
          </Button>
          {confirming ? (
            <Button
              ref={sendRef}
              size="sm"
              disabled={!!busy || !draft.to}
              onClick={() => void send()}
            >
              {busy === "send" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Send />
              )}
              Confirm — send to {draft.to}
            </Button>
          ) : (
            <Button
              ref={sendRef}
              size="sm"
              disabled={!draft.to}
              title={
                draft.to
                  ? undefined
                  : "Draft has no recipient — edit it in Gmail"
              }
              onClick={() => setConfirming(true)}
            >
              <Send />
              Send
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
