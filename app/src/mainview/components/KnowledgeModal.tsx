import { useEffect, useState } from "react";
import { Activity, Brain, Check, Folder, Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BrainHealth, KnowledgeDoc } from "../../shared/ipc";
import { useStore } from "../store";
import { api } from "../rpc";
import { relativeTime } from "../util";
import { safeMarkdownComponents } from "./safeMarkdown";

/** Browse what the brain knows: every knowledge doc, grouped by folder, with
 *  preview, in-app editing, reveal, and a "forget" action (trash + INDEX
 *  cleanup). The empty state doubles as the brain-health dashboard: coverage
 *  by area, last ingest, and the stalest docs to review. */
export function KnowledgeModal() {
  const open = useStore((s) => s.knowledgeOpen);
  const setOpen = useStore((s) => s.setKnowledgeOpen);
  const initialPath = useStore((s) => s.knowledgeInitialPath);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [health, setHealth] = useState<BrainHealth | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [saveError, setSaveError] = useState("");

  const reload = async () => {
    const res = await api.listKnowledge();
    setDocs(res.docs);
    setHealth(await api.brainHealth());
  };

  // `open` is the only trigger — this is the modal's on-open reset. reload and
  // openDoc are rebuilt every render, so listing them would re-run this on
  // every render instead of only when the modal opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps, see above
  useEffect(() => {
    if (open) {
      void reload();
      setEditing(false);
      setConfirmingForget(false);
      // Deep-link from a clicked citation, else start on the health overview.
      if (initialPath) {
        void openDoc(initialPath);
      } else {
        setSelected(null);
        setContent("");
      }
    }
  }, [open, initialPath]);

  const byFolder = new Map<string, KnowledgeDoc[]>();
  for (const d of docs) {
    const folder = d.path.includes("/") ? d.path.split("/")[0] : "(root)";
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), d]);
  }

  const openDoc = async (path: string) => {
    setSelected(path);
    setEditing(false);
    setConfirmingForget(false);
    setSaveError("");
    const res = await api.readKnowledge(path);
    setContent(res.content);
  };

  const doForget = async (path: string) => {
    setConfirmingForget(false);
    await api.forgetKnowledge(path);
    setSelected(null);
    setContent("");
    void reload();
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaveError("");
    const res = await api.writeKnowledge(selected, draft);
    if (!res.ok) return setSaveError(res.error ?? "Could not save.");
    setContent(draft);
    setEditing(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[900px] max-w-[94vw] sm:max-w-[94vw] h-[80vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <div className="flex items-center px-6 py-4 border-b border-border shrink-0">
          <DialogTitle className="text-lg font-semibold">
            <Brain size={18} className="inline mr-1.5 -mt-1" />
            Knowledge{" "}
            <span className="text-muted-foreground text-sm font-normal">
              ({docs.length} documents)
            </span>
          </DialogTitle>
        </div>
        <div className="flex-1 flex min-h-0">
          <div className="w-72 shrink-0 border-r border-border overflow-y-auto p-3 space-y-3">
            {docs.length === 0 && (
              <p className="text-xs text-muted-foreground">
                The brain is empty. Drop files on the window or sync a Drive
                folder to start feeding it.
              </p>
            )}
            {[...byFolder.entries()].map(([folder, files]) => (
              <div key={folder}>
                <p className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground mb-1">
                  <Folder size={11} className="inline mr-1 -mt-px" />
                  {folder}
                </p>
                {files.map((f) => (
                  <button
                    type="button"
                    key={f.path}
                    className={cn(
                      "block w-full text-left px-2 py-1 rounded text-xs truncate",
                      selected === f.path
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                    title={f.path}
                    onClick={() => void openDoc(f.path)}
                  >
                    {f.path.split("/").pop()}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            {selected ? (
              <>
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    {selected}
                  </span>
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="px-2 py-1 rounded-md bg-success/15 text-xs text-success transition-colors hover:bg-success/25"
                        onClick={() => void saveEdit()}
                      >
                        <Check size={11} className="inline -mt-px mr-0.5" />
                        Save
                      </button>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => {
                          setEditing(false);
                          setSaveError("");
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : confirmingForget ? (
                    <>
                      <span className="text-xs text-destructive">
                        Move to Trash?
                      </span>
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => void doForget(selected)}
                      >
                        Forget
                      </Button>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => setConfirmingForget(false)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => {
                          setDraft(content);
                          setEditing(true);
                        }}
                      >
                        <Pencil size={11} />
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => void api.revealKnowledge(selected)}
                      >
                        Finder
                      </Button>
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => setConfirmingForget(true)}
                      >
                        Forget…
                      </Button>
                    </>
                  )}
                </div>
                {saveError && (
                  <p className="px-4 py-1 text-xs text-destructive">
                    {saveError}
                  </p>
                )}
                {editing ? (
                  <textarea
                    className="flex-1 m-4 mt-3 bg-background border border-border rounded-lg p-3 font-mono text-xs text-foreground resize-none focus:outline-none focus:border-brand"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                  />
                ) : (
                  <div className="flex-1 overflow-y-auto p-5 prose prose-sm max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={safeMarkdownComponents}
                    >
                      {content}
                    </ReactMarkdown>
                  </div>
                )}
              </>
            ) : (
              <BrainHealthPanel
                health={health}
                onOpen={(p) => void openDoc(p)}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Staleness is the brain's silent killer — surface it where curation happens. */
function BrainHealthPanel({
  health,
  onOpen,
}: {
  health: BrainHealth | null;
  onOpen: (path: string) => void;
}) {
  if (!health || health.totalDocs === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Select a document to preview it
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-sm font-semibold text-foreground mb-3">
        <Activity size={14} className="inline mr-1.5 -mt-px text-brand" />
        Brain health
      </h2>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {health.byFolder.map((f) => (
          <span
            key={f.folder}
            className="text-[0.6875rem] bg-muted rounded-full px-2.5 py-1 text-foreground"
          >
            {f.folder} <span className="text-muted-foreground">{f.count}</span>
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        {health.totalDocs} documents · last ingest{" "}
        {health.lastIngestMs
          ? relativeTime(new Date(health.lastIngestMs).toISOString())
          : "never"}
      </p>
      <p className="text-xs text-muted-foreground mb-1.5">
        Stalest documents — worth a review pass (facts rot quietly):
      </p>
      <div className="space-y-1">
        {health.stalest.map((d) => (
          <button
            type="button"
            key={d.path}
            className="w-full flex items-baseline gap-2 px-2 py-1 rounded text-left hover:bg-muted"
            onClick={() => onOpen(d.path)}
          >
            <span className="text-xs text-foreground truncate flex-1">
              {d.path}
            </span>
            <span className="text-[0.625rem] text-muted-foreground shrink-0">
              {relativeTime(new Date(d.mtimeMs).toISOString())}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
