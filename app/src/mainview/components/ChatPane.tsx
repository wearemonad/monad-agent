/** biome-ignore-all lint/a11y/useButtonType: there is no <form> in this view, so
 *  no button here can default to submitting one — they are all click targets. */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  BookmarkPlus,
  Brain,
  ChevronDown,
  FileText,
  Folder,
  Image as ImageIcon,
  InfoIcon,
  Link2,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { ChatItem, SkillInfo } from "../../shared/ipc";
import { useStore } from "../store";
import { api } from "../rpc";
import { useSmoothText } from "../lib/smoothText";
import { ActivityGroup, type ActivityItem } from "./ToolCallCard";
import { ARTIFACT_ICONS } from "./ArtifactPanel";
import { EmailDraftCard } from "./EmailDraftCard";
import { PermissionCards } from "./PermissionCards";
import { safeMarkdownComponents } from "./safeMarkdown";
import { bytesToBase64, fmtTokens } from "../util";
import { choiceKey, contextWindowFor, isPickedModel } from "../lib/models";
import { cn } from "@/lib/utils";
import { ModelPicker } from "./ModelPicker";
import { RunOptionsPicker } from "./RunOptionsPicker";
import { PermissionsChip } from "./PermissionsChip";
import { DeleteThreadConfirm } from "./DeleteThreadConfirm";
import { ClaudeLoginCard } from "./ClaudeLoginCard";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";

// Registered by the Composer so empty-state / palette actions can refocus it.
let focusComposer: (() => void) | null = null;

/** A runnable starter the user can extend before sending. Manual-only skills
 *  (disable-model-invocation) must go out as a real "/name" command — the CLI
 *  expands that as a user invocation, while the agent's own Skill tool is
 *  refused for them, so "use the X skill" prose would dead-end. */
function starterFor(skill: SkillInfo): string {
  return skill.manualOnly
    ? `/${skill.name} `
    : `Use the "${skill.name}" skill: `;
}

/** The leading definition of a skill description, before its "Use when …" triggers. */
function skillBlurb(description: string): string {
  const beforeUse = description.split(/\s*Use when/i)[0].trim();
  const period = beforeUse.indexOf(". ");
  return period > 0 ? beforeUse.slice(0, period + 1) : beforeUse;
}

/** A pasted or picked file saved as transient chat context (not ingested
 *  into the brain). Images carry a thumbnail — a blob: URL (paste) or a data:
 *  URL (picker); other files (PDFs, spreadsheets, docs…) show a file icon. */
type Attachment = { name: string; path: string; previewUrl?: string };

/** Files one message may carry — pasted and picked combined. */
const MAX_ATTACHMENTS = 8;

export function ChatPane() {
  // Messages and Composer overlap: the composer floats over the scroll area
  // so messages flow underneath it, showing through its glass background.
  // isolate: the composer/gradient z-indexes order layers WITHIN the chat
  // only — without it they'd escape and beat sibling overlays (settings, z-10).
  return (
    <div className="flex-1 flex flex-col min-w-0 isolate">
      <TopBar />
      <div className="relative flex-1 min-h-0">
        <div className="absolute h-12 from-4% top-0 left-0 right-0 bg-linear-to-b from-background to-transparent z-20" />
        <div className="absolute h-12 bottom-0 left-0 right-0 bg-linear-to-t from-background from-4% to-transparent z-10" />
        <Messages />
        <Composer />
      </div>
    </div>
  );
}

/** Quiet top-right chip: background work (ingest, scheduled jobs, prep) no
 *  longer blocks the chat, so this loader — next to the workspace and New
 *  chat buttons — is its one indicator, with a stop affordance on board. */
function BackgroundActivityChip() {
  const ingest = useStore((s) => s.ingest);
  const backgroundRun = useStore((s) => s.backgroundRun);
  if (!ingest.active && !backgroundRun) return null;
  const label = ingest.active
    ? `Ingesting ${ingest.files.length} file${ingest.files.length === 1 ? "" : "s"}`
    : (backgroundRun?.label ?? "Background run");
  const detail = ingest.active
    ? `Ingesting in the background: ${ingest.files.join(", ")} — results land in Review`
    : `"${backgroundRun?.label}" is running in the background`;
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0 rounded-full border border-border bg-muted/40 pl-2.5 pr-1.5 py-1 electrobun-webkit-app-region-no-drag"
      title={detail}
    >
      <Loader2 size={12} className="animate-spin text-warning" />
      {label}
      <button
        type="button"
        className="p-0.5 rounded text-muted-foreground hover:text-destructive"
        title="Stop this background run"
        onClick={() =>
          void (ingest.active ? api.stopIngest() : api.abortBackgroundRun())
        }
      >
        <Square size={9} fill="currentColor" />
      </button>
    </span>
  );
}

function TopBar() {
  const workspaces = useStore((s) => s.workspaces);
  const sessions = useStore((s) => s.sessions);
  const resumeSessionId = useStore((s) => s.resumeSessionId);
  const items = useStore((s) => s.items);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const active = workspaces.find((w) => w.active);
  // Keyed by session so the strip drops away by itself when the open thread
  // changes underneath it (⌘N, sidebar click, or the delete swapping in a
  // fresh chat).
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);

  const current = sessions.find((t) => t.sessionId === resumeSessionId);
  const confirmingDelete = !!current && confirmingFor === current.sessionId;
  const setConfirmingDelete = (on: boolean) =>
    setConfirmingFor(on ? (current?.sessionId ?? null) : null);
  const firstUser = items.find((i) => i.type === "user");
  const title =
    current?.title ??
    (firstUser?.type === "user" ? firstUser.text.slice(0, 60) : null) ??
    "New thread";

  return (
    // Collapsed, this bar slides under the traffic lights and the fixed sidebar
    // toggle, so it indents to where they end. Expanded, the sidebar is holding
    // that space and the bar starts at its own edge.
    <div
      // h-10, matching the sidebar's brand bar: with the toggle pinned to the
      // traffic-light line, this row has to sit on that line too or the two
      // read as misaligned the moment the sidebar closes and they become
      // neighbours.
      className={cn(
        "flex items-center gap-2 h-12 pr-3 shrink-0 electrobun-webkit-app-region-drag",
        sidebarCollapsed ? "pl-(--titlebar-content-x)" : "pl-4",
      )}
    >
      <div className="flex-1 flex items-center gap-2">
        {!!active?.drive?.folders?.length && (
          <>
            <button
              onClick={() => void api.revealInbox()}
              className="text-sm font-medium text-foreground/60 hover:text-foreground transition-colors flex gap-2 items-center truncate electrobun-webkit-app-region-no-drag"
              title={`Drive folder${active.drive.folders.length > 1 ? "s" : ""} ${active.drive.folders
                .map((f) => `“${f.name}”`)
                .join(", ")} sync into inbox/ — click to show in Finder`}
            >
              <Folder size={12} />
              {active.drive.folders.length === 1
                ? active.drive.folders[0].name
                : `${active.drive.folders.length} folders`}
            </button>
            /
          </>
        )}
        <h1
          className="text-sm font-medium text-foreground truncate"
          title={title}
        >
          {title}
        </h1>
      </div>
      <BackgroundActivityChip />
      {current && confirmingDelete ? (
        // Same strip as the sidebar row, swapped in for the header actions.
        <DeleteThreadConfirm
          thread={current}
          onClose={() => setConfirmingDelete(false)}
          className="max-w-72 electrobun-webkit-app-region-no-drag"
        />
      ) : (
        <>
          {active && (
            <Button
              size="xs"
              variant="outline"
              className="electrobun-webkit-app-region-no-drag"
              title={active.path}
              onClick={() => useStore.getState().setSettingsOpen(true)}
            >
              <Brain />
              {active.name}
            </Button>
          )}
          <Button
            size="xs"
            className="electrobun-webkit-app-region-no-drag"
            onClick={() => useStore.getState().newChat()}
          >
            <Plus />
            New chat
          </Button>
          {/* Only a saved thread can be deleted; a fresh chat has nothing on
              disk yet. Deleting mid-stream is allowed (deleteSession aborts
              the run first), matching the sidebar. */}
          {current && (
            <Button
              size="icon-sm"
              variant="destructive"
              className="text-muted-foreground hover:text-destructive electrobun-webkit-app-region-no-drag"
              title="Delete thread"
              aria-label="Delete thread"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 />
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** The gallery stays a shop window, not an inventory: a big imported pack
 *  would otherwise fill the whole New Chat screen. Only the app's own
 *  (system) skills get cards; imported ones live in the "/" palette. A
 *  workspace with no system skills falls back to a capped list. */
const GALLERY_MAX = 8;

/** Empty-state skill gallery — makes the workspace's skills visible and one-click runnable. */
function EmptyState() {
  const enabled = useStore((s) => s.skills).filter(
    (s) => s.enabled && s.userInvocable,
  );
  const system = enabled.filter((s) => s.system);
  const skills = (system.length > 0 ? system : enabled).slice(0, GALLERY_MAX);
  const more = enabled.length - skills.length;
  if (skills.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground text-sm">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }
  const pick = (skill: SkillInfo) => {
    useStore.getState().setComposerDraft(starterFor(skill));
    focusComposer?.();
  };
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
      <p className="text-muted-foreground text-sm">
        What this brain can do — click one, or type{" "}
        <kbd className="text-[0.625rem] bg-muted rounded px-1.5 py-0.5">/</kbd>{" "}
        in the composer:
      </p>
      <div className="grid grid-cols-2 gap-2 max-w-2xl w-full">
        {skills.map((s) => (
          // The key belongs on the mapped element itself — a fragment wrapper
          // here swallowed it and React warned on every render.
          <button
            key={s.name}
            type="button"
            onClick={() => pick(s)}
            className="text-left rounded-xl border border-border bg-muted/40 hover:bg-muted px-3.5 py-2.5 transition-[background-color,scale] duration-150 ease-out motion-safe:active:scale-[0.96]"
          >
            <div className="flex items-center gap-1.5 text-foreground text-[0.8125rem] font-medium">
              <Sparkles size={12} className="shrink-0" />
              {s.name}
            </div>
            <p className="text-[0.6875rem] text-muted-foreground mt-0.5 line-clamp-2">
              {skillBlurb(s.description)}
            </p>
          </button>
        ))}
      </div>
      {more > 0 && (
        <p className="text-[0.6875rem] text-muted-foreground">
          …and {more} more — type{" "}
          <kbd className="text-[0.625rem] bg-muted rounded px-1.5 py-0.5">
            /
          </kbd>{" "}
          in the composer to browse them all.
        </p>
      )}
    </div>
  );
}

/** Save this message's text into the knowledge base (closes the chat → brain loop). */
function RememberButton({
  text,
  align,
}: {
  text: string;
  /** Which edge to hug — the message's own side, not the transcript's. */
  align: "start" | "end";
}) {
  const [saved, setSaved] = useState(false);
  const onClick = async () => {
    const res = await api.rememberText(text);
    if ("path" in res && res.path) {
      setSaved(true);
      useStore
        .getState()
        .push({ type: "info", text: `Remembered → knowledge/${res.path}` });
    } else if ("error" in res && res.error) {
      useStore.getState().push({ type: "info", text: res.error });
    }
  };

  return (
    <Button
      variant="link"
      size="xs"
      onClick={onClick}
      title="Save this to the knowledge base"
      // Dimmed rather than hidden. A hover-revealed control depends on the
      // webview delivering a mouseout for every mouseover, and WKWebView
      // doesn't — the button latched visible and flickered as the pointer
      // crossed it. An opacity-0 control is also still clickable, so the
      // "hidden" version left an invisible hit target under the cursor.
      className={cn(
        "hover:no-underline p-0 transition-colors",
        align === "end" ? "self-end" : "self-start",
        saved
          ? "text-muted-foreground"
          : "text-muted-foreground/45 hover:text-foreground",
      )}
    >
      <BookmarkPlus size={12} /> {saved ? "Remembered" : "Remember"}
    </Button>
  );
}

/** Assistant markdown with clickable citations: inline `path.md` that matches a
 *  known knowledge doc opens it in the preview modal. Memoized: parsing is the
 *  expensive part of a transcript render, and a completed message's text never
 *  changes — only the streaming tail should ever re-parse. */
const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
}: {
  text: string;
}) {
  const knowledgePaths = useStore((s) => s.knowledgePaths);
  const pathSet = useMemo(() => new Set(knowledgePaths), [knowledgePaths]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        ...safeMarkdownComponents,
        code({ node, className, children, ...props }) {
          // v9 has no `inline` flag: fenced blocks carry a language-* class.
          void node;
          const isBlock = /\blanguage-/.test(className ?? "");
          if (!isBlock) {
            const rel = String(children)
              .trim()
              .replace(/^knowledge\//, "")
              .replace(/^\.\//, "");
            if (pathSet.has(rel)) {
              return (
                <button
                  className="citation text-brand underline decoration-dotted underline-offset-2 hover:text-brand"
                  title={`Open knowledge/${rel}`}
                  onClick={() => useStore.getState().openKnowledgeAt(rel)}
                >
                  {children}
                </button>
              );
            }
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

/** Transcript blocks: consecutive tool calls + reasoning fold into one
 *  activity accordion (keyed by the run's first entry so its open/closed
 *  state survives streaming appends); everything else renders on its own. */
type MessageBlock =
  | { kind: "activity"; key: string; entries: ActivityItem[] }
  | {
      kind: "item";
      key: string;
      item: Exclude<ChatItem, { type: "tool" | "thinking" }>;
      /** For a login-needed card: the user message whose run failed, so
       *  the card can offer to send it again once signed in. */
      retryPrompt?: string;
    };

function toBlocks(items: ChatItem[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  items.forEach((item, i) => {
    if (item.type === "tool" || item.type === "thinking") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "activity") last.entries.push(item);
      else
        blocks.push({
          kind: "activity",
          key: `activity-${i}`,
          entries: [item],
        });
    } else if (item.type === "login-needed") {
      const lastUser = items
        .slice(0, i)
        .reverse()
        .find((it) => it.type === "user");
      blocks.push({
        kind: "item",
        key: `item-${i}`,
        item,
        ...(lastUser?.type === "user" ? { retryPrompt: lastUser.text } : {}),
      });
    } else {
      blocks.push({ kind: "item", key: `item-${i}`, item });
    }
  });
  return blocks;
}

/** An image the agent generated, shown from where the harness left it (the
 *  transcript stores only its path). Nothing is copied unless the user
 *  saves it. */
function GeneratedImage({ path, name }: { path: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.readChatImage(path).then((res) => {
      if (!live) return;
      if (res.dataUrl) setSrc(res.dataUrl);
      else setMissing(true);
    });
    return () => {
      live = false;
    };
  }, [path]);

  const save = async () => {
    const res = await api.saveChatImage(path);
    if (res.savedPath) setSaved(res.savedPath);
    else if (res.error)
      useStore.getState().push({ type: "info", text: res.error });
  };

  if (missing) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ImageIcon size={13} />
        {name} — no longer available
      </div>
    );
  }
  return (
    <div className="flex w-fit max-w-[min(90%,32rem)] flex-col gap-1.5">
      <button
        className="overflow-hidden rounded-xl border border-border bg-muted/40"
        title="Open in Preview"
        onClick={() => void api.openChatImage(path)}
      >
        {src ? (
          <img src={src} alt={name} className="block max-h-[32rem] w-auto" />
        ) : (
          <div className="flex size-64 items-center justify-center">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        )}
      </button>
      <div className="flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
        <button
          className="hover:text-foreground"
          onClick={() => void api.openChatImage(path)}
        >
          Open
        </button>
        <button className="hover:text-foreground" onClick={() => void save()}>
          Save…
        </button>
        {saved && (
          <span className="truncate" title={saved}>
            Saved to {saved.split("/").slice(-2).join("/")}
          </span>
        )}
      </div>
    </div>
  );
}

/** One transcript block, memoized. The streaming typewriter re-renders
 *  <Messages> on every reveal tick, and without this each frame would re-run
 *  the whole transcript through ReactMarkdown. Block objects are stable
 *  between ticks (toBlocks is memoized on items), so the shallow compare
 *  bails everywhere except where the transcript actually changed. */
const TranscriptBlock = memo(function TranscriptBlock({
  block,
  interstitial,
}: {
  block: MessageBlock;
  /** Assistant text right before a tool-call group is in-run narration
   *  ("I'll gather…"), not an answer — no Remember button there. */
  interstitial: boolean;
}) {
  if (block.kind === "activity") {
    return <ActivityGroup entries={block.entries} />;
  }
  const { item } = block;
  switch (item.type) {
    case "user":
      return (
        <div className="group flex flex-col items-end gap-0.5">
          <div className="max-w-[80%] w-fit bg-muted/40 text-foreground/90 rounded-2xl rounded-br-md px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap">
            {item.text}
          </div>
          <RememberButton text={item.text} align="end" />
        </div>
      );
    case "assistant":
      return (
        <div className="group flex flex-col gap-0.5">
          <div className="max-w-[90%] prose prose-sm prose-pre:bg-background">
            <AssistantMarkdown text={item.text} />
          </div>
          {!interstitial && <RememberButton text={item.text} align="start" />}
        </div>
      );
    case "email-draft":
      return <EmailDraftCard draft={item.draft} />;
    case "image":
      return <GeneratedImage path={item.path} name={item.name} />;
    case "artifact": {
      const Icon = ARTIFACT_ICONS[item.artifactType];
      const verb =
        item.op === "create"
          ? "created"
          : item.op === "update"
            ? "updated"
            : "rewrote";
      return (
        <button
          className="flex items-center gap-2.5 w-fit max-w-[80%] rounded-xl border border-border bg-muted/40 hover:bg-muted hover:border-brand/40 px-3.5 py-2.5 text-left transition-[background-color,border-color,scale] duration-150 ease-out motion-safe:active:scale-[0.96]"
          title="Open in the artifact panel"
          onClick={() => useStore.getState().openArtifact(item.artifactId)}
        >
          <Icon size={16} className="text-brand shrink-0" />
          <span className="min-w-0">
            <span className="block text-[0.8125rem] text-foreground font-medium truncate">
              {item.title}
            </span>
            <span className="block text-[0.6875rem] text-muted-foreground">
              {verb} · {item.artifactType} · click to open
            </span>
          </span>
        </button>
      );
    }
    case "error":
      return (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{item.text}</AlertTitle>
        </Alert>
      );
    case "login-needed":
      return (
        <ClaudeLoginCard text={item.text} retryPrompt={block.retryPrompt} />
      );
    case "info":
      return (
        <Alert>
          <InfoIcon />
          <AlertTitle>{item.text}</AlertTitle>
        </Alert>
      );
    // Exhaustive over every type a MessageBlock item can hold. Typed
    // `never` so a new ChatItem variant fails to compile here instead
    // of silently rendering nothing in the transcript.
    default: {
      const unhandled: never = item;
      return unhandled;
    }
  }
});

/** Orb animation + label for the liveness cue, picked from what the run is
 *  actually doing right now. States and labels come from the orbs library's
 *  own vocabulary (orbs.jakubantalik.com): composing for thinking/generating,
 *  and per-tool verbs while a tool call is pending. */
function liveCue(items: ChatItem[]): { state: OrbState; label: string } {
  const last = items[items.length - 1];
  if (last?.type === "tool" && last.pending) {
    if (/search|grep|glob|find/i.test(last.name))
      return { state: "searching", label: "Searching…" };
    if (/fetch|web|http|mcp__|drive|gmail/i.test(last.name))
      return { state: "connecting", label: "Connecting…" };
    return { state: "working", label: "Working…" };
  }
  return { state: "composing", label: "Thinking…" };
}

/** The liveness cue shown while a run is in flight: just the orb and a quiet
 *  label — no chip/pill dressing. */
function LiveCueChip({ items }: { items: ChatItem[] }) {
  const cue = liveCue(items);
  return (
    // mt-4: the activity line above zeroes its margins (container's
    // [&>.text-xs]:my-0), so the cue brings its own breathing room; against
    // normal blocks this collapses with their spacing instead of stacking.
    <div className="mt-4 flex items-center gap-2 text-muted-foreground text-sm">
      <ThinkingOrb state={cue.state} size={20} aria-hidden />
      {cue.label}
    </div>
  );
}

function Messages() {
  const items = useStore((s) => s.items);
  const streamingText = useStore((s) => s.streamingText);
  const streamingThinking = useStore((s) => s.streamingThinking);
  // Typewriter smoothing: reveal the streamed buffer progressively instead of
  // snapping each coalesced chunk in. (Thinking stays unsmoothed — its
  // sliding-window ticker isn't append-only, so a reveal cursor can't track it.)
  const displayedText = useSmoothText(streamingText);
  const runState = useStore((s) => s.runState);
  // Only this thread's pending cards count — a parallel thread's permission
  // wait must not hide the "Thinking…" cue here.
  const permissionCount = useStore(
    (s) =>
      s.permissionQueue.filter(
        (r) => s.runThreads[r.runId] === s.activeThreadKey,
      ).length,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const blocks = useMemo(() => toBlocks(items), [items]);

  // Mirror of pinnedRef as state, so the scroll-to-end pill can render when
  // the user has scrolled up. (The ref stays: the autoscroll effect reads it
  // without needing scroll position in its dependency list.)
  const [pinned, setPinned] = useState(true);

  // Thread switch (open from the sidebar, new chat, restoring a stashed run):
  // jump straight to the end of the new transcript. activeThreadKey changes
  // in the same store update that swaps `items` in, so this layout effect
  // runs after that transcript is in the DOM and before it paints — no flash
  // of the thread's top, no smooth-scroll animation. Re-pins too, so a
  // scrolled-up position on the previous thread can't suppress the jump.
  const activeThreadKey = useStore((s) => s.activeThreadKey);
  // Deadline (performance.now() ms) until which transcript growth re-pins the
  // end after a switch — images, markdown and mermaid settle their height
  // after first paint and would otherwise leave the view short of the end.
  const repinUntilRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeThreadKey is the trigger — the effect must re-run on every thread switch, not on the values it reads.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    repinUntilRef.current = performance.now() + 1000;
    el.scrollTop = el.scrollHeight;
  }, [activeThreadKey]);

  // The re-pin window above: while it's open and the view is still pinned,
  // any growth of the transcript column snaps the end back into view. The
  // user scrolling up un-pins and ends it early; a search-hit scroll un-pins
  // the same way. Outside the window this is inert, so the smooth scroll on
  // send keeps its animation.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current && performance.now() < repinUntilRef.current)
        el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  };

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Re-pin immediately so streaming autoscroll takes over once the smooth
    // animation lands (intermediate scroll events un-pin and re-pin en route).
    pinnedRef.current = true;
    setPinned(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Sending a message returns the view to the end even when scrolled up: a
  // user item appended at the tail means the composer was just used.
  useEffect(() => {
    if (items[items.length - 1]?.type === "user") scrollToEnd();
  }, [items, scrollToEnd]);

  // Search-hit highlighting: when a thread was opened from a ⌘K content hit,
  // paint every occurrence of the term via the CSS Custom Highlight API (no
  // DOM mutation, so React never notices) and scroll the first one into view.
  // Matching is per text node — a term that spans formatting (e.g. across a
  // bold boundary) falls back to per-word highlights. A hybrid-search hit can
  // also match only semantically; then nothing highlights, by design.
  const highlightTerm = useStore((s) => s.highlightTerm);
  const setHighlightTerm = useStore((s) => s.setHighlightTerm);
  const sessionId = useStore((s) => s.resumeSessionId);
  const [matchCount, setMatchCount] = useState(0);
  // Scroll to the first match once per (session, term) — items keep changing
  // during streaming and re-running the scroll would yank the view.
  const scrolledForKey = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `blocks` is a deliberate dependency — the effect walks the DOM those blocks render into, so new content must re-paint the highlights.
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const el = scrollRef.current;
    const term = highlightTerm?.trim().toLowerCase() ?? "";
    if (!el || term.length < 2) {
      CSS.highlights.delete("search-term");
      setMatchCount(0);
      scrolledForKey.current = null;
      return;
    }
    const scrollKey = `${sessionId ?? ""}:${term}`;

    const collect = (needles: string[]): Range[] => {
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node) {
        const lower = (node.textContent ?? "").toLowerCase();
        for (const needle of needles) {
          let idx = lower.indexOf(needle);
          while (idx !== -1) {
            const r = new Range();
            r.setStart(node, idx);
            r.setEnd(node, idx + needle.length);
            ranges.push(r);
            idx = lower.indexOf(needle, idx + needle.length);
          }
        }
        node = walker.nextNode();
      }
      return ranges;
    };

    // Ranges need the rendered DOM, so wait a frame for ReactMarkdown output.
    const raf = requestAnimationFrame(() => {
      let ranges = collect([term]);
      if (ranges.length === 0) {
        const words = [
          ...new Set(term.split(/\s+/).filter((w) => w.length >= 3)),
        ];
        if (words.length > 1) ranges = collect(words);
      }
      setMatchCount(ranges.length);
      if (ranges.length === 0) {
        CSS.highlights.delete("search-term");
        return;
      }
      CSS.highlights.set("search-term", new Highlight(...ranges));
      if (scrolledForKey.current !== scrollKey) {
        scrolledForKey.current = scrollKey;
        const rect = ranges[0].getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        el.scrollTop += rect.top - elRect.top - el.clientHeight / 3;
        // Un-pin so the bottom-autoscroll doesn't yank away from the match.
        pinnedRef.current = false;
        setPinned(false);
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      CSS.highlights.delete("search-term");
    };
  }, [highlightTerm, sessionId, blocks]);

  useEffect(() => {
    if (!highlightTerm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHighlightTerm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [highlightTerm, setHighlightTerm]);

  return (
    // h-full is load-bearing: the scroll div below sizes itself with h-full,
    // which resolves to auto (no scrolling) unless this wrapper has a height.
    <div className="h-full pt-4">
      {highlightTerm && matchCount > 0 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full bg-popover/90 backdrop-blur px-3 py-1 text-[0.6875rem] text-muted-foreground ring-1 ring-foreground/10 shadow-sm">
          <span>
            {matchCount} match{matchCount === 1 ? "" : "es"} for “
            {highlightTerm}”
          </span>
          <button
            className="text-muted-foreground hover:text-foreground"
            title="Clear highlights (Esc)"
            onClick={() => setHighlightTerm(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {/* pb-44 keeps the last message readable above the floating composer. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // Gutter reserved on both edges (see SettingsPage): a thread growing
        // long enough to scroll doesn't shift the transcript sideways, and
        // the column stays centered over the composer.
        className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges] pt-4 pb-52"
      >
        {items.length === 0 && <EmptyState />}
        {/* Same max-w-3xl column as the settings page — on a wide window the
            conversation stays a readable measure instead of stretching. */}
        {/* Activity (tool/thinking) lines zero their own margins so consecutive
            lines stack tight; the sibling rules then restore air at the seams:
            a normal block after a line gets the standard mt-3, and a line
            after a normal block (e.g. an artifact card) gets an extra mt-1 on
            top of the card's space-y margin. */}
        <div
          ref={contentRef}
          className="mx-auto w-full px-6 max-w-3xl space-y-3 [&>.text-xs]:my-0 [&>.text-xs+*]:mt-3 [&>.text-xs+.text-xs]:mt-0 [&>:not(.text-xs)+.text-xs]:mt-1"
        >
          {blocks.map((block, i) => (
            <TranscriptBlock
              key={block.key}
              block={block}
              interstitial={blocks[i + 1]?.kind === "activity"}
            />
          ))}
          {/* Live streaming tail: the block currently being generated. The
          complete item replaces it (store clears the buffer), so it never
          coexists with its own final render. */}
          {streamingThinking && (
            <div className="text-muted-foreground/70 text-xs italic whitespace-pre-wrap line-clamp-4 max-w-[90%]">
              {streamingThinking.slice(-600)}
            </div>
          )}
          {displayedText && (
            <div className="max-w-[90%] prose prose-sm prose-pre:bg-background">
              <AssistantMarkdown text={displayedText} />
            </div>
          )}
          <PermissionCards />
          {runState === "running" &&
            permissionCount === 0 &&
            !displayedText && (
              // Stopping lives on the composer's round stop button — no second
              // control here, just a quiet liveness cue. Hidden while a permission
              // card is showing (the agent is waiting on the user) and while real
              // tokens are already streaming in. Orb + label follow what the
              // run is doing right now (thinking / working / searching).
              <LiveCueChip items={items} />
            )}
        </div>
      </div>
      {/* Floats over the scroll area, above the composer glass — sibling of
          the scroll div so it doesn't scroll away with the content. Always
          mounted and shown/hidden by transition rather than conditional
          render, so scrolling back down mid-fade simply reverses it; inert
          while hidden so the invisible pill is neither clickable nor
          focusable. */}
      <Button
        size="xs"
        variant="outline"
        onClick={scrollToEnd}
        inert={pinned}
        aria-hidden={pinned}
        className={cn(
          "absolute left-1/2 -translate-x-1/2 bottom-36 z-10 flex rounded-full border-border bg-popover/90 backdrop-blur text-muted-foreground hover:text-foreground shadow-lg",
          "transition-[color,background-color,opacity,translate,scale] duration-150 ease-out motion-reduce:transition-[color,background-color,opacity]",
          pinned && "opacity-0 translate-y-2 motion-reduce:translate-y-0",
        )}
      >
        <ChevronDown size={13} />
        Scroll to end
      </Button>
    </div>
  );
}

/** Assumed when neither the picked model nor a finished run tells us more. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Circular gauge next to Send showing how full the model's context window is
 *  for the open thread. Amber past 70%; hover reveals the exact numbers. */
function ContextRing() {
  const usage = useStore((s) => s.contextUsage);
  const model = useStore((s) => s.model);
  const provider = useStore((s) => s.modelProvider ?? s.settings?.authMode);
  const runOptions = useStore((s) =>
    provider ? s.runOptions[choiceKey(provider, model)] : undefined,
  );
  // The selected model's known window wins (it's what the NEXT message runs
  // against, even after a mid-thread model switch); the last run's
  // SDK-reported window covers models we have no static number for.
  const window =
    contextWindowFor(provider ?? null, model, runOptions) ??
    usage.window ??
    DEFAULT_CONTEXT_WINDOW;
  const frac = Math.min(1, usage.tokens / window);
  const warn = frac >= 0.7;
  const pct = frac * 100;
  const pctLabel = pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct);
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    // Focusable so the breakdown is reachable without a pointer; the card
    // shows on hover or keyboard focus.
    <div
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the gauge's details card has no other way in from the keyboard.
      tabIndex={0}
      className="group relative mr-1.5 flex items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <svg
        viewBox="0 0 18 18"
        className="size-4.5 -rotate-90"
        role="img"
        aria-label={`Context window ${pctLabel}% full`}
      >
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted-foreground/25"
        />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          className={cn(
            "transition-[stroke-dasharray,color] duration-300 ease-out",
            warn ? "text-warning" : "text-muted-foreground",
          )}
        />
      </svg>
      <div
        className={cn(
          "absolute bottom-full right-0 mb-3 w-60 rounded-xl border border-border bg-popover p-3 shadow-xl z-20",
          // visibility rides the transition too, so the card stays out of
          // hit-testing while hidden and still fades on the way out.
          "invisible opacity-0 translate-y-1 transition-[opacity,translate,visibility] duration-150 ease-out motion-reduce:translate-y-0",
          "group-hover:visible group-hover:opacity-100 group-hover:translate-y-0 group-focus-visible:visible group-focus-visible:opacity-100 group-focus-visible:translate-y-0",
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[0.8125rem] font-medium text-foreground">
            Context window
          </span>
          <span className="text-[0.75rem] text-muted-foreground tabular-nums">
            {pctLabel}% · {fmtTokens(usage.tokens)}/{fmtTokens(window)}
          </span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full",
              warn ? "bg-warning" : "bg-muted-foreground",
            )}
            style={{ width: `${usage.tokens > 0 ? Math.max(2, pct) : 0}%` }}
          />
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-2">
          <span className="text-[0.75rem] text-muted-foreground">
            Total processed
          </span>
          <span className="text-[0.75rem] text-muted-foreground tabular-nums">
            {fmtTokens(usage.processed)}
          </span>
        </div>
      </div>
    </div>
  );
}

function Composer() {
  const runState = useStore((s) => s.runState);
  const statusLine = useStore((s) => s.statusLine);
  const runModel = useStore((s) => s.runModel);
  const pickedModel = useStore((s) => s.model);
  // The picker already names the model — repeat it only when the run is
  // actually on something else (mid-thread switch, provider fallback).
  const offModel =
    runModel && !isPickedModel(pickedModel, runModel) ? runModel : null;
  const workspaces = useStore((s) => s.workspaces);
  const allSkills = useStore((s) => s.skills);
  const draft = useStore((s) => s.composerDraft);
  const setDraft = useStore((s) => s.setComposerDraft);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const active = workspaces.find((w) => w.active);
  // One run per THREAD — other threads keep composing/streaming, and
  // background runs (ingest, scheduled jobs) work in parallel too; the top
  // bar's activity chip is their indicator and stop affordance.
  const busy = runState === "running";
  // Switched-off skills are invisible everywhere the user could start one;
  // `user-invocable: false` ones aren't startable by the user at all.
  const skills = useMemo(
    () => allSkills.filter((s) => s.enabled && s.userInvocable),
    [allSkills],
  );

  /** Paste a screenshot or a copied file → saved as transient context the
   *  agent can Read (Claude reads images and PDFs natively, and opens other
   *  formats with its tools). Distinct from drop-to-ingest. */
  const onPaste = async (e: React.ClipboardEvent) => {
    const pasted = [...e.clipboardData.items]
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (pasted.length === 0) return;
    e.preventDefault();
    const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
    if (pasted.length > room) notifyAttachmentLimit();
    const files = pasted.slice(0, Math.max(0, room));
    for (const f of files) {
      const isImage = f.type.startsWith("image/");
      const name =
        f.name && f.name !== "image.png"
          ? f.name
          : `pasted-${Date.now()}.${isImage ? "png" : "bin"}`;
      const res = await api.saveChatAttachment(
        name,
        bytesToBase64(await f.arrayBuffer()),
      );
      // Bound to a const rather than asserted: narrowing `res.path` does not
      // survive into the setState closure, which is what forced the `!`.
      const path = res.path;
      if (path) {
        setAttachments((a) => [
          ...a,
          {
            name,
            path,
            ...(isImage ? { previewUrl: URL.createObjectURL(f) } : {}),
          },
        ]);
      } else if (res.error) {
        useStore.getState().push({ type: "info", text: res.error });
      }
    }
  };

  const notifyAttachmentLimit = () =>
    useStore.getState().push({
      type: "info",
      text: `A message can carry up to ${MAX_ATTACHMENTS} files.`,
    });

  /** The + button: the native file chooser — documents, spreadsheets,
   *  images, anything — for anyone who doesn't paste. Picked files become
   *  attachments exactly like pasted ones. */
  const pickFiles = async () => {
    const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
    if (room <= 0) return notifyAttachmentLimit();
    const res = await api.pickChatFiles(room);
    if (res.files.length > 0) {
      setAttachments((a) => [
        ...a,
        ...res.files.map((f) => ({
          name: f.name,
          path: f.path,
          ...(f.dataUrl ? { previewUrl: f.dataUrl } : {}),
        })),
      ]);
    }
    if (res.error) useStore.getState().push({ type: "info", text: res.error });
    taRef.current?.focus();
  };

  useEffect(() => {
    focusComposer = () => taRef.current?.focus();
    return () => {
      focusComposer = null;
    };
  }, []);

  // Revoke any un-sent attachment preview blobs when the Composer unmounts
  // (workspace switch, conditional render) — submit() already revokes on send.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      attachmentsRef.current.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      });
    },
    [],
  );

  // Slash palette: "/" as the first char (single line) filters workspace skills.
  const slash =
    draft.startsWith("/") && !draft.includes("\n")
      ? draft.slice(1).toLowerCase()
      : null;
  const matches =
    slash !== null
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(slash) ||
            s.description.toLowerCase().includes(slash),
        )
      : [];
  // The chat stays mounted under the settings screen, and the palette floats
  // at z-20 — without this guard it bleeds through on top of Settings.
  const paletteOpen = slash !== null && matches.length > 0 && !settingsOpen;
  const activeIdx = Math.min(paletteIdx, Math.max(0, matches.length - 1));

  // A lone pasted URL → offer to pull the page into the brain instead of chatting.
  const urlDraft = /^https?:\/\/\S+$/i.test(draft.trim()) ? draft.trim() : null;

  // Independent of the thread's run: ingest works in the background (or
  // queues behind an active ingest) either way.
  const ingestUrl = () => {
    if (!urlDraft) return;
    setDraft("");
    void api.ingestUrl(urlDraft);
  };

  const applySkill = (skill: SkillInfo) => {
    setDraft(starterFor(skill));
    setPaletteIdx(0);
    taRef.current?.focus();
  };

  const submit = () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy) return;
    const withContext = attachments.length
      ? `${text || "Look at the attached file(s)."}\n\n[Attached for context — read these files: ${attachments.map((a) => a.path).join(", ")}]`
      : text;
    setDraft("");
    attachments.forEach((a) => {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    });
    setAttachments([]);
    void api.startRun(withContext);
  };

  // Floats over the message scroll area. pointer-events-none on the wrapper
  // lets clicks/scroll in the padding gaps reach the messages behind it;
  // interactive children opt back in.
  return (
    <div className="absolute mx-4 inset-x-0 bottom-0 pb-4 pointer-events-none z-30">
      <div className="relative mx-auto w-full max-w-3xl">
        {urlDraft && !paletteOpen && !settingsOpen && (
          <div className="absolute left-0 right-0 bottom-full mb-1 z-20 flex items-center gap-2 rounded-xl border border-border bg-popover px-3 py-2 shadow-xl pointer-events-auto animate-in fade-in-0 slide-in-from-bottom-1 duration-150 ease-out">
            <Link2 size={13} className="text-brand shrink-0" />
            <button
              className="text-[0.75rem] text-brand hover:text-brand font-medium"
              onClick={ingestUrl}
            >
              Ingest this page into the brain
            </button>
            <span className="text-[0.6875rem] text-muted-foreground truncate">
              — fetches the page into inbox/ · or ↵ to just ask about it
            </span>
          </div>
        )}
        {paletteOpen && (
          <div className="absolute left-0 right-0 bottom-full mb-1 z-20 rounded-xl border border-border bg-popover overflow-hidden shadow-xl pointer-events-auto animate-in fade-in-0 slide-in-from-bottom-1 duration-150 ease-out">
            <div className="max-h-[45vh] overflow-y-auto overscroll-contain">
              {matches.map((s, i) => (
                <button
                  key={s.name}
                  ref={
                    i === activeIdx
                      ? (el) => el?.scrollIntoView({ block: "nearest" })
                      : undefined
                  }
                  onMouseEnter={() => setPaletteIdx(i)}
                  onClick={() => applySkill(s)}
                  className={cn(
                    "w-full text-left px-3 py-2",
                    i === activeIdx && "bg-muted",
                  )}
                >
                  <div className="text-[0.8125rem] text-foreground flex items-center gap-1.5">
                    <Sparkles size={12} className="text-brand shrink-0" />
                    {s.name}
                    {s.manualOnly && (
                      <span
                        className="text-[0.5625rem] uppercase tracking-wide text-muted-foreground border border-border rounded px-1"
                        title="Runs only when you start it here — the agent never triggers it on its own"
                      >
                        manual
                      </span>
                    )}
                  </div>
                  <div className="text-[0.6875rem] text-muted-foreground line-clamp-1">
                    {skillBlurb(s.description)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="pointer-events-auto rounded-[calc(var(--radius-lg)+--spacing(3))] border border-border bg-muted/50 backdrop-blur-xl backdrop-saturate-150 shadow-lg focus-within:border-brand transition-[border-color] duration-150">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className="flex items-center gap-1.5 rounded-lg bg-card border border-border pl-1 pr-2 py-1"
                >
                  {a.previewUrl ? (
                    <img
                      src={a.previewUrl}
                      alt={a.name}
                      className="h-8 w-8 object-cover rounded-sm outline outline-black/10 -outline-offset-1 dark:outline-white/10"
                    />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-muted text-muted-foreground">
                      <FileText size={15} />
                    </span>
                  )}
                  <span
                    className="text-[0.6875rem] text-muted-foreground max-w-32 truncate"
                    title={a.name}
                  >
                    {a.previewUrl && (
                      <ImageIcon size={10} className="inline mr-1 -mt-px" />
                    )}
                    {a.name}
                  </span>
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    title="Remove attachment"
                    onClick={() => {
                      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
                      setAttachments((list) =>
                        list.filter((x) => x.path !== a.path),
                      );
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="w-full bg-transparent text-foreground px-4 pt-3 pb-1 resize-none focus:outline-none placeholder:text-muted-foreground"
            rows={Math.min(6, Math.max(2, draft.split("\n").length))}
            placeholder="Ask the brain, type / for skills, attach files with +, or drop files to ingest"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => void onPaste(e)}
            onKeyDown={(e) => {
              if (paletteOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPaletteIdx((i) => (i + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPaletteIdx(
                    (i) => (i - 1 + matches.length) % matches.length,
                  );
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  applySkill(matches[activeIdx]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft("");
                  return;
                }
              }
              if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-1 px-3 pb-2.5">
            <Button
              variant="ghost"
              size="icon-sm"
              // A filled chip, not a bare glyph — the composer's own surface
              // is muted, so a ghost button disappeared into it.
              className="rounded-full bg-foreground/10 text-foreground hover:bg-foreground/15 dark:hover:bg-foreground/15"
              title={
                attachments.length >= MAX_ATTACHMENTS
                  ? `Up to ${MAX_ATTACHMENTS} files per message`
                  : `Attach files — documents, spreadsheets, images (up to ${MAX_ATTACHMENTS})`
              }
              aria-label="Attach files"
              disabled={attachments.length >= MAX_ATTACHMENTS}
              onClick={() => void pickFiles()}
            >
              <Plus />
            </Button>
            <ModelPicker />
            <RunOptionsPicker />
            <span className="bg-muted-foreground/50 h-3 w-px" />
            <PermissionsChip active={active} />
            {(statusLine || offModel) && (
              <span className="text-[0.6875rem] text-muted-foreground ml-2">
                {statusLine || `model ${offModel}`}
              </span>
            )}
            <div className="flex-1" />
            <ContextRing />
            {runState === "running" ? (
              <Button
                size="icon-lg"
                className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/85 disabled:opacity-40"
                title="Stop"
                onClick={() => void api.abortRun()}
              >
                <Square fill="currentColor" />
              </Button>
            ) : (
              <Button
                size="icon-lg"
                className="rounded-full bg-brand text-brand-foreground hover:bg-brand/85 disabled:opacity-40"
                title="Send (⌘↩)"
                disabled={!draft.trim() && attachments.length === 0}
                onClick={submit}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
