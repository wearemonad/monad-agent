import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  Clock,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  ShieldQuestion,
  SquarePen,
  Sunrise,
  Trash2,
  X,
} from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";
import type { ContentHit, SessionKind, SessionSummary } from "../../shared/ipc";
import { useStore } from "../store";
import {
  groupThreads,
  type SectionId,
  sectionExpanded,
  sectionStatus,
} from "../threadGroups";
import { api } from "../rpc";
import { relativeTime } from "../util";
import { cn } from "@/lib/utils";
import { OutboxPanel } from "./OutboxPanel";
import { DeleteThreadConfirm } from "./DeleteThreadConfirm";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HealthBanner } from "./HealthBanner";
import { SettingsNav } from "./SettingsPage";
import { InboxPanel } from "./InboxPanel";
import { ReviewPanel } from "./ReviewPanel";
import { UpdateControls } from "./UpdateControls";
import { Input } from "@/components/ui/input";

const INITIAL_THREADS_SHOWN = 12;
/** Briefings accumulate one per weekday — show the latest few. */
const INITIAL_BRIEFINGS_SHOWN = 3;

export function Sidebar({
  contentHidden,
  frozenWidth,
}: {
  /** Collapsed and finished sliding — see AppRoot. */
  contentHidden: boolean;
  /** Pinned width during the slide, so the contents are clipped by the
   *  narrowing panel instead of reflowing on every frame. */
  frozenWidth: number | null;
}) {
  const settingsOpen = useStore((s) => s.settingsOpen);
  return (
    // Width and the right border belong to the resizable panel + its handle
    // (see AppRoot). `invisible` rather than unmounting: it keeps the pane out
    // of the tab order and the a11y tree while collapsed, without throwing away
    // scroll position, the search box, or an expanded thread list.
    <aside
      style={frozenWidth ? { width: frozenWidth } : undefined}
      className={cn(
        "h-full pt-2 overflow-hidden flex flex-col bg-card/60",
        frozenWidth ? "shrink-0" : "w-full",
        contentHidden && "invisible",
      )}
    >
      {/* One sidebar for both screens: the brand bar (and the toggle drawn over
          it) is constant, only the body below it swaps. That is what keeps the
          dragged width, the collapse animation and ⌘B working in settings. */}
      <BrandBar />
      {settingsOpen ? (
        <SettingsNav />
      ) : (
        <>
          <WorkspaceSelector />
          <SearchBox />
          <ThreadList />
          <div className="p-3 gap-2 flex flex-col">
            <UpdateControls variant="compact" />
            <HealthBanner />
            <ReviewPanel />
            <InboxPanel />
            <OutboxPanel />
            <div className="flex gap-2 mt-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => useStore.getState().setKnowledgeOpen(true)}
              >
                <Brain className="size-3.5" /> Knowledge
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                title="Settings"
                onClick={() => useStore.getState().setSettingsOpen(true)}
              >
                <Settings className="size-3.5" /> Settings
              </Button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

/** Wordmark row, laid out the way the titlebar reads left to right: traffic
 *  lights, then the sidebar toggle (fixed-position, drawn by AppRoot over this
 *  row), then the wordmark starting where the toggle ends. The whole row is a
 *  window-drag handle; the toggle opts back out on its own. */
function BrandBar() {
  return (
    <div className="h-10 shrink-0 flex items-center pl-(--titlebar-content-x) electrobun-webkit-app-region-drag">
      {/* <Wordmark className="select-none" /> */}
    </div>
  );
}

/** Sentinel value for the picker's "New workspace" row: it isn't a
 *  workspace, it opens the create dialog in settings. */
const NEW_WORKSPACE = "__new__";

function WorkspaceSelector() {
  const workspaces = useStore((s) => s.workspaces);
  const active = workspaces.find((w) => w.active);

  return (
    <div className="px-3">
      <Select
        value={active?.id ?? null}
        // items lets the trigger render the workspace NAME: Base UI's
        // SelectValue shows the raw value (the id) otherwise.
        items={workspaces.map((w) => ({ value: w.id, label: w.name }))}
        onValueChange={(id) => {
          // value stays bound to the active workspace, so picking the
          // sentinel never shows up as the selection.
          if (id === NEW_WORKSPACE) {
            const s = useStore.getState();
            s.openSettingsAt("workspaces");
            s.setNewWorkspaceOpen(true);
          } else if (id) void api.setActiveWorkspace(id);
        }}
      >
        <SelectTrigger className="w-full" title={active?.path}>
          <SelectValue placeholder="Select workspace" />
        </SelectTrigger>
        {/* alignItemWithTrigger overlays the popup ON the trigger (growing
            upward, under the traffic lights this close to the window top) —
            a plain below-the-trigger dropdown is what belongs here. */}
        <SelectContent alignItemWithTrigger={false} side="bottom">
          <SelectGroup>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectItem value={NEW_WORKSPACE} className="text-muted-foreground">
              {/* ItemText is a flex row without items-center. */}
              <Plus className="self-center" /> New workspace
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

function SearchBox() {
  const query = useStore((s) => s.searchQuery);
  const setQuery = useStore((s) => s.setSearchQuery);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && e.metaKey) {
        e.preventDefault();
        ref.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === ref.current) {
        // Claimed, or AppKit beeps at the unhandled key (same as ⌘K above).
        e.preventDefault();
        setQuery("");
        ref.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuery]);

  return (
    <div className="flex items-center gap-1 px-3 pt-2">
      <label className="flex items-center gap-1.5 rounded-lg px-2.5 h-8.5 transition-colors flex-1 hover:bg-secondary focus-within:bg-secondary relative ">
        <Search
          size={15}
          className="text-muted-foreground transition-colors group-focus-within:text-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
        />
        <input
          ref={ref}
          className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none px-6"
          placeholder="Search threads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!query && (
          <kbd className="shrink-0 rounded bg-card/80 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground absolute right-2">
            ⌘K
          </kbd>
        )}
      </label>
      <Button
        size="icon-lg"
        variant="ghost"
        className="hover:bg-secondary!"
        title="New chat"
        onClick={() => useStore.getState().newChat()}
      >
        <SquarePen size={15} />
      </Button>
    </div>
  );
}

/** Whether the thread rows' staggered entrance has already played in this
 *  window. Module scope, so it outlives ThreadList's remounts. */
let threadEntrancePlayed = false;

function ThreadList() {
  const sessions = useStore((s) => s.sessions);
  const resumeSessionId = useStore((s) => s.resumeSessionId);
  const runningSessions = useStore((s) => s.runningSessions);
  const permissionQueue = useStore((s) => s.permissionQueue);
  const backgroundRun = useStore((s) => s.backgroundRun);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const unreadSessions = useStore((s) => s.unreadSessions);
  const collapsedSections = useStore((s) => s.collapsedSections);
  const query = useStore((s) => s.searchQuery).toLowerCase();
  const [showAll, setShowAll] = useState(false);
  const [showAllBriefings, setShowAllBriefings] = useState(false);
  const [contentHits, setContentHits] = useState<ContentHit[]>([]);
  // Staggered entrance plays once, on the app's first load. Returning from
  // settings remounts this list (the sidebar body swaps back), but that is a
  // routine navigation and the rows should simply be there. The flag holds
  // until the whole cascade has played out (last row starts at 210ms + 200ms
  // duration), so store updates landing in those first frames can't strip the
  // animation classes mid-flight. The clock starts only once sessions exist —
  // on a cold start they arrive async.
  const [entering, setEntering] = useState(() => !threadEntrancePlayed);
  const hasSessions = sessions.length > 0;
  useEffect(() => {
    if (!hasSessions || !entering) return;
    const t = setTimeout(() => {
      threadEntrancePlayed = true;
      setEntering(false);
    }, 450);
    return () => clearTimeout(t);
  }, [hasSessions, entering]);

  // Content search: the answer you got three weeks ago shouldn't be lost.
  // Debounced full-text scan of this workspace's saved conversations.
  useEffect(() => {
    if (query.trim().length < 3) {
      setContentHits([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      void api.searchSessions(query).then((res) => {
        if (!stale) setContentHits(res.hits);
      });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]);

  // Threads whose run is paused on a permission card the user can't see from
  // here — they get an amber badge instead of the spinner.
  const needsInput = useMemo(() => {
    const waiting = new Set(permissionQueue.map((r) => r.runId));
    return new Set(
      Object.entries(runningSessions)
        .filter(([, runId]) => waiting.has(runId))
        .map(([sessionId]) => sessionId),
    );
  }, [permissionQueue, runningSessions]);

  const filtered = query
    ? sessions.filter((t) => t.title.toLowerCase().includes(query))
    : sessions;
  // Pinned threads and scheduled briefings get their own sections rather
  // than floating to the top of a single list — the group header is what
  // tells you what they are, so the rows themselves stay uncluttered. Both
  // collapse; Threads (where new chats land) always stays open.
  const { pinned, briefings, rest } = groupThreads(filtered, pinnedSessions);
  const pinnedSet = new Set(pinnedSessions);
  // A run is working in this thread: a background job's thread (briefing,
  // meeting prep — its session id rides backgroundRun), or any thread — open
  // or not — with an interactive run streaming (parallel threads).
  const isWorking = (sessionId: string) =>
    sessionId === backgroundRun?.sessionId || !!runningSessions[sessionId];
  const searching = !!query;
  const pinnedOpen = sectionExpanded(
    "pinned",
    collapsedSections,
    searching,
    pinned.length > 0,
  );
  const briefingsOpen = sectionExpanded(
    "briefings",
    collapsedSections,
    searching,
    briefings.length > 0,
  );
  const briefingsVisible =
    showAllBriefings || query
      ? briefings
      : briefings.slice(0, INITIAL_BRIEFINGS_SHOWN);
  const visible =
    showAll || query ? rest : rest.slice(0, INITIAL_THREADS_SHOWN);
  // The entrance cascade reads as one list: each section's rows are offset by
  // the rows rendered above it.
  const pinnedShown = pinnedOpen ? pinned.length : 0;
  const briefingsShown = briefingsOpen ? briefingsVisible.length : 0;

  const row = (t: SessionSummary, i: number, hideKind = false) => (
    <ThreadRow
      key={t.sessionId}
      thread={t}
      active={t.sessionId === resumeSessionId}
      pinned={pinnedSet.has(t.sessionId)}
      working={isWorking(t.sessionId)}
      needsInput={needsInput.has(t.sessionId)}
      unread={unreadSessions.includes(t.sessionId)}
      hideKind={hideKind}
      // Delay capped so a long list finishes its cascade quickly; rows past
      // the cap appear together with the last staggered one.
      enterDelay={entering ? Math.min(i, 14) * 15 : null}
    />
  );

  return (
    <div className="relative flex-1 min-h-0">
      <div className="pointer-events-none absolute top-0 inset-x-0 h-6 z-10 bg-linear-to-b from-[color-mix(in_oklch,var(--card)_60%,var(--background))] to-transparent" />
      <div className="pointer-events-none absolute bottom-0 inset-x-0 h-6 z-10 bg-linear-to-t from-[color-mix(in_oklch,var(--card)_60%,var(--background))] to-transparent" />
      <div className="h-full overflow-y-auto scrollbar-hidden px-3 pt-4 pb-2">
        {pinned.length > 0 && (
          <ThreadSection
            id="pinned"
            icon={<Pin size={13} className="text-foreground" />}
            label="Pinned"
            count={pinned.length}
            expanded={pinnedOpen}
            status={sectionStatus(pinned, unreadSessions, isWorking)}
          >
            <div className="space-y-1">{pinned.map((t, i) => row(t, i))}</div>
          </ThreadSection>
        )}
        {briefings.length > 0 && (
          <ThreadSection
            id="briefings"
            icon={<Sunrise size={13} className="text-warning" />}
            label="Briefings"
            count={briefings.length}
            expanded={briefingsOpen}
            status={sectionStatus(briefings, unreadSessions, isWorking)}
          >
            {/* The section header already says "briefing" — rows drop the
                redundant sunrise glyph. */}
            <div className="space-y-0.5">
              {briefingsVisible.map((t, i) => row(t, pinnedShown + i, true))}
            </div>
            {!showAllBriefings &&
              !query &&
              briefings.length > INITIAL_BRIEFINGS_SHOWN && (
                <button
                  type="button"
                  className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-[0.6875rem] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  onClick={() => setShowAllBriefings(true)}
                >
                  Show {briefings.length - INITIAL_BRIEFINGS_SHOWN} more
                </button>
              )}
          </ThreadSection>
        )}
        <div className="flex gap-1.5 items-center pl-2.5 mb-1.5">
          <MessageSquare size={13} className="text-foreground" />
          <div className="text-[0.75rem] font-medium text-foreground">
            Threads
          </div>
        </div>
        {rest.length === 0 && (!query || filtered.length === 0) && (
          <p className="px-2.5 py-1 text-[0.6875rem] text-muted-foreground">
            {query ? "No threads match." : "No threads yet"}
          </p>
        )}
        <div className="space-y-0.5">
          {visible.map((t, i) => row(t, pinnedShown + briefingsShown + i))}
        </div>
        {!showAll && !query && rest.length > INITIAL_THREADS_SHOWN && (
          <button
            type="button"
            className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-[0.6875rem] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => setShowAll(true)}
          >
            Show {rest.length - INITIAL_THREADS_SHOWN} more
          </button>
        )}
        {query && contentHits.length > 0 && (
          <div className="mt-4">
            <p className="px-2.5 pb-1.5 text-[0.6875rem] font-medium text-muted-foreground">
              In conversations
            </p>
            <div className="space-y-1">
              {contentHits
                .filter(
                  (h) => !filtered.some((t) => t.sessionId === h.sessionId),
                )
                .map((h) => (
                  <button
                    type="button"
                    key={h.sessionId}
                    className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
                    onClick={() => {
                      // Carry the query into the conversation so ChatPane can
                      // highlight and scroll to the matches. (Raw store value:
                      // the local `query` is lowercased for filtering.)
                      const raw = useStore.getState().searchQuery.trim();
                      useStore.getState().setHighlightTerm(raw || null);
                      void api.openSession(h.sessionId);
                    }}
                  >
                    <span className="block text-[0.8125rem] text-foreground truncate">
                      {h.title}
                    </span>
                    <span className="block text-[0.6875rem] text-muted-foreground line-clamp-2">
                      {h.snippet}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A collapsible group of threads (Pinned, Briefings). Collapsed, the header
 *  still surfaces what its rows would have shown — a count, a working orb
 *  while one of its threads runs, and the unread dot — so a fresh briefing is
 *  never hidden behind the chevron. */
function ThreadSection({
  id,
  icon,
  label,
  count,
  expanded,
  status,
  children,
}: {
  id: SectionId;
  icon: ReactNode;
  label: string;
  count: number;
  expanded: boolean;
  status: { unread: number; working: boolean };
  children: ReactNode;
}) {
  const toggleSection = useStore((s) => s.toggleSection);
  return (
    <div className="mb-4">
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? `Collapse ${label}` : `Expand ${label}`}
        onClick={() => toggleSection(id)}
        className="group/section flex w-full gap-1.5 items-center rounded-md pl-2.5 pr-2 py-0.5 mb-1 text-left transition-colors hover:bg-muted/50"
      >
        {icon}
        <span className="text-[0.75rem] font-medium text-foreground">
          {label}
        </span>
        {!expanded && (
          <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        {!expanded && status.working ? (
          <span className="flex items-center" title="Working…">
            <ThinkingOrb state="working" size={20} aria-hidden />
          </span>
        ) : (
          !expanded &&
          status.unread > 0 && (
            <span
              className="flex items-center"
              title={`${status.unread} unread`}
            >
              <span className="size-1.5 rounded-full bg-brand" />
            </span>
          )
        )}
        <ChevronDown
          size={12}
          aria-hidden
          className={cn(
            "ml-auto text-muted-foreground/70 transition-[rotate,color] duration-150 ease-out motion-reduce:transition-[color] group-hover/section:text-foreground",
            !expanded && "-rotate-90",
          )}
        />
      </button>
      {expanded && children}
    </div>
  );
}

/** Small leading glyph for background-created threads: briefings, other
 *  scheduled jobs, and meeting-prep briefs. Normal chats render no icon. */
function KindIcon({ kind }: { kind: SessionKind }) {
  // Sun-colored sunrise: the theme's amber token, overriding the muted tint
  // the icon slot applies to the other kind glyphs.
  if (kind === "briefing") return <Sunrise className="size-3 text-warning" />;
  if (kind === "meeting-prep") return <CalendarClock className="size-3" />;
  return <Clock className="size-3" />;
}

const KIND_LABELS: Record<SessionKind, string> = {
  briefing: "Morning briefing",
  scheduled: "Scheduled run",
  "meeting-prep": "Meeting prep",
};

function kindTooltip(thread: SessionSummary): string {
  return thread.kind
    ? `${thread.title} — ${KIND_LABELS[thread.kind]}`
    : thread.title;
}

function ThreadRow({
  thread,
  active,
  pinned,
  working,
  needsInput,
  unread,
  hideKind = false,
  enterDelay,
}: {
  thread: SessionSummary;
  active: boolean;
  pinned: boolean;
  /** A run is streaming into this thread — show the spinner. */
  working: boolean;
  /** The thread's run is waiting on a permission card — amber badge; opening
   *  the thread shows the card. */
  needsInput: boolean;
  /** A run finished here since the thread was last open — blue dot, and the
   *  title reads at full strength (unread email). Opening the thread clears it. */
  unread: boolean;
  /** Skip the kind glyph — the row sits under a header that already says it. */
  hideKind?: boolean;
  /** ms of first-load stagger, or null once the list has settled. */
  enterDelay: number | null;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [value, setValue] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus AND select: the field mounts as the dropdown that opened it closes,
  // so claim focus on the next frame rather than racing that teardown.
  useEffect(() => {
    if (!renaming) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renaming]);

  const commitRename = async () => {
    const next = value.trim();
    setRenaming(false);
    if (next && next !== thread.title)
      await api.renameSession(thread.sessionId, next);
    else setValue(thread.title);
  };

  // Shared with the thread panel header (DeleteThreadConfirm.tsx).
  if (confirmingDelete) {
    return (
      <DeleteThreadConfirm
        thread={thread}
        onClose={() => setConfirmingDelete(false)}
      />
    );
  }

  if (renaming) {
    return (
      <div className="flex items-center gap-0.5 h-8">
        <Input
          className="border-none focus-visible:ring-0"
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // preventDefault is not optional here: a key event this webview
          // doesn't consume reaches AppKit, which answers an unhandled key
          // with the system alert beep. Stopping propagation also keeps
          // Escape from reaching the window-level search shortcut.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void commitRename();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setValue(thread.title);
              setRenaming(false);
            }
          }}
        />
        <Button
          size="icon"
          variant="secondary"
          title="Save"
          onClick={() => void commitRename()}
        >
          <Check size={14} />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          title="Cancel"
          onClick={() => {
            setValue(thread.title);
            setRenaming(false);
          }}
        >
          <X size={14} />
        </Button>
      </div>
    );
  }

  return (
    <div
      style={
        enterDelay != null ? { animationDelay: `${enterDelay}ms` } : undefined
      }
      className={cn(
        // relative anchors the title button's whole-row click overlay.
        "group relative flex items-center gap-1 pl-2.5 pr-1.5 h-8 rounded-lg text-[0.8125rem] transition-colors duration-150",
        active
          ? "bg-muted text-foreground font-medium"
          : unread
            ? // Unread reads like an unread email: full-strength, medium title.
              "text-foreground font-medium hover:bg-muted/50"
            : // foreground at 75% rather than muted-foreground: thread titles are
              // the sidebar's primary content and read too faint at muted level;
              // timestamps/section labels stay muted so the hierarchy holds.
              "text-foreground/75 hover:bg-muted/50 hover:text-foreground",
        // Under reduced motion index.css redefines thread-enter as a fade.
        enterDelay != null && "animate-[thread-enter_200ms_ease-out_both]",
      )}
    >
      {/* The button is the row's only click/keyboard target (no onClick on the
          div — it's not an interactive element). Its ::before overlay stretches
          the hit area over the whole row, so clicks on the row's padding still
          open the thread; the status icons and the timestamp/menu span are
          positioned, which paints them above the overlay and keeps their own
          tooltips and clicks working. */}
      <button
        type="button"
        className="flex items-baseline min-w-0 flex-1 text-left before:absolute before:inset-0"
        title={kindTooltip(thread)}
        onClick={() => {
          // A plain thread open is not a search jump — drop any leftover term.
          useStore.getState().setHighlightTerm(null);
          void api.openSession(thread.sessionId);
        }}
      >
        {/* While a run streams into this thread the spinner takes the leading
            icon slot, replacing the kind glyph rather than sitting beside it.
            A run paused on a permission card shows the amber badge instead;
            an unread thread's dot also wins over the kind glyph — one slot,
            most urgent state first. */}
        {needsInput ? (
          <span
            className="relative shrink-0 self-center mr-1.5 text-warning"
            title="Waiting for permission — open the thread to answer"
          >
            <ShieldQuestion size={12} />
          </span>
        ) : working ? (
          <span
            className="relative shrink-0 self-center mr-1.5"
            title="Working…"
          >
            <ThinkingOrb state="working" size={20} aria-hidden />
          </span>
        ) : unread ? (
          <span
            className="relative shrink-0 self-center mr-2 flex items-center justify-center"
            title="Finished — open to see the result"
          >
            <span className="size-1.5 rounded-full bg-brand" />
          </span>
        ) : (
          thread.kind &&
          !hideKind && (
            <span className="relative shrink-0 self-center mr-1.5 text-muted-foreground/70">
              <KindIcon kind={thread.kind} />
            </span>
          )
        )}
        <span className="truncate flex-1">{thread.title}</span>
      </button>
      {/* The ⋯ trigger overlays the timestamp and is faded, never display:none — a hidden trigger has a zero rect, so Radix would position the menu at 0,0 for the first frame (the top-left flicker). */}
      {/* Positioned, so it sits above the row button's click overlay — clicks
          on the timestamp or the ⋯ menu never open the thread. */}
      <span className="relative shrink-0 flex items-center justify-end min-w-5">
        <span
          className={cn(
            "text-[0.625rem] text-muted-foreground transition-opacity duration-150",
            menuOpen ? "opacity-0" : "group-hover:opacity-0",
          )}
        >
          {relativeTime(thread.updatedAt)}
        </span>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "absolute right-0 text-muted-foreground hover:text-foreground p-0.5 rounded transition-opacity duration-150 focus:outline-none focus-visible:opacity-100",
                  menuOpen
                    ? "opacity-100"
                    : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
                )}
                title="Thread actions"
              />
            }
          >
            <MoreHorizontal size={15} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            // Base UI restores focus to the trigger on close; that steals focus
            // from the rename input this menu just opened.
            finalFocus={false}
          >
            <DropdownMenuItem
              onClick={() => useStore.getState().togglePin(thread.sessionId)}
            >
              {pinned ? (
                <PinOff className="size-3" />
              ) : (
                <Pin className="size-3" />
              )}{" "}
              {pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil className="size-3" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="size-3" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
}
