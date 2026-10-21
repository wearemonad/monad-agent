import * as path from "node:path";
import type { SessionKind } from "../../shared/ipc";
import { readJsonAtomic, writeJsonAtomic } from "./atomicJson";

/** Per-workspace map of sessionId → kind for threads created by background
 *  machinery (scheduled jobs, meeting prep). Interactive chats are absent —
 *  absence means "normal thread". Lives beside the other workspace metadata
 *  in `.monad/`, keyed by session so SessionStore.list can stamp summaries. */

const metaPath = (wsPath: string) =>
  path.join(wsPath, ".monad", "session-meta.json");

export function readSessionKinds(wsPath: string): Record<string, SessionKind> {
  try {
    return readJsonAtomic<Record<string, SessionKind>>(
      metaPath(wsPath),
      () => ({}),
    );
  } catch {
    return {}; // momentarily unreadable — badges degrade, nothing breaks
  }
}

export function recordSessionKind(
  wsPath: string,
  sessionId: string,
  kind: SessionKind,
): void {
  try {
    const kinds = readSessionKinds(wsPath);
    if (kinds[sessionId] === kind) return;
    kinds[sessionId] = kind;
    writeJsonAtomic(metaPath(wsPath), kinds);
  } catch {
    // metadata is a display aid — never let it break a run
  }
}

/** Drop the entry for a deleted session so the map doesn't grow forever. */
export function forgetSessionKind(wsPath: string, sessionId: string): void {
  try {
    const kinds = readSessionKinds(wsPath);
    if (!(sessionId in kinds)) return;
    delete kinds[sessionId];
    writeJsonAtomic(metaPath(wsPath), kinds);
  } catch {
    // best-effort cleanup
  }
}

/** Which sessions in this folder are Monad threads — the source of truth that
 *  doesn't depend on the CLI keeping our tag inside the SDK's 64 KB tail
 *  window. `owner` = the workspace id that owns the thread; `owner: null` = a
 *  cached NEGATIVE tag scan (hidden ingest run, etc.), valid while the file's
 *  fingerprint (`size:mtime`) is unchanged. Two app processes writing at once
 *  can lose an entry; that self-heals because the tag is also in the file and
 *  a rescan re-finds it. */
export type SessionOwnerEntry = { owner: string | null; fp?: string };

const ownersPath = (wsPath: string) =>
  path.join(wsPath, ".monad", "session-owners.json");

export function readSessionOwners(
  wsPath: string,
): Record<string, SessionOwnerEntry> {
  try {
    return readJsonAtomic<Record<string, SessionOwnerEntry>>(
      ownersPath(wsPath),
      () => ({}),
    );
  } catch {
    return {}; // momentarily unreadable — the tag scan still finds threads
  }
}

/** Merge entries in (a positive entry is never downgraded to a negative). */
export function recordSessionOwners(
  wsPath: string,
  updates: Record<string, SessionOwnerEntry>,
): void {
  try {
    const owners = readSessionOwners(wsPath);
    let changed = false;
    for (const [sessionId, entry] of Object.entries(updates)) {
      const prior = owners[sessionId];
      if (prior?.owner && !entry.owner) continue;
      if (prior?.owner === entry.owner && prior?.fp === entry.fp) continue;
      owners[sessionId] = entry;
      changed = true;
    }
    if (changed) writeJsonAtomic(ownersPath(wsPath), owners);
  } catch {
    // ownership is also carried by the session's tag — never break a run
  }
}

export function recordSessionOwner(
  wsPath: string,
  sessionId: string,
  workspaceId: string,
): void {
  recordSessionOwners(wsPath, { [sessionId]: { owner: workspaceId } });
}

/** Drop entries for deleted sessions (explicit delete / ghost cleanup, or
 *  whatever `isGone` reports) so the map doesn't grow forever. */
export function forgetSessionOwners(
  wsPath: string,
  isGone: (sessionId: string) => boolean,
): void {
  try {
    const owners = readSessionOwners(wsPath);
    const gone = Object.keys(owners).filter(isGone);
    if (!gone.length) return;
    for (const id of gone) delete owners[id];
    writeJsonAtomic(ownersPath(wsPath), owners);
  } catch {
    // best-effort cleanup
  }
}

export function forgetSessionOwner(wsPath: string, sessionId: string): void {
  forgetSessionOwners(wsPath, (id) => id === sessionId);
}
