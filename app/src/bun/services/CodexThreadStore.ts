import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChatItem,
  OpenAIProviderId,
  SessionSummary,
} from "../../shared/ipc";
import { readJsonAtomic, writeJsonAtomic } from "./atomicJson";

/** Monad's own record of one OpenAI (Codex) thread. Codex persists its
 *  rollouts in ~/.codex/sessions, but that format is internal to the CLI, so
 *  the sidebar listing and history replay read this transcript instead — the
 *  same ChatItems the live stream rendered. The thread id IS Codex's thread
 *  id, so a resume hands it straight back to `codex exec resume`. */
export type CodexThreadRecord = {
  threadId: string;
  workspaceId: string;
  provider: OpenAIProviderId;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: ChatItem[];
};

function threadsDir(cwd: string): string {
  return path.join(cwd, ".monad", "codex-threads");
}

/** Thread ids come from Codex (uuid-shaped) or from the webview; anything
 *  that could escape the directory is refused rather than sanitised. */
function threadFile(cwd: string, threadId: string): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) return null;
  return path.join(threadsDir(cwd), `${threadId}.json`);
}

export class CodexThreadStore {
  has(cwd: string, threadId: string): boolean {
    const file = threadFile(cwd, threadId);
    return !!file && fs.existsSync(file);
  }

  read(cwd: string, threadId: string): CodexThreadRecord | null {
    const file = threadFile(cwd, threadId);
    if (!file) return null;
    return readJsonAtomic<CodexThreadRecord | null>(file, () => null, {
      onCorrupt: (m) => console.error(`[codex-threads] ${m}`),
    });
  }

  write(cwd: string, record: CodexThreadRecord): void {
    const file = threadFile(cwd, record.threadId);
    if (!file) return;
    writeJsonAtomic(file, record);
  }

  /** This workspace's OpenAI threads, newest first. */
  list(cwd: string, workspaceId: string): SessionSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(threadsDir(cwd));
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const rec = this.read(cwd, name.slice(0, -".json".length));
      if (!rec || rec.workspaceId !== workspaceId) continue;
      if (!rec.items.some((i) => i.type === "user")) continue;
      out.push({
        sessionId: rec.threadId,
        title: rec.title || "Untitled",
        updatedAt: rec.updatedAt,
        runtime: "codex",
        provider: rec.provider,
        ...(rec.model ? { model: rec.model } : {}),
      });
    }
    return out.sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
  }

  rename(cwd: string, threadId: string, title: string): boolean {
    const trimmed = title.trim();
    const rec = this.read(cwd, threadId);
    if (!rec || !trimmed) return false;
    this.write(cwd, { ...rec, title: trimmed });
    return true;
  }

  /** Forget the thread in Monad. Codex's own rollout under ~/.codex stays —
   *  it belongs to the user's Codex history, not to this workspace. */
  remove(cwd: string, threadId: string): boolean {
    const file = threadFile(cwd, threadId);
    if (!file) return false;
    try {
      fs.rmSync(file);
      return true;
    } catch {
      return false;
    }
  }
}
