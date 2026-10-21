import type { SessionSummary } from "../shared/ipc";

/** Collapsible sidebar sections (persisted by id). "Threads" is never
 *  collapsible — it's where new chats appear. */
export type SectionId = "pinned" | "briefings";

export type ThreadGroups = {
  pinned: SessionSummary[];
  /** Scheduled morning briefings — their own section so the daily run
   *  doesn't bury chats (or older briefings) in the main list. */
  briefings: SessionSummary[];
  rest: SessionSummary[];
};

/** Split the (already title-filtered) thread list into sidebar sections.
 *  Each thread appears once: pinned wins over briefing. */
export function groupThreads(
  sessions: SessionSummary[],
  pinnedIds: string[],
): ThreadGroups {
  const pinnedSet = new Set(pinnedIds);
  const groups: ThreadGroups = { pinned: [], briefings: [], rest: [] };
  for (const t of sessions) {
    if (pinnedSet.has(t.sessionId)) groups.pinned.push(t);
    else if (t.kind === "briefing") groups.briefings.push(t);
    else groups.rest.push(t);
  }
  return groups;
}

/** What a COLLAPSED section header must still surface from the rows it
 *  hides — a briefing working right now, or one finished and unread, must
 *  never disappear behind a chevron. Only the section's own threads count
 *  (the unread list is never pruned, so it may name deleted threads). */
export function sectionStatus(
  threads: SessionSummary[],
  unreadIds: string[],
  isWorking: (sessionId: string) => boolean,
): { unread: number; working: boolean } {
  const unread = new Set(unreadIds);
  let unreadCount = 0;
  let working = false;
  for (const t of threads) {
    if (unread.has(t.sessionId)) unreadCount++;
    if (isWorking(t.sessionId)) working = true;
  }
  return { unread: unreadCount, working };
}

/** Whether a section renders its rows: a search with matches in it opens a
 *  collapsed section for the duration of the query (the saved state is left
 *  alone), so searching never "misses" a thread behind a chevron. */
export function sectionExpanded(
  id: SectionId,
  collapsed: string[],
  searching: boolean,
  hasMatches: boolean,
): boolean {
  if (searching && hasMatches) return true;
  return !collapsed.includes(id);
}
