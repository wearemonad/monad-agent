import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  BrainHealth,
  DriveFolder,
  InboxTrigger,
  KnowledgeDoc,
  OutboxFile,
  OutboxPreview,
  ReviewItem,
  ScheduledJob,
  SkillInfo,
  WorkspaceInfo,
} from "../../shared/ipc";
import {
  SKILL_ARTIFACT,
  SKILL_BRAIN_SEARCH,
  SKILL_INGEST,
  SKILL_REMEMBER,
  SYSTEM_SKILL_DIRS,
  WORKSPACE_DIRS,
  WORKSPACE_TEMPLATE,
  claudeMdForTemplate,
} from "../workspaceTemplate";
import { ENTITY_PAGES_DIR } from "../../shared/knowledgeGraph";
import { WORKING_MEMORY_PATH } from "../../shared/memory";
import { workingMemoryTemplate } from "./workingMemory";
import { ARTIFACTS_ALLOW_RULE } from "../../shared/artifacts";
import { EMAIL_ALLOW_RULE } from "../../shared/email";
import { MEMORY_ALLOW_RULE } from "../../shared/memory";
import { readJsonAtomic, writeJsonAtomic } from "./atomicJson";
import { localDateKey } from "./SchedulerService";
import { upgradeLegacyTwenty } from "./McpConfig";

type DriveLink = {
  email: string;
  /** Drive folders synced into inbox/, in pick order. */
  folders?: DriveFolder[];
  /** Walk subfolders of every selected folder too. */
  recursive?: boolean;
  /** Stamped once per sync run — all selected folders sync together. */
  lastSync?: string;
  /** Gmail labels that route an email into inbox/ (any match pulls it).
   *  Absent/empty = the default GMAIL_INGEST_LABEL. */
  gmailLabels?: string[];
  /** Google said the grant is dead; see DriveInfo.needsReconnect. */
  needsReconnect?: string;
  /** Pre-multi-folder single selection. Folded into `folders` by load() and
   *  then dropped; only ever read there. */
  folderId?: string;
  folderName?: string;
};

type Entry = {
  id: string;
  name: string;
  path: string;
  drive?: DriveLink;
  /** Local folder mirrored into inbox/ (zero-OAuth capture path). */
  watchFolder?: string;
  alwaysAllow?: string[];
  jobs?: ScheduledJob[];
  inboxTriggers?: InboxTrigger[];
  meetingPrep?: boolean;
  /** false = briefing skips "🎯 Suggested focus"; absent = on (default). */
  briefingFocus?: boolean;
  budgetUsd?: number;
  /** Skills switched off in Settings → Skills (hidden + denied to the agent). */
  disabledSkills?: string[];
};

/** Tools that are safe to auto-approve in any workspace: read-only tools, the
 *  artifact tools (which only write inside the workspace's artifacts/), and
 *  the email card tool (pure presentation — sending is a human click). */
const DEFAULT_ALWAYS_ALLOW = [
  "Read",
  "Glob",
  "Grep",
  "ToolSearch",
  ARTIFACTS_ALLOW_RULE,
  EMAIL_ALLOW_RULE,
  MEMORY_ALLOW_RULE,
];

type Registry = {
  workspaces: Entry[];
  activeId: string | null;
  migrations?: string[];
};

/** $HOME before os.homedir(): Bun resolves os.homedir() once at process start
    and ignores later env changes, so the test suite's fake-HOME isolation
    (set before this module is imported) only works through the env var.
    Without this, `bun test` writes TestCo entries into the REAL registry. */
function home(): string {
  return process.env.HOME || os.homedir();
}

/** Never delete anything under these, whatever the registry claims. Note the
 *  absence of /var: macOS puts tmpdir under /private/var, and the test suite
 *  builds real workspaces there. */
const SYSTEM_PREFIXES = [
  "/System",
  "/Library",
  "/Applications",
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/dev",
  "/Network",
  "/cores",
  "/opt",
];

/** Home-relative folders that are never a brain, only ever a container. */
const HOME_FOLDERS = [
  "Documents",
  "Desktop",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Applications",
];

export const CONFIG_DIR = path.join(
  home(),
  "Library/Application Support/Monad",
);
const CONFIG = path.join(CONFIG_DIR, "workspaces.json");

export class WorkspaceManager {
  private registry: Registry;

  constructor(defaultWorkspacePath?: string) {
    this.registry = this.load();
    this.migrateArtifacts();
    this.migrateEmailCard();
    this.migrateMemoryTools();
    this.migrateWorkingMemory();
    this.migrateKnowledgeGraph();
    this.migrateTwentyMcp();
    if (
      this.registry.workspaces.length === 0 &&
      defaultWorkspacePath &&
      fs.existsSync(defaultWorkspacePath)
    ) {
      this.add(
        defaultWorkspacePath,
        path.basename(path.dirname(defaultWorkspacePath)),
      );
    }
  }

  list(): WorkspaceInfo[] {
    return this.registry.workspaces.map((w) => this.toInfo(w));
  }

  active(): WorkspaceInfo | null {
    return this.list().find((w) => w.active) ?? null;
  }

  get(id: string): Entry | undefined {
    return this.registry.workspaces.find((w) => w.id === id);
  }

  setActive(id: string): boolean {
    if (!this.get(id)) return false;
    this.registry.activeId = id;
    this.save();
    return true;
  }

  /** Register an existing folder as a workspace; scaffolds any missing structure. */
  add(wsPath: string, name?: string): WorkspaceInfo {
    const abs = path.resolve(wsPath);
    const existing = this.registry.workspaces.find((w) => w.path === abs);
    if (existing) return this.toInfo(existing);
    if (!fs.existsSync(abs)) throw new Error(`Folder does not exist: ${abs}`);
    this.scaffold(abs, { onlyMissing: true });
    const ws: Entry = {
      id: randomUUID(),
      name: name ?? path.basename(abs),
      path: abs,
      alwaysAllow: [...DEFAULT_ALWAYS_ALLOW],
    };
    this.registry.workspaces.push(ws);
    if (!this.registry.activeId) this.registry.activeId = ws.id;
    this.save();
    return this.toInfo(ws);
  }

  /** Create a brand-new workspace folder from the embedded template.
   *  templateId picks a brain-gallery CLAUDE.md variant (default generic). */
  create(parentDir: string, name: string, templateId?: string): WorkspaceInfo {
    const safe = name.trim().replace(/[/\\:]/g, "-");
    if (!safe) throw new Error("Workspace name is required.");
    const abs = path.join(path.resolve(parentDir), safe);
    if (fs.existsSync(abs) && fs.readdirSync(abs).length > 0) {
      throw new Error(`Folder already exists and is not empty: ${abs}`);
    }
    this.scaffold(abs, {
      onlyMissing: false,
      overrides: { "CLAUDE.md": claudeMdForTemplate(templateId) },
    });
    return this.add(abs, safe);
  }

  /** Why a workspace's folder may not be deleted, or null if it may.
   *
   *  Deletion is opt-in and narrow on purpose: the only folders we will touch
   *  are ones Monad itself laid out. A folder the user pointed us at — their
   *  Documents, a Drive mirror, a repo — is theirs, and unregistering is the
   *  right verb for it. The scaffold check is the proxy for "we made this":
   *  `add()` scaffolds on registration too, so it is not proof of authorship,
   *  which is why the path guards below carry the rest of the weight. */
  deleteBlockedReason(id: string): string | null {
    const ws = this.get(id);
    if (!ws) return "That workspace is no longer registered.";
    const abs = path.resolve(ws.path);
    if (!fs.existsSync(abs)) return "That folder no longer exists on disk.";

    // A workspace folder always sits inside something. Deleting a volume root,
    // a home directory, or a top-level folder is never what was meant, and the
    // depth check is what stops a registry entry of "/" or "/Users/alex".
    if (abs === path.parse(abs).root || abs === home())
      return "That folder is a home or volume root.";
    if (abs.split(path.sep).filter(Boolean).length < 3)
      return "That folder sits too close to the volume root to delete safely.";
    if (SYSTEM_PREFIXES.some((p) => abs === p || abs.startsWith(p + path.sep)))
      return "That folder is inside a system directory.";
    // ~/Documents and friends can hold a CLAUDE.md if someone registered one
    // directly, and the marker check below would then wave through deleting
    // their entire Documents folder. Named explicitly for that reason.
    if (HOME_FOLDERS.some((n) => abs === path.join(home(), n)))
      return "That is a top-level folder in your home directory.";

    // The scaffold marker: a brain has a CLAUDE.md and the knowledge tree. A
    // folder missing those was never laid out by us, whatever it is registered
    // as, so we refuse rather than guess.
    if (!fs.existsSync(path.join(abs, "CLAUDE.md")))
      return "That folder has no CLAUDE.md — it doesn't look like a Monad brain.";
    if (!fs.existsSync(path.join(abs, "knowledge")))
      return "That folder has no knowledge/ — it doesn't look like a Monad brain.";
    return null;
  }

  /** Unregister a workspace. Never touches files on disk. */
  remove(id: string): boolean {
    const idx = this.registry.workspaces.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    this.registry.workspaces.splice(idx, 1);
    if (this.registry.activeId === id) {
      this.registry.activeId = this.registry.workspaces[0]?.id ?? null;
    }
    this.save();
    return true;
  }

  rename(id: string, name: string): boolean {
    const ws = this.get(id);
    if (!ws || !name.trim()) return false;
    ws.name = name.trim();
    this.save();
    return true;
  }

  setDrive(id: string, drive: DriveLink | undefined): void {
    const ws = this.get(id);
    if (!ws) throw new Error("Unknown workspace.");
    ws.drive = drive;
    this.save();
  }

  updateDrive(id: string, patch: Partial<DriveLink>): void {
    const ws = this.get(id);
    if (!ws?.drive)
      throw new Error("Drive is not connected for this workspace.");
    ws.drive = { ...ws.drive, ...patch };
    this.save();
  }

  // ---- watch folder ----

  setWatchFolder(id: string, folder: string | undefined): void {
    const ws = this.get(id);
    if (!ws) throw new Error("Unknown workspace.");
    if (folder) {
      const abs = path.resolve(folder);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        throw new Error(`Not a folder: ${abs}`);
      }
      if (abs === ws.path || abs.startsWith(ws.path + path.sep)) {
        throw new Error(
          "The watch folder can't be inside the workspace itself.",
        );
      }
      ws.watchFolder = abs;
    } else {
      delete ws.watchFolder;
    }
    this.save();
  }

  /** Copy new/changed files from the workspace's watch folder into inbox/.
   *  Files are copied (never moved) and tracked in .monad/watch-sync.json, so
   *  the source folder stays untouched. Returns copied inbox basenames. */
  pullWatchFolder(id: string): string[] {
    const ws = this.get(id);
    if (!ws?.watchFolder) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(ws.watchFolder, { withFileTypes: true });
    } catch {
      return []; // folder unplugged/renamed — retried next poll
    }
    const statePath = path.join(ws.path, ".monad", "watch-sync.json");
    const state: Record<string, string> = readJsonFile(statePath) ?? {};
    const inbox = path.join(ws.path, "inbox");
    const copied: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const src = path.join(ws.watchFolder, entry.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(src);
      } catch {
        continue;
      }
      // Skip files still being written (modified in the last 2 seconds).
      // Math.abs so a file with a future mtime (a fast NFS/SMB clock skew)
      // isn't treated as "written 2s ahead" and skipped forever.
      if (Math.abs(Date.now() - st.mtimeMs) < 2_000) continue;
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (state[entry.name] === stamp) continue;
      fs.mkdirSync(inbox, { recursive: true });
      const target = uniqueInboxPath(inbox, entry.name);
      try {
        // COPYFILE_FICLONE: APFS same-volume copies become copy-on-write
        // clones (~zero extra disk) yet stay real, independent files that
        // survive the original moving. Falls back to a normal copy when the
        // filesystem can't clone (cross-volume, non-APFS).
        fs.copyFileSync(src, target, fs.constants.COPYFILE_FICLONE);
      } catch {
        continue;
      }
      state[entry.name] = stamp;
      copied.push(path.basename(target));
    }
    if (copied.length) {
      writeJsonAtomic(statePath, state);
    }
    return copied;
  }

  // ---- permissions ----

  /** True when toolName matches the workspace's always-allow list
   *  (exact match, or prefix pattern like "mcp__twenty__*"). */
  isAlwaysAllowed(id: string, toolName: string): boolean {
    const rules = this.get(id)?.alwaysAllow ?? [];
    return rules.some((r) =>
      r.endsWith("*") ? toolName.startsWith(r.slice(0, -1)) : toolName === r,
    );
  }

  setAlwaysAllow(id: string, alwaysAllow: string[]): void {
    const ws = this.get(id);
    if (!ws) return;
    ws.alwaysAllow = [
      ...new Set(alwaysAllow.map((s) => s.trim()).filter(Boolean)),
    ];
    this.save();
  }

  addAlwaysAllow(id: string, toolName: string): void {
    const ws = this.get(id);
    if (!ws) return;
    this.setAlwaysAllow(id, [...(ws.alwaysAllow ?? []), toolName]);
  }

  // ---- event triggers & knobs ----

  addInboxTrigger(id: string, match: string, prompt: string): void {
    const ws = this.get(id);
    if (!ws) throw new Error("Unknown workspace.");
    if (!match.trim() || !prompt.trim())
      throw new Error("Both a match and an instruction are required.");
    ws.inboxTriggers = [
      ...(ws.inboxTriggers ?? []),
      { id: randomUUID(), match: match.trim(), prompt: prompt.trim() },
    ];
    this.save();
  }

  removeInboxTrigger(id: string, triggerId: string): void {
    const ws = this.get(id);
    if (!ws) return;
    ws.inboxTriggers = (ws.inboxTriggers ?? []).filter(
      (t) => t.id !== triggerId,
    );
    this.save();
  }

  /** Extra instructions for an ingest run, from trigger rules matching the
   *  new files. "*.vtt" matches the extension; anything else is a substring. */
  triggerPromptsFor(id: string, files: string[]): string[] {
    const rules = this.get(id)?.inboxTriggers ?? [];
    const prompts: string[] = [];
    for (const rule of rules) {
      const m = rule.match.toLowerCase();
      const matched = files.filter((f) => {
        const name = f.toLowerCase();
        return m.startsWith("*.")
          ? name.endsWith(m.slice(1))
          : name.includes(m);
      });
      if (matched.length)
        prompts.push(`${rule.prompt} (triggered by: ${matched.join(", ")})`);
    }
    return prompts;
  }

  setMeetingPrep(id: string, enabled: boolean): void {
    const ws = this.get(id);
    if (!ws) return;
    ws.meetingPrep = enabled;
    this.save();
  }

  /** On is the default, stored as absence — the registry only records the
   *  deliberate opt-out. */
  setBriefingFocus(id: string, enabled: boolean): void {
    const ws = this.get(id);
    if (!ws) return;
    if (enabled) delete ws.briefingFocus;
    else ws.briefingFocus = false;
    this.save();
  }

  /** True unless the workspace opted out of the briefing's Suggested focus. */
  briefingFocusEnabled(id: string): boolean {
    return this.get(id)?.briefingFocus !== false;
  }

  setBudget(id: string, budgetUsd: number | undefined): void {
    const ws = this.get(id);
    if (!ws) return;
    if (budgetUsd !== undefined && budgetUsd > 0) ws.budgetUsd = budgetUsd;
    else delete ws.budgetUsd;
    this.save();
  }

  // ---- scheduled jobs ----

  addJob(id: string, job: Omit<ScheduledJob, "id" | "lastRunDate">): void {
    const ws = this.get(id);
    if (!ws) return;
    // A job whose time already passed today must not fire on the very next
    // tick — catch-up semantics are for missed days, not the moment of
    // creation. Stamp today so the first firing is the next occurrence.
    const now = new Date();
    const alreadyPassedToday =
      now.getHours() * 60 + now.getMinutes() >= job.hour * 60 + job.minute;
    ws.jobs = [
      ...(ws.jobs ?? []),
      {
        ...job,
        id: randomUUID(),
        addedDate: localDateKey(now),
        ...(alreadyPassedToday ? { lastRunDate: localDateKey(now) } : {}),
      },
    ];
    this.save();
  }

  removeJob(id: string, jobId: string): void {
    const ws = this.get(id);
    if (!ws) return;
    ws.jobs = (ws.jobs ?? []).filter((j) => j.id !== jobId);
    this.save();
  }

  toggleJob(id: string, jobId: string): void {
    const job = this.get(id)?.jobs?.find((j) => j.id === jobId);
    if (!job) return;
    job.enabled = !job.enabled;
    this.save();
  }

  markJobRan(id: string, jobId: string, date: string): void {
    const job = this.get(id)?.jobs?.find((j) => j.id === jobId);
    if (!job) return;
    job.lastRunDate = date;
    this.save();
  }

  /** A run finished successfully: stamp the day so the UI can tell a real
   *  briefing from a mere attempt. */
  markJobSucceeded(id: string, jobId: string, date: string): void {
    const job = this.get(id)?.jobs?.find((j) => j.id === jobId);
    if (!job) return;
    job.lastRunDate = date;
    job.lastSuccessDate = date;
    this.save();
  }

  /** Forget a job's ran-today stamp so catch-up semantics fire it again —
   *  used when a run failed (bounded retry) or died with the process. */
  clearJobRan(id: string, jobId: string): void {
    const job = this.get(id)?.jobs?.find((j) => j.id === jobId);
    if (!job?.lastRunDate) return;
    delete job.lastRunDate;
    this.save();
  }

  // ---- outbox ----

  listOutbox(): OutboxFile[] {
    const ws = this.active();
    if (!ws) return [];
    return listFilesIn(path.join(ws.path, "outbox"));
  }

  readOutbox(name: string): OutboxPreview {
    const file = this.outboxPath(name);
    const mime = PREVIEW_MIME[path.extname(name).toLowerCase()];
    if (mime) {
      // Base64 travels through one JSON-RPC message — bound it.
      if (fs.statSync(file).size > 15_000_000)
        return { kind: "binary", content: "" };
      return {
        kind: mime === "application/pdf" ? "pdf" : "image",
        mime,
        content: fs.readFileSync(file).toString("base64"),
      };
    }
    if (BINARY_EXTS.has(path.extname(name).toLowerCase()))
      return { kind: "binary", content: "" };
    return {
      kind: "markdown",
      content: fs.readFileSync(file, "utf8").slice(0, 50_000),
    };
  }

  /** Absolute path of an outbox file, containment-checked — for "open with
   *  the default app". */
  outboxPath(name: string): string {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    return safeJoin(path.join(ws.path, "outbox"), name);
  }

  /** Move an outbox draft to outbox/archive/ (never deletes). */
  archiveOutbox(name: string): void {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    const outbox = path.join(ws.path, "outbox");
    const src = safeJoin(outbox, name);
    const archive = path.join(outbox, "archive");
    fs.mkdirSync(archive, { recursive: true });
    // Unique target: archiving two drafts that shared a name must not
    // silently overwrite the first — this folder's contract is "never deletes".
    fs.renameSync(src, uniqueInboxPath(archive, path.basename(name)));
  }

  // ---- knowledge ----

  listKnowledge(): { docs: KnowledgeDoc[]; index: string } {
    const ws = this.active();
    if (!ws) return { docs: [], index: "" };
    const base = path.join(ws.path, "knowledge");
    const docs: KnowledgeDoc[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "originals") walk(full);
        } else if (entry.name.endsWith(".md") && entry.name !== "INDEX.md") {
          const st = fs.statSync(full);
          docs.push({
            path: path.relative(base, full),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      }
    };
    let index = "";
    try {
      walk(base);
      index = fs.readFileSync(path.join(base, "INDEX.md"), "utf8");
    } catch {
      // missing knowledge dir — return empties
    }
    return { docs: docs.sort((a, b) => a.path.localeCompare(b.path)), index };
  }

  readKnowledge(relPath: string, workspaceId?: string): string {
    return fs
      .readFileSync(this.resolveKnowledgePath(relPath, workspaceId), "utf8")
      .slice(0, 50_000);
  }

  /** Absolute path of a knowledge doc, containment-checked (safeJoin) — for
   *  callers outside this class (e.g. the reveal-in-Finder handler) that would
   *  otherwise join a webview-supplied path with no boundary check. Resolves
   *  in the active workspace unless a workspace is named (the settings graph
   *  viewer browses any workspace, never by falling back to the active one). */
  resolveKnowledgePath(relPath: string, workspaceId?: string): string {
    const ws = workspaceId ? this.get(workspaceId) : this.active();
    if (!ws)
      throw new Error(
        workspaceId ? "Unknown workspace." : "No active workspace.",
      );
    return safeJoin(path.join(ws.path, "knowledge"), relPath);
  }

  /** Save a chat message (or any text) into the brain as a note, with an INDEX line.
   *  Deterministic sibling of the ingest skill — no agent run required. */
  remember(text: string, title?: string): string {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    const body = text.trim();
    if (!body) throw new Error("Nothing to remember.");
    const base = path.join(ws.path, "knowledge");
    const notesDir = path.join(base, "notes");
    fs.mkdirSync(notesDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const heading = (title ?? body.split("\n")[0]).trim();
    const slug =
      heading
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "note";
    let rel = path.join("notes", `${date}-${slug}.md`);
    let n = 2;
    while (fs.existsSync(path.join(base, rel))) {
      rel = path.join("notes", `${date}-${slug}-${n++}.md`);
    }

    const summary = heading.replace(/\n/g, " ").slice(0, 80);
    const doc = `---\nsource: chat\ningested: ${date}\ntags: [note]\nentities: []\n---\n\n# ${summary}\n\n${body}\n`;
    fs.writeFileSync(path.join(base, rel), doc);
    this.appendIndexLine(base, `\`${rel}\` — ${summary}`);
    return rel;
  }

  /** Make sure INDEX.md has a line for a knowledge doc (no-op when present).
   *  Used by callers that write docs outside the ingest/remember flows, e.g.
   *  the auto-capture daily log. */
  ensureIndexLine(id: string, relPath: string, summary: string): void {
    const ws = this.get(id);
    if (!ws) return;
    const base = path.join(ws.path, "knowledge");
    try {
      if (
        fs
          .readFileSync(path.join(base, "INDEX.md"), "utf8")
          .includes(`\`${relPath}\``)
      )
        return;
    } catch {
      // missing INDEX — appendIndexLine creates it
    }
    const folder = relPath.includes("/") ? relPath.split("/")[0] : "notes";
    this.appendIndexLine(base, `\`${relPath}\` — ${summary}`, folder);
  }

  /** Append a doc line under a "## <folder>/" section in INDEX.md, creating the
   *  section if absent. */
  private appendIndexLine(base: string, line: string, folder = "notes"): void {
    const indexPath = path.join(base, "INDEX.md");
    let index = "";
    try {
      index = fs.readFileSync(indexPath, "utf8");
    } catch {
      index = "# Knowledge Index\n";
    }
    const heading = `## ${folder}/`;
    const section = new RegExp(
      `${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n+(?:_\\(empty\\)_\\n)?`,
    );
    if (section.test(index)) {
      // Drop the blank line + "_(empty)_" placeholder; prepend the new line.
      index = index.replace(section, `${heading}\n${line}\n`);
    } else {
      index = `${index.replace(/\s*$/, "")}\n\n${heading}\n\n${line}\n`;
    }
    fs.writeFileSync(indexPath, index);
  }

  // ---- skills ----

  /** App-scaffolded skills the agent needs on disk but the discoverability UI
   *  hides: artifact is a pure capability doc, and ingest is wired to better
   *  entry points (auto-runs on drops/sync/watch + Inbox panel's "Ingest now")
   *  than a foreground chat invocation. */
  private static readonly INTERNAL_SKILLS = new Set(["artifact", "ingest"]);

  /** Parse the workspace's .claude/skills/<name>/SKILL.md frontmatter for the
   *  discoverability UI (empty-state cards + composer palette). */
  listSkills(): SkillInfo[] {
    const ws = this.active();
    if (!ws) return [];
    const skillsDir = path.join(ws.path, ".claude", "skills");
    const disabled = new Set(ws.disabledSkills ?? []);
    const skills: SkillInfo[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        // Strip a leading BOM and tolerate CRLF line endings — either one
        // otherwise defeats the `^---\n` frontmatter match (blank name +
        // description, and a CRLF internal skill would slip the hidden filter).
        const md = fs
          .readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8")
          .replace(/^﻿/, "");
        const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const block = fm?.[1] ?? "";
        const name =
          block
            .match(/^name:\s*(.+)$/m)?.[1]
            ?.trim()
            .replace(/\r$/, "") ?? entry.name;
        if (WorkspaceManager.INTERNAL_SKILLS.has(name)) continue;
        const description =
          block
            .match(/^description:\s*(.+)$/m)?.[1]
            ?.trim()
            .replace(/\r$/, "") ?? "";
        skills.push({
          name,
          description,
          enabled: !disabled.has(name),
          system: SYSTEM_SKILL_DIRS.has(entry.name),
          // The CLI enforces both flags at run time; parsing them here keeps
          // the UI honest about how each skill can actually be started.
          manualOnly: /^disable-model-invocation:\s*true\s*$/im.test(block),
          userInvocable: !/^user-invocable:\s*false\s*$/im.test(block),
        });
      } catch {
        // no SKILL.md in this folder — skip
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Switch one skill off (or back on) for a workspace. Names are stored as
   *  written in the SKILL.md frontmatter — the same string the Skill tool
   *  receives, so the run-time denial can match on it. */
  setSkillEnabled(id: string, skill: string, enabled: boolean): void {
    const ws = this.get(id);
    if (!ws) return;
    const current = new Set(ws.disabledSkills ?? []);
    if (enabled) current.delete(skill);
    else current.add(skill);
    ws.disabledSkills = [...current];
    this.save();
  }

  /** Find the folder under .claude/skills whose frontmatter name (falling
   *  back to the folder name) matches — the same string the UI shows and the
   *  Skill tool receives. */
  private findSkillDir(wsPath: string, skill: string): string | null {
    const skillsDir = path.join(wsPath, ".claude", "skills");
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let name = entry.name;
      try {
        const md = fs
          .readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8")
          .replace(/^﻿/, "");
        const block = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
        name =
          block
            .match(/^name:\s*(.+)$/m)?.[1]
            ?.trim()
            .replace(/\r$/, "") ?? entry.name;
      } catch {
        // no readable SKILL.md — match on the folder name
      }
      if (name === skill) return path.join(skillsDir, entry.name);
    }
    return null;
  }

  /** Absolute path of a skill's SKILL.md, for revealing it in the Finder. */
  skillPath(id: string, skill: string): string | null {
    const ws = this.get(id);
    if (!ws) return null;
    const dir = this.findSkillDir(ws.path, skill);
    return dir ? path.join(dir, "SKILL.md") : null;
  }

  /** Delete a user-imported skill: its folder moves to the macOS Trash
   *  (recoverable, same convention as forgetKnowledge) and any disabled-flag
   *  for it is dropped. App-scaffolded skills are refused — switch those off
   *  instead. */
  deleteSkill(id: string, skill: string): void {
    const ws = this.get(id);
    if (!ws) throw new Error("Unknown workspace.");
    const dir = this.findSkillDir(ws.path, skill);
    if (!dir) throw new Error(`No skill named "${skill}".`);
    if (SYSTEM_SKILL_DIRS.has(path.basename(dir))) {
      throw new Error(
        `"${skill}" is a built-in skill — switch it off instead of deleting it.`,
      );
    }
    trashFile(dir, "monad-skill");
    if (ws.disabledSkills?.includes(skill)) {
      ws.disabledSkills = ws.disabledSkills.filter((s) => s !== skill);
      this.save();
    }
  }

  isSkillDisabled(id: string, skill: string): boolean {
    return (this.get(id)?.disabledSkills ?? []).includes(skill);
  }

  disabledSkills(id: string): string[] {
    return this.get(id)?.disabledSkills ?? [];
  }

  /** Staleness/coverage stats for the active workspace's knowledge base. */
  brainHealth(): BrainHealth {
    const ws = this.active();
    const empty: BrainHealth = { totalDocs: 0, byFolder: [], stalest: [] };
    if (!ws) return empty;
    const snap = this.knowledgeSnapshot(ws.id);
    const entries = Object.entries(snap);
    if (entries.length === 0) return empty;
    const byFolder = new Map<string, number>();
    for (const [p] of entries) {
      const folder = p.includes("/") ? p.split("/")[0] : "(root)";
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
    }
    return {
      totalDocs: entries.length,
      byFolder: [...byFolder.entries()]
        .map(([folder, count]) => ({ folder, count }))
        .sort((a, b) => b.count - a.count),
      lastIngestMs: Math.max(...entries.map(([, m]) => m)),
      stalest: entries
        .map(([p, mtimeMs]) => ({ path: p, mtimeMs }))
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .slice(0, 5),
    };
  }

  /** Overwrite a knowledge doc from the in-app editor. Ensures INDEX.md still
   *  has a line for the doc (edits can't drop it; missing lines get added). */
  writeKnowledge(relPath: string, content: string): void {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    const base = path.join(ws.path, "knowledge");
    const full = safeJoin(base, relPath);
    if (!fs.existsSync(full)) throw new Error(`No such document: ${relPath}`);
    fs.writeFileSync(full, content);
    try {
      const index = fs.readFileSync(path.join(base, "INDEX.md"), "utf8");
      if (!index.includes(relPath)) {
        const heading =
          content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(relPath, ".md");
        const folder = relPath.includes("/") ? relPath.split("/")[0] : "notes";
        this.appendIndexLine(
          base,
          `\`${relPath}\` — ${heading.slice(0, 80)}`,
          folder,
        );
      }
    } catch {
      // no INDEX.md — nothing to sync
    }
  }

  /** Save a pasted image/file as transient chat context (never ingested).
   *  Returns the absolute path for the agent to Read. */
  saveChatAttachment(name: string, base64: string): string {
    const target = this.chatAttachmentTarget(name);
    fs.writeFileSync(target, Buffer.from(base64, "base64"));
    return target;
  }

  /** Copy a file the user picked (composer + button) into the active
   *  workspace's attachments — same place and naming as pasted ones. */
  copyChatAttachment(source: string): string {
    const target = this.chatAttachmentTarget(path.basename(source));
    fs.copyFileSync(source, target);
    return target;
  }

  private chatAttachmentTarget(name: string): string {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    const dir = path.join(ws.path, ".monad", "attachments");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const safe = path.basename(name).replace(/[/\\]/g, "_") || "pasted.png";
    return uniqueInboxPath(dir, `${stamp}-${safe}`);
  }

  // ---- ingest review queue ----
  // Deterministic trust layer: the app snapshots knowledge/ before an ingest run
  // and diffs after, so the queue never depends on the agent self-reporting.

  /** knowledge/-relative path → mtimeMs, for diffing around an ingest run. */
  knowledgeSnapshot(id: string): Record<string, number> {
    const ws = this.get(id);
    if (!ws) return {};
    const snap: Record<string, number> = {};
    const base = path.join(ws.path, "knowledge");
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "originals") walk(full);
        } else if (entry.name.endsWith(".md") && entry.name !== "INDEX.md") {
          try {
            snap[path.relative(base, full)] = fs.statSync(full).mtimeMs;
          } catch {
            // vanished mid-walk (sync/user delete) — skip, don't wedge ingest
          }
        }
      }
    };
    walk(base);
    return snap;
  }

  /** Copy every knowledge doc aside before a background run, so a rejected
   *  UPDATE can be reverted to what it was rather than trashed with the
   *  user's original content in it. Returns the checkpoint dir to pass to
   *  queueReviewFromSnapshot (which consumes it). */
  checkpointKnowledge(id: string, snapshot: Record<string, number>): string {
    const ws = this.get(id);
    if (!ws) throw new Error("Unknown workspace.");
    const dir = path.join(
      ws.path,
      ".monad",
      "review-checkpoints",
      randomUUID(),
    );
    const base = path.join(ws.path, "knowledge");
    for (const rel of Object.keys(snapshot)) {
      try {
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(base, rel), target);
      } catch {
        // vanished since the snapshot — nothing to revert to
      }
    }
    return dir;
  }

  /** Drop a checkpoint whose run never started. */
  discardCheckpoint(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private previousVersionPath(wsPath: string, relPath: string): string {
    // safeJoin resolves symlinks against the real base, so the base must
    // exist (an absent one can't be realpath'd and every join would fail).
    const base = path.join(wsPath, ".monad", "review-previous");
    fs.mkdirSync(base, { recursive: true });
    return safeJoin(base, relPath);
  }

  /** Diff a pre-run snapshot against knowledge/ now and queue the changes.
   *  With a checkpoint, each updated doc keeps its pre-run version (the
   *  OLDEST one, if it was already pending from an earlier run) so reject
   *  can restore it; the checkpoint is consumed either way.
   *
   *  entityPagesFollowDocs (ingest runs): entity pages the run touched are
   *  by-products of its docs, so they are queued as hidden followers of the
   *  run instead of review items of their own — resolveReview settles them
   *  from the docs' decisions. A run that touched only entity pages has no
   *  doc to follow, so its pages stay reviewable. Returns the VISIBLE items. */
  queueReviewFromSnapshot(
    id: string,
    before: Record<string, number>,
    checkpointDir?: string,
    opts: { entityPagesFollowDocs?: boolean } = {},
  ): ReviewItem[] {
    const ws = this.get(id);
    const after = this.knowledgeSnapshot(id);
    const queuedAt = new Date().toISOString();
    const items: StoredReviewItem[] = [];
    for (const [p, mtime] of Object.entries(after)) {
      if (!(p in before)) items.push({ path: p, change: "new", queuedAt });
      else if (before[p] !== mtime)
        items.push({ path: p, change: "updated", queuedAt });
    }
    try {
      if (ws && checkpointDir) {
        for (const item of items) {
          if (item.change !== "updated") continue;
          const kept = this.previousVersionPath(ws.path, item.path);
          if (!fs.existsSync(kept)) {
            const copy = path.join(checkpointDir, item.path);
            if (!fs.existsSync(copy)) continue;
            fs.mkdirSync(path.dirname(kept), { recursive: true });
            fs.renameSync(copy, kept);
          }
          item.revertible = true;
        }
      }
    } finally {
      if (checkpointDir) this.discardCheckpoint(checkpointDir);
    }
    if (opts.entityPagesFollowDocs) {
      const docs = items.filter((i) => !isEntityPagePath(i.path));
      if (docs.length) {
        const run = randomUUID();
        for (const item of items) {
          item.runs = [run];
          if (isEntityPagePath(item.path)) item.derived = true;
        }
      }
    }
    if (items.length) {
      const queue = this.storedReview(id);
      const byPath = new Map(queue.map((i) => [i.path, i]));
      for (const item of items) {
        const pending = byPath.get(item.path);
        if (!pending) {
          queue.push(item);
          continue;
        }
        // Already pending keeps its place, but learns it's revertible once a
        // previous version has been kept, and joins this run — as a doc its
        // decision settles the run's pages; as a page it follows the run.
        if (item.revertible && pending.change === "updated")
          pending.revertible = true;
        if (item.runs && (pending.derived || !item.derived))
          pending.runs = [...new Set([...(pending.runs ?? []), ...item.runs])];
      }
      this.saveReview(id, ws ? this.sweepFollowers(ws.path, queue) : queue);
    }
    return items.filter((i) => !i.derived).map(publicReviewItem);
  }

  /** Every stored review entry (followers included); entries whose doc
   *  vanished are dropped lazily. */
  private storedReview(id: string): StoredReviewItem[] {
    const ws = this.get(id);
    if (!ws) return [];
    const items: StoredReviewItem[] =
      readJsonFile(this.reviewPath(ws.path)) ?? [];
    return items.filter((i) => {
      try {
        return fs.existsSync(safeJoin(path.join(ws.path, "knowledge"), i.path));
      } catch {
        return false;
      }
    });
  }

  /** Pending review items — what the user decides on. Entity pages that
   *  follow a doc are listed on that doc (`linked`), not as items. */
  listReview(id?: string): ReviewItem[] {
    const ws = id ? this.get(id) : this.active();
    if (!ws) return [];
    const stored = this.storedReview(ws.id);
    // A doc that vanished outside the review leaves its pages orphaned —
    // settle them here too, so nothing waits hidden forever.
    const swept = this.sweepFollowers(ws.path, stored);
    if (swept.length !== stored.length) this.saveReview(ws.id, swept);
    const followers = swept.filter((i) => i.derived);
    return swept
      .filter((i) => !i.derived)
      .map((i) => {
        const runs = i.runs ?? [];
        const linked = followers
          .filter((f) => f.runs?.some((r) => runs.includes(r)))
          .map((f) => this.pageTitle(ws.path, f.path));
        return {
          ...publicReviewItem(i),
          ...(linked.length && { linked }),
        };
      });
  }

  private pageTitle(wsPath: string, relPath: string): string {
    try {
      const text = fs.readFileSync(
        safeJoin(path.join(wsPath, "knowledge"), relPath),
        "utf8",
      );
      const h1 = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (h1) return h1;
    } catch {
      // unreadable — fall back to the file name
    }
    return path.basename(relPath, ".md").replace(/-/g, " ");
  }

  /** Accept keeps the doc. Reject restores a revertible update's previous
   *  version, and Trash-forgets anything else (a new doc). Either way the
   *  entry clears.
   *
   *  Entity pages following the doc's run settle with it: accepting marks
   *  them kept; rejecting strips the facts this run added that cite the doc.
   *  Once the run's last doc is decided, each follower is accepted if any of
   *  its source docs was, else undone exactly like a rejected item. */
  resolveReview(relPath: string, action: "accept" | "reject"): void {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    let queue = this.storedReview(ws.id);
    const item = queue.find((i) => i.path === relPath && !i.derived);
    this.settleReviewItem(ws.path, relPath, item, action);
    queue = queue.filter((i) => i !== item);
    const runs = item?.runs ?? [];
    for (const f of queue) {
      if (!f.derived || !f.runs?.some((r) => runs.includes(r))) continue;
      if (action === "accept") {
        f.kept = true;
        continue;
      }
      f.rejected = true;
      try {
        const page = safeJoin(path.join(ws.path, "knowledge"), f.path);
        const kept = this.previousVersionPath(ws.path, f.path);
        const previous = fs.existsSync(kept)
          ? fs.readFileSync(kept, "utf8")
          : "";
        const current = fs.readFileSync(page, "utf8");
        const stripped = stripRejectedFacts(current, previous, relPath);
        if (stripped !== current) fs.writeFileSync(page, stripped);
      } catch {
        // page vanished/unreadable — dropped by the next read
      }
    }
    this.saveReview(ws.id, this.sweepFollowers(ws.path, queue));
  }

  /** Settle every follower page whose runs have no undecided doc left:
   *  kept when any source doc was accepted, undone (restored / trashed) when
   *  they were rejected, kept when its docs simply vanished outside the
   *  review — an orphan never loses content by surprise. */
  private sweepFollowers(
    wsPath: string,
    queue: StoredReviewItem[],
  ): StoredReviewItem[] {
    const live = new Set(
      queue.filter((i) => !i.derived).flatMap((i) => i.runs ?? []),
    );
    return queue.filter((f) => {
      if (!f.derived) return true;
      f.runs = (f.runs ?? []).filter((r) => live.has(r));
      if (f.runs.length) return true;
      const reject = !f.kept && f.rejected === true;
      try {
        this.settleReviewItem(wsPath, f.path, f, reject ? "reject" : "accept");
      } catch (e) {
        console.error(`[review] settling ${f.path}: ${(e as Error).message}`);
      }
      return false;
    });
  }

  /** Apply one accept/reject to a doc: reject restores the kept previous
   *  version of a revertible update, else Trash-forgets the doc; the kept
   *  copy is dropped either way. */
  private settleReviewItem(
    wsPath: string,
    relPath: string,
    item: StoredReviewItem | undefined,
    action: "accept" | "reject",
  ): void {
    const kept = this.previousVersionPath(wsPath, relPath);
    const hasPrevious = item?.revertible === true && fs.existsSync(kept);
    if (action === "reject") {
      if (hasPrevious) {
        fs.copyFileSync(
          kept,
          safeJoin(path.join(wsPath, "knowledge"), relPath),
        );
      } else {
        this.forgetIn(wsPath, relPath);
      }
    }
    if (fs.existsSync(kept)) fs.rmSync(kept, { force: true });
  }

  private reviewPath(wsPath: string): string {
    return path.join(wsPath, ".monad", "review.json");
  }

  private saveReview(id: string, items: StoredReviewItem[]): void {
    const ws = this.get(id);
    if (!ws) return;
    writeJsonAtomic(this.reviewPath(ws.path), items);
  }

  /** "Forget": move the doc to the macOS Trash and drop its INDEX.md line. */
  forgetKnowledge(relPath: string): void {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    this.forgetIn(ws.path, relPath);
  }

  /** forgetKnowledge for a named workspace path — review settling can run
   *  for a background run's workspace while another one is active. */
  private forgetIn(wsPath: string, relPath: string): void {
    const base = path.join(wsPath, "knowledge");
    const src = safeJoin(base, relPath);
    // Individual docs only: a folder path here would trash a whole category
    // in one call, and the INDEX cleanup below is line-per-doc.
    if (!fs.statSync(src).isFile() || !src.endsWith(".md")) {
      throw new Error("Only individual .md knowledge docs can be forgotten.");
    }
    trashFile(src, "monad-forgotten");
    const indexPath = path.join(base, "INDEX.md");
    try {
      const lines = fs.readFileSync(indexPath, "utf8").split("\n");
      // Match the backticked path token, not a bare substring — forgetting
      // `client.md` must not also strip `important-client.md`'s line.
      fs.writeFileSync(
        indexPath,
        lines.filter((l) => !l.includes(`\`${relPath}\``)).join("\n"),
      );
    } catch {
      // no index — nothing to clean
    }
  }

  /** Files currently sitting in the active workspace's inbox. */
  listInbox(): { name: string; size: number; mtimeMs: number }[] {
    const ws = this.active();
    if (!ws) return [];
    const inbox = path.join(ws.path, "inbox");
    try {
      return fs
        .readdirSync(inbox)
        .filter((f) => !f.startsWith("."))
        .map((name) => {
          const st = fs.statSync(path.join(inbox, name));
          return { name, size: st.size, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  }

  /** Copy dropped file payloads into a workspace's inbox. Returns relative paths. */
  saveToInbox(files: { name: string; base64: string }[]): string[] {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    const inbox = path.join(ws.path, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const copied: string[] = [];
    for (const f of files) {
      const safe = path.basename(f.name).replace(/[/\\]/g, "_");
      let target = path.join(inbox, safe);
      let n = 2;
      while (fs.existsSync(target)) {
        const ext = path.extname(safe);
        target = path.join(inbox, `${path.basename(safe, ext)}-${n++}${ext}`);
      }
      fs.writeFileSync(target, Buffer.from(f.base64, "base64"));
      copied.push(path.relative(ws.path, target));
    }
    return copied;
  }

  /** Remove one inbox file — moved to the macOS Trash (same convention as forgetKnowledge). */
  deleteInboxFile(name: string): void {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    const base = path.basename(name);
    const src = safeJoin(path.join(ws.path, "inbox"), base);
    trashFile(src, "monad-inbox");
  }

  /** Move EVERY visible inbox file to the macOS Trash ("Clear all"). Returns
   *  how many moved; a file that vanishes mid-loop is skipped, not fatal. */
  clearInbox(): number {
    const ws = this.active();
    if (!ws) throw new Error("No active workspace.");
    const inbox = path.join(ws.path, "inbox");
    let moved = 0;
    for (const f of this.listInbox()) {
      try {
        trashFile(safeJoin(inbox, path.basename(f.name)), "monad-inbox");
        moved++;
      } catch {
        // keep clearing — the survivor stays visible in the list
      }
    }
    return moved;
  }

  /** One-time roll-out of the artifacts capability to workspaces that predate
   *  it: the auto-allow rule, the artifact skill, and the artifacts/ folder.
   *  Gated on a registry flag so a user's deliberate later removal of the rule
   *  or the skill is never resurrected. New workspaces get all of this via
   *  DEFAULT_ALWAYS_ALLOW and the scaffold template. */
  private migrateArtifacts(): void {
    const FLAG = "artifacts-v1";
    if (this.registry.migrations?.includes(FLAG)) return;
    for (const w of this.registry.workspaces) {
      if (w.alwaysAllow && !w.alwaysAllow.includes(ARTIFACTS_ALLOW_RULE)) {
        w.alwaysAllow.push(ARTIFACTS_ALLOW_RULE);
      }
      try {
        fs.mkdirSync(path.join(w.path, "artifacts"), { recursive: true });
        const skill = path.join(w.path, ".claude/skills/artifact/SKILL.md");
        if (!fs.existsSync(skill)) {
          fs.mkdirSync(path.dirname(skill), { recursive: true });
          fs.writeFileSync(skill, SKILL_ARTIFACT);
        }
      } catch {
        // workspace folder missing/unwritable — surfaced by health checks, not here
      }
    }
    this.registry.migrations = [...(this.registry.migrations ?? []), FLAG];
    this.save();
  }

  /** One-time roll-out of the working-memory snapshot + remember skill to
   *  workspaces that predate them (same gating as migrateArtifacts — a user's
   *  deliberate later deletion is never resurrected). */
  private migrateWorkingMemory(): void {
    const FLAG = "working-memory-v1";
    if (this.registry.migrations?.includes(FLAG)) return;
    for (const w of this.registry.workspaces) {
      try {
        const wm = path.join(w.path, WORKING_MEMORY_PATH);
        if (!fs.existsSync(wm)) {
          fs.mkdirSync(path.dirname(wm), { recursive: true });
          fs.writeFileSync(wm, workingMemoryTemplate());
        }
        const skill = path.join(w.path, ".claude/skills/remember/SKILL.md");
        if (!fs.existsSync(skill)) {
          fs.mkdirSync(path.dirname(skill), { recursive: true });
          fs.writeFileSync(skill, SKILL_REMEMBER);
        }
      } catch {
        // workspace folder missing/unwritable — surfaced by health checks
      }
    }
    this.registry.migrations = [...(this.registry.migrations ?? []), FLAG];
    this.save();
  }

  /** One-time roll-out of the memory-tools auto-allow rule (same gating as the
   *  artifacts migration; see migrateArtifacts). */
  private migrateMemoryTools(): void {
    const FLAG = "memory-search-v1";
    if (this.registry.migrations?.includes(FLAG)) return;
    for (const w of this.registry.workspaces) {
      if (w.alwaysAllow && !w.alwaysAllow.includes(MEMORY_ALLOW_RULE)) {
        w.alwaysAllow.push(MEMORY_ALLOW_RULE);
      }
    }
    this.registry.migrations = [...(this.registry.migrations ?? []), FLAG];
    this.save();
  }

  /** One-time roll-out of the email-card auto-allow rule (same gating as the
   *  artifacts migration; see migrateArtifacts). */
  private migrateEmailCard(): void {
    const FLAG = "email-draft-v1";
    if (this.registry.migrations?.includes(FLAG)) return;
    for (const w of this.registry.workspaces) {
      if (w.alwaysAllow && !w.alwaysAllow.includes(EMAIL_ALLOW_RULE)) {
        w.alwaysAllow.push(EMAIL_ALLOW_RULE);
      }
    }
    this.registry.migrations = [...(this.registry.migrations ?? []), FLAG];
    this.save();
  }

  /** One-time switch of the `twenty` connector from the community npx server
   *  to Twenty's official MCP endpoint. Only the exact entry we scaffolded is
   *  rewritten; a hand-customised one is left alone. */
  private migrateTwentyMcp(): void {
    const FLAG = "twenty-official-mcp-v1";
    if (this.registry.migrations?.includes(FLAG)) return;
    for (const w of this.registry.workspaces) {
      try {
        upgradeLegacyTwenty(w.path);
      } catch {
        // workspace folder missing/unwritable — surfaced by health checks
      }
    }
    this.registry.migrations = [...(this.registry.migrations ?? []), FLAG];
    this.save();
  }

  /** One-time roll-out of the knowledge graph: the knowledge/entities/ folder
   *  and the graph-aware ingest + brain-search skills. A skill file is only
   *  replaced when it is byte-identical to a version we shipped — any user
   *  edit keeps their file (the memory server's instructions still carry the
   *  graph conventions to every run, so an edited skill doesn't break it). */
  private migrateKnowledgeGraph(): void {
    // v2: v1 missed workspaces still on the first-generation templates; the
    // bump re-runs the (idempotent, unmodified-files-only) upgrade there.
    const FLAG = "knowledge-graph-v2";
    if (this.registry.migrations?.includes(FLAG)) return;
    const upgrades: { file: string; content: string; shipped: Set<string> }[] =
      [
        {
          file: ".claude/skills/ingest/SKILL.md",
          content: SKILL_INGEST,
          shipped: new Set([
            "70432ad831ae5d9c302a7da8bcf22c750016867c20f3585ab856b1a8a7db65b3",
            "c3796658b4059542697ca537e709de264d397a9c09148f42bb3c5be8fb765e74",
            "3672ca2a4f631b7961dace5632f852e4396a08f67960b8526a95c7f160823769",
          ]),
        },
        {
          file: ".claude/skills/brain-search/SKILL.md",
          content: SKILL_BRAIN_SEARCH,
          shipped: new Set([
            "0af1cba94c86aaa7bf211c307914243e5fc976b7260e65664dd4fba2ede0c460",
            "0c979b368c12efc2c063f6cbf30f50bee86ff098815f8ea1048f5d7b30268bf2",
            "6eac48beee3d6a4b2ba89831d204782aee6d51dd7afafd1f5f2b76e37e810267",
          ]),
        },
      ];
    for (const w of this.registry.workspaces) {
      try {
        fs.mkdirSync(path.join(w.path, "knowledge", "entities"), {
          recursive: true,
        });
        for (const u of upgrades) {
          const target = path.join(w.path, u.file);
          let current: string;
          try {
            current = fs.readFileSync(target, "utf8");
          } catch {
            continue; // deleted on purpose — never resurrected
          }
          const hash = new Bun.CryptoHasher("sha256")
            .update(current)
            .digest("hex");
          if (u.shipped.has(hash)) fs.writeFileSync(target, u.content);
        }
      } catch {
        // workspace folder missing/unwritable — surfaced by health checks
      }
    }
    this.registry.migrations = [...(this.registry.migrations ?? []), FLAG];
    this.save();
  }

  private scaffold(
    abs: string,
    {
      onlyMissing,
      overrides,
    }: { onlyMissing: boolean; overrides?: Record<string, string> },
  ) {
    for (const dir of WORKSPACE_DIRS)
      fs.mkdirSync(path.join(abs, dir), { recursive: true });
    for (const [rel, content] of Object.entries({
      ...WORKSPACE_TEMPLATE,
      ...overrides,
    })) {
      const target = path.join(abs, rel);
      if (onlyMissing && fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }

  private toInfo(w: Entry): WorkspaceInfo {
    return {
      id: w.id,
      name: w.name,
      path: w.path,
      active: w.id === this.registry.activeId,
      watchFolder: w.watchFolder,
      inboxTriggers: w.inboxTriggers ?? [],
      meetingPrep: w.meetingPrep,
      briefingFocus: w.briefingFocus,
      budgetUsd: w.budgetUsd,
      disabledSkills: w.disabledSkills ?? [],
      alwaysAllow: w.alwaysAllow ?? [...DEFAULT_ALWAYS_ALLOW],
      jobs: w.jobs ?? [],
      drive: w.drive
        ? {
            email: w.drive.email,
            folders: w.drive.folders ?? [],
            recursive: w.drive.recursive,
            lastSync: w.drive.lastSync,
            gmailLabels: w.drive.gmailLabels,
            needsReconnect: w.drive.needsReconnect,
          }
        : undefined,
    };
  }

  private load(): Registry {
    // Atomic + corruption-safe: a truncated/unparseable registry is
    // quarantined (never silently overwritten with an empty one), and a
    // transient read lock rethrows rather than presenting a false-empty
    // registry that the constructor's migrations would then save over.
    const reg = readJsonAtomic<Registry>(
      CONFIG,
      () => ({ workspaces: [], activeId: null }),
      { onCorrupt: (m) => console.error(`[workspaces] ${m}`) },
    );
    // migrate entries created before permissions existed
    for (const w of reg.workspaces) {
      if (!w.alwaysAllow) w.alwaysAllow = [...DEFAULT_ALWAYS_ALLOW];
      // Single Drive folder → the folders list. Derived purely from the old
      // fields, so it is idempotent and needs no migration flag: an entry that
      // is read but never re-saved simply migrates again next launch. The old
      // fields are dropped so there is only one source of truth. `recursive`
      // stays unset — an upgrade must not start pulling subfolders that the
      // user never asked for.
      if (w.drive?.folderId && !w.drive.folders) {
        w.drive.folders = [
          { id: w.drive.folderId, name: w.drive.folderName ?? "Drive folder" },
        ];
      }
      if (w.drive) {
        delete w.drive.folderId;
        delete w.drive.folderName;
      }
    }
    return reg;
  }

  private save() {
    writeJsonAtomic(CONFIG, this.registry);
  }
}

/** Move a file or folder to the user's Trash. `renameSync` fails with EXDEV
 *  when the source is on a different filesystem than ~/.Trash — a normal setup
 *  for a company brain on an external SSD or network share — so fall back to a
 *  cross-volume copy + remove. Returns the trash path. */
function trashFile(src: string, label: string): string {
  const dest = path.join(
    home(),
    ".Trash",
    `${label}-${Date.now()}-${path.basename(src)}`,
  );
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  return dest;
}

/** Outbox formats the preview dialog can render inline (beyond text). */
const PREVIEW_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** Known-binary formats with no inline preview — reading them as UTF-8 would
 *  show mojibake, so the dialog offers "open with the default app" instead. */
const BINARY_EXTS = new Set([
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".pages",
  ".numbers",
  ".key",
  ".zip",
  ".gz",
  ".tar",
  ".dmg",
  ".bin",
]);

/** A review entry as stored in .monad/review.json: the public item plus how
 *  it relates to ingest runs. A doc lists the runs that wrote it; an entity
 *  page that follows docs is `derived`, lists the runs it follows, and
 *  records the decisions so far — any source doc accepted (`kept`), any
 *  rejected (`rejected`). */
type StoredReviewItem = ReviewItem & {
  runs?: string[];
  derived?: boolean;
  kept?: boolean;
  rejected?: boolean;
};

function publicReviewItem(i: StoredReviewItem): ReviewItem {
  return {
    path: i.path,
    change: i.change,
    queuedAt: i.queuedAt,
    ...(i.revertible && { revertible: true }),
  };
}

const isEntityPagePath = (rel: string) =>
  rel.startsWith(`${ENTITY_PAGES_DIR}/`);

/** An entity page after one of its source docs was rejected: list-item
 *  lines that cite that doc as a wikilink ([[slug]], [[path/slug]],
 *  [[slug|text]], [[slug#heading]]) and were NOT on the page before the run
 *  are removed. Older facts, prose, and facts from other docs stay. */
export function stripRejectedFacts(
  current: string,
  previous: string,
  rejectedDocPath: string,
): string {
  const full = rejectedDocPath.replace(/\.md$/i, "").toLowerCase();
  const slug = full.split("/").pop() as string;
  const before = new Set(previous.split("\n").map((l) => l.trim()));
  const citesDoc = (line: string) =>
    [...line.matchAll(/\[\[([^\]|#]+)/g)].some((m) => {
      const target = m[1].trim().toLowerCase().replace(/\.md$/, "");
      return target === slug || target === full;
    });
  return current
    .split("\n")
    .filter(
      (line) =>
        !(
          /^\s*([-*+]|\d+\.)\s/.test(line) &&
          citesDoc(line) &&
          !before.has(line.trim())
        ),
    )
    .join("\n");
}

/** Join and refuse anything that escapes the base directory — lexically AND
 *  after resolving symlinks, so a symlink that arrived via git/Drive/a zip
 *  can't point a read or write outside the workspace. */
function safeJoin(base: string, rel: string): string {
  const root = path.resolve(base);
  const full = path.resolve(base, rel);
  if (!full.startsWith(root + path.sep)) {
    throw new Error("Invalid path.");
  }
  // Resolve symlinks through the deepest existing ancestor (a write target may
  // not exist yet) and re-check containment against the real base.
  const realRoot = realpathOrSelf(root);
  if (
    !realResolvePath(full).startsWith(realRoot + path.sep) &&
    realResolvePath(full) !== realRoot
  ) {
    throw new Error("Invalid path.");
  }
  return full;
}

/** realpath, or the path unchanged if it can't be resolved (doesn't exist). */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolve symlinks through the deepest existing ancestor; re-join the
 *  non-existent tail onto the real ancestor. */
function realResolvePath(p: string): string {
  let current = p;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current)
        return suffix.length ? path.join(current, ...suffix) : current;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function readJsonFile(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Collision-safe target path inside inbox/ (same convention as saveToInbox). */
function uniqueInboxPath(inbox: string, name: string): string {
  const safe = path.basename(name).replace(/[/\\]/g, "_");
  let target = path.join(inbox, safe);
  let n = 2;
  while (fs.existsSync(target)) {
    const ext = path.extname(safe);
    target = path.join(inbox, `${path.basename(safe, ext)}-${n++}${ext}`);
  }
  return target;
}

function listFilesIn(
  dir: string,
): { name: string; size: number; mtimeMs: number }[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return { name: e.name, size: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}
