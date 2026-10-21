import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AppWindow,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Shapes,
  Workflow,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThinkingOrb } from "thinking-orbs";
import type { WebviewTagElement } from "electrobun/view";
import type { ArtifactType } from "../../shared/ipc";
import { buildArtifactShell } from "../artifactShell";
import { useResolvedScheme, useThemeId } from "../lib/theme";
import { useStore } from "../store";
import { api } from "../rpc";
import { safeMarkdownComponents } from "./safeMarkdown";

export const ARTIFACT_ICONS: Record<ArtifactType, typeof AppWindow> = {
  html: AppWindow,
  svg: Shapes,
  mermaid: Workflow,
  markdown: FileText,
};

/** The mermaid runtime (~2.7 MB) must be inlined into the sandbox shell (its
 *  CSP forbids loading scripts any other way), but it would bloat the main
 *  bundle — so it's a lazy chunk fetched the first time a mermaid artifact
 *  renders, then cached for the session. */
let mermaidJsCache: string | null = null;
function useMermaidJs(enabled: boolean): string | null {
  const [js, setJs] = useState(mermaidJsCache);
  useEffect(() => {
    if (!enabled || mermaidJsCache) return;
    void import("mermaid/dist/mermaid.min.js?raw").then((m) => {
      mermaidJsCache = m.default;
      setJs(m.default);
    });
  }, [enabled]);
  return js;
}

/** Run cb once the element's native webview exists. The custom element's init
 *  is async (rAF + an RPC round-trip to bun), so webviewId is null at first.
 *  Electrobun's init request times out after 10s; the deadline covers the case
 *  where it failed outright and the id will never arrive. */
function whenReady(
  wv: WebviewTagElement,
  cb: () => void,
  deadlineMs = 15_000,
): void {
  if (wv.webviewId != null || deadlineMs <= 0) cb();
  else setTimeout(() => whenReady(wv, cb, deadlineMs - 50), 50);
}

/** Renders untrusted artifact markup in a sandboxed native webview: the
 *  `sandbox` attribute severs Electrobun's RPC bridge, and the shell's CSP
 *  (see artifactShell.ts) blocks all network access.
 *
 *  Lifecycle care, learned the hard way: the native view is created async, and
 *  Electrobun only destroys it on element removal when webviewId is already
 *  set — removing earlier (StrictMode's double-mount, tab switches) leaks an
 *  orphaned native view painted over the window. So this component keeps ONE
 *  element alive for its whole lifetime, swaps content via the html attribute
 *  (→ loadHTML), waits for the native id before teardown, and uses
 *  toggleHidden for visibility (native views composite over the DOM — CSS
 *  cannot hide them). */
function SandboxFrame({ html, hidden }: { html: string; hidden: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wvRef = useRef<WebviewTagElement | null>(null);
  const htmlRef = useRef(html);
  const hiddenRef = useRef(hidden);
  htmlRef.current = html;
  hiddenRef.current = hidden;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // Created imperatively so the sandbox attribute is guaranteed present
    // before the custom element initializes its native webview.
    const wv = document.createElement(
      "electrobun-webview",
    ) as WebviewTagElement;
    wv.setAttribute("sandbox", "");
    wv.setAttribute("html", htmlRef.current);
    // background overrides Electrobun's injected white default; the token
    // matches the shell's canvas so load never flashes a foreign color.
    wv.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;background:var(--card);";
    host.appendChild(wv);
    wvRef.current = wv;
    whenReady(wv, () => {
      if (disposed) return;
      // Re-apply the latest state — prop changes may have raced the init.
      if (wv.getAttribute("html") !== htmlRef.current)
        wv.setAttribute("html", htmlRef.current);
      wv.toggleHidden(hiddenRef.current);
      // A hidden native view can still swallow wheel/mouse input (it sits
      // above the window content) — passthrough hands events back to the
      // DOM underneath, e.g. the scrollable Source view.
      wv.togglePassthrough(hiddenRef.current);
    });
    return () => {
      disposed = true;
      // Never remove before the native view exists — that orphans it.
      whenReady(wv, () => wv.parentNode?.removeChild(wv));
    };
  }, []);

  useEffect(() => {
    const wv = wvRef.current;
    // Attribute change triggers loadHTML once the native view is live;
    // pre-init changes are picked up by the whenReady above.
    if (wv && wv.webviewId != null && wv.getAttribute("html") !== html) {
      wv.setAttribute("html", html);
    }
  }, [html]);

  useEffect(() => {
    const wv = wvRef.current;
    if (wv && wv.webviewId != null) {
      wv.toggleHidden(hidden);
      wv.togglePassthrough(hidden);
    }
  }, [hidden]);

  return <div ref={hostRef} className="absolute inset-0" />;
}

export function ArtifactPanel() {
  const open = useStore((s) => s.artifactPanelOpen);
  const active = useStore((s) => s.activeArtifact);
  const artifacts = useStore((s) => s.artifacts);
  // Native webviews composite OVER the DOM — hide the preview while a modal
  // is open so it can't paint on top of the dialog.
  const settingsOpen = useStore((s) => s.settingsOpen);
  const knowledgeOpen = useStore((s) => s.knowledgeOpen);
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);

  const art = active ? artifacts[active.id] : undefined;
  const mermaidJs = useMermaidJs(art?.type === "mermaid");
  // Re-render (→ shell rebuild → webview reload) on any appearance change.
  const themeId = useThemeId();
  const resolved = useResolvedScheme();
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeId is the trigger — the CSS variables read here change with it.
  const look = useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    return {
      bg: css.getPropertyValue("--card").trim(),
      fg: css.getPropertyValue("--foreground").trim(),
      dark: resolved === "dark",
    };
  }, [themeId, resolved]);
  if (!open || !active || !art) return null;

  const version = Math.min(active.version, art.versions.length - 1);
  const content = art.versions[version];
  const Icon = ARTIFACT_ICONS[art.type];
  const modalOpen = settingsOpen || knowledgeOpen;

  const step = (delta: number) =>
    useStore.getState().openArtifact(active.id, version + delta);

  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="w-[44%] min-w-[380px] max-w-[760px] shrink-0 flex flex-col border-l border-border bg-background">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
        <Icon size={14} className="text-brand shrink-0" />
        <h2
          className="text-sm font-medium text-foreground truncate flex-1"
          title={art.title}
        >
          {art.title}
        </h2>
        <div className="flex rounded-lg border border-border overflow-hidden text-xs shrink-0">
          {(["preview", "source"] as const).map((t) => (
            <button
              type="button"
              key={t}
              className={cn(
                "px-2.5 py-1 capitalize",
                tab === t
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground shrink-0"
          title="Close panel"
          onClick={() => useStore.getState().closeArtifactPanel()}
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden relative">
        {art.type === "markdown" ? (
          tab === "source" ? (
            <pre className="h-full overflow-auto text-xs text-foreground/90 bg-muted/30 px-4 py-3 whitespace-pre-wrap break-words">
              {content}
            </pre>
          ) : (
            <div className="h-full overflow-y-auto px-5 py-4 prose prose-sm max-w-none prose-pre:bg-background">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={safeMarkdownComponents}
              >
                {content}
              </ReactMarkdown>
            </div>
          )
        ) : art.type === "mermaid" && !mermaidJs ? (
          <div className="h-full flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <ThinkingOrb state="working" size={20} aria-hidden />
            Loading diagram renderer…
          </div>
        ) : (
          <>
            {/* One persistent webview — content swaps in place, visibility is
						    native (toggleHidden), so tab/dialog churn never re-creates it. */}
            <SandboxFrame
              html={buildArtifactShell(
                art.type,
                content,
                art.type === "mermaid" ? (mermaidJs ?? undefined) : undefined,
                look,
              )}
              hidden={tab !== "preview" || modalOpen}
            />
            {tab === "source" && (
              <pre className="absolute inset-0 overflow-auto text-xs text-foreground/90 bg-background px-4 py-3 whitespace-pre-wrap break-words">
                {content}
              </pre>
            )}
            {tab === "preview" && modalOpen && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground bg-background">
                Preview paused while a dialog is open
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-1 px-3 py-2 border-t border-border shrink-0 text-xs">
        {art.versions.length > 1 && (
          <span className="flex items-center gap-0.5 text-muted-foreground mr-1">
            <button
              type="button"
              className="disabled:opacity-30 hover:text-foreground"
              disabled={version === 0}
              title="Previous version"
              onClick={() => step(-1)}
            >
              <ChevronLeft size={14} />
            </button>
            v{version + 1}/{art.versions.length}
            <button
              type="button"
              className="disabled:opacity-30 hover:text-foreground"
              disabled={version === art.versions.length - 1}
              title="Next version"
              onClick={() => step(1)}
            >
              <ChevronRight size={14} />
            </button>
          </span>
        )}
        <button
          type="button"
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Copy source"
          onClick={() => void copy()}
        >
          {copied ? (
            <Check size={12} className="text-success" />
          ) : (
            <Copy size={12} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Reveal the file in Finder (artifacts/ in this workspace)"
          onClick={() => void api.revealArtifact(active.id)}
        >
          <FolderOpen size={12} /> Reveal
        </button>
        {/* No "Open" for html/svg: the OS would hand the raw file to the
				    browser — outside the sandbox and the shell's CSP, with full
				    network. Markdown/mermaid open in a text editor and stay inert;
				    Reveal covers the deliberate-export case for everything else. */}
        {(art.type === "markdown" || art.type === "mermaid") && (
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open the latest saved file with the default app"
            onClick={() => void api.openArtifactFile(active.id)}
          >
            <ExternalLink size={12} /> Open
          </button>
        )}
        <span className="flex-1" />
        <span className="text-muted-foreground/70">{art.type}</span>
      </div>
    </div>
  );
}
