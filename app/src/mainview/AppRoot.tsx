import { useEffect, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, refreshOllama, refreshSidebar } from "./rpc";
import { zoomIn, zoomOut, zoomReset } from "./lib/zoom";
import { useStore } from "./store";
import { ChatPane } from "./components/ChatPane";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { Sidebar } from "./components/Sidebar";
import { FileDropOverlay } from "./components/FileDropOverlay";
import { SettingsPage } from "./components/SettingsPage";
import { KnowledgeModal } from "./components/KnowledgeModal";
import { AboutDialog } from "./components/AboutDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

/** Sidebar width, in px. Persisted separately from the collapsed flag so
 *  collapse → expand returns to the width you had, and so a width dragged to
 *  zero never becomes the remembered width. */
const WIDTH_KEY = "monad-sidebar-width";
const DEFAULT_WIDTH = 288; // the pre-resize w-72
// The floor is set by the brand bar: the wordmark starts at --titlebar-content-x
// (120px), so anything much under this leaves it no room before the panel edge.
const MIN_WIDTH = 250;
const MAX_WIDTH = 460;
/** Keep in step with the transition in index.css (.panels-animating). */
const SLIDE_MS = 220;

function loadWidth(): number {
  const px = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(px) && px >= MIN_WIDTH && px <= MAX_WIDTH
    ? px
    : DEFAULT_WIDTH;
}

/** The one sidebar control, parked over the traffic-light strip at a fixed
 *  offset so it holds its place whichever pane is underneath — open, it sits on
 *  the sidebar's brand bar; closed, on the chat pane's header. Only the icon and
 *  the action change. z-30 keeps it under the settings page (z-40) and dialogs
 *  (z-50), which are meant to cover it. */
function SidebarToggle() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const Icon = collapsed ? PanelLeft : PanelLeftClose;
  return (
    <Button
      size="icon-sm"
      variant="link"
      // Geometry pinned in px (top/size on the button, size on the icon):
      // this control lines up with the system-drawn traffic lights, which
      // don't follow the UI zoom — so unlike everything else it must not
      // either. The px classes override the rem sizing (size-7, [&_svg]:size-4)
      // this button would otherwise get, which now rides the zoom.
      className="fixed top-[10px] left-(--titlebar-toggle-x) size-[28px] z-30 text-muted-foreground hover:text-foreground hover:bg-secondary! electrobun-webkit-app-region-no-drag"
      title={collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
      aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
      aria-expanded={!collapsed}
      onClick={() => useStore.getState().toggleSidebar()}
    >
      {/* 16px, not 15: the button's [&_svg]:size-4 forcing always overrode
          the old size={15} attribute, so 16px is what it has always been. */}
      <Icon className="size-[16px]" />
    </Button>
  );
}

export default function AppRoot() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const sidebarPanel = usePanelRef();
  const groupEl = useRef<HTMLDivElement | null>(null);
  // onResize reports every intermediate width, including the ones a slide
  // passes through. Those are not the user collapsing or expanding anything —
  // reading them back into the store mid-slide flips the flag and springs the
  // panel straight back to where it started.
  const sliding = useRef(false);
  // Read once, at mount: a window that was closed collapsed opens collapsed,
  // with no first-frame flash of a full-width sidebar.
  const [initialWidth] = useState(() =>
    useStore.getState().sidebarCollapsed ? 0 : loadWidth(),
  );
  // Sidebar contents are dropped from the tab order only once it has finished
  // closing — hiding them the instant the flag flips would blank the pane and
  // leave an empty box to slide away.
  const [contentHidden, setContentHidden] = useState(initialWidth === 0);
  // While sliding, the aside holds the width it is sliding to/from, so its
  // contents are clipped by the panel rather than reflowing every frame.
  const [slideWidth, setSlideWidth] = useState<number | null>(null);

  useEffect(() => {
    void refreshSidebar();
    // Settings drive the composer's model list (cloud vs local mode); in
    // local mode the dropdown also needs the installed-model list.
    void api.getSettings().then((s) => {
      if (s.authMode === "local-ollama") void refreshOllama();
    });
  }, []);

  // ⌘B mirrors the sidebar toggle in every other Mac app. Registered here, not
  // in Sidebar, so it still fires while the sidebar is collapsed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "b" && e.metaKey) {
        // Claimed, or AppKit answers the unhandled key with the alert beep.
        e.preventDefault();
        useStore.getState().toggleSidebar();
      }
      // ⌘+/⌘−/⌘0 zoom, handled here rather than only via the View-menu
      // accelerators: WebKit gives the page first claim on ⌘-key equivalents,
      // and preventDefault stops the menu item from firing a second time.
      // "+" covers ⌘⇧= and numpad plus; the menu path (mouse clicks) arrives
      // through the zoomCommand RPC message instead.
      if (e.metaKey && !e.altKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
      } else if (e.metaKey && !e.altKey && e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if (e.metaKey && e.key === "0") {
        e.preventDefault();
        zoomReset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The store owns "is it collapsed?"; the panel owns the width. Driving the
  // panel from the flag (rather than calling collapse/expand at each click
  // site) keeps the two in sync no matter what moved first.
  useEffect(() => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    // A drag already put the panel where the flag says it should be; there is
    // nothing to animate, just settle the contents.
    if (collapsed === panel.isCollapsed()) {
      setContentHidden(collapsed);
      return;
    }
    const width = loadWidth();
    sliding.current = true;
    setSlideWidth(width);
    setContentHidden(false);
    // classList, not a React class, and deliberately so: the panel writes its
    // new flex-grow synchronously on the next line, and a state update would
    // not reach the DOM until after that — leaving the transition nothing to
    // interpolate from.
    groupEl.current?.classList.add("panels-animating");
    if (collapsed) panel.collapse();
    // Not expand(): that restores the panel's own remembered size, which is
    // unset when the window opened collapsed. The persisted width always is.
    else panel.resize(width);
    const timer = setTimeout(() => {
      sliding.current = false;
      groupEl.current?.classList.remove("panels-animating");
      setContentHidden(collapsed);
      setSlideWidth(null);
    }, SLIDE_MS);
    return () => {
      clearTimeout(timer);
      sliding.current = false;
      groupEl.current?.classList.remove("panels-animating");
    };
  }, [collapsed, sidebarPanel]);

  return (
    <div className="h-screen flex bg-background text-foreground antialiased">
      <ResizablePanelGroup
        elementRef={groupEl}
        orientation="horizontal"
        onLayoutChanged={() => {
          // Group-level: fires on pointer release, not per pointermove, so
          // the width is written once per drag instead of once per frame.
          const px = sidebarPanel.current?.getSize().inPixels ?? 0;
          if (px >= MIN_WIDTH)
            localStorage.setItem(WIDTH_KEY, String(Math.round(px)));
        }}
      >
        <ResizablePanel
          id="sidebar"
          panelRef={sidebarPanel}
          defaultSize={initialWidth}
          minSize={MIN_WIDTH}
          maxSize={MAX_WIDTH}
          collapsible
          collapsedSize={0}
          // The chat pane is the one that gives and takes when the window
          // resizes; the sidebar holds the width you set.
          groupResizeBehavior="preserve-pixel-size"
          // style, not a class: the library writes overflow:auto inline on
          // this element, and inline wins over any className we pass.
          style={{ overflow: "hidden" }}
          onResize={({ inPixels }) => {
            if (sliding.current) return;
            useStore.getState().setSidebarCollapsed(inPixels < 1);
          }}
        >
          <Sidebar contentHidden={contentHidden} frozenWidth={slideWidth} />
        </ResizablePanel>
        {/* Doubles as the sidebar's right border, so the aside no longer
				    draws its own. after:w-2 widens the grab target past the 1px
				    line; collapsed, the line itself would just be a stray rule
				    down the window edge, so only the target survives. */}
        <ResizableHandle
          className={cn(
            "after:w-2 transition-colors hover:bg-brand/70 active:bg-brand",
            collapsed ? "bg-transparent" : "bg-border",
          )}
        />
        <ResizablePanel
          id="main"
          // relative: the settings page is absolutely positioned against this
          // panel, so it covers the chat without covering the sidebar.
          className="flex relative"
          style={{ overflow: "hidden" }}
        >
          <ErrorBoundary label="chat">
            <ChatPane />
          </ErrorBoundary>
          <ErrorBoundary label="artifact panel">
            <ArtifactPanel />
          </ErrorBoundary>
          {/* Covers this panel only — the sidebar stays live beside it and
					    swaps to the settings nav. Chat state stays mounted underneath so
					    closing returns to exactly where you were. */}
          <ErrorBoundary label="settings">
            <SettingsPage />
          </ErrorBoundary>
        </ResizablePanel>
      </ResizablePanelGroup>
      <SidebarToggle />
      <FileDropOverlay />
      <KnowledgeModal />
      <AboutDialog />
    </div>
  );
}
