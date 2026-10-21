import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** Skill-pack and whole-brain zip import/export.
 *
 *  Zips are made with the macOS-bundled `zip`/`unzip` so exports open anywhere
 *  and imports accept anything. A "skill pack" is just a folder tree containing
 *  `<skill-name>/SKILL.md` dirs — which is exactly what .claude/skills already
 *  is, so the consultancy deliverable format is the on-disk format. */
export class Packs {
  /** Zip the workspace's .claude/skills → destDir/<name>-skills.zip. */
  exportSkills(
    workspacePath: string,
    workspaceName: string,
    destDir: string,
  ): string {
    const skillsDir = path.join(workspacePath, ".claude", "skills");
    if (!fs.existsSync(skillsDir))
      throw new Error("This workspace has no skills to export.");
    const dest = uniqueZip(destDir, `${slug(workspaceName)}-skills`);
    execFileSync("zip", ["-r", dest, "."], { cwd: skillsDir });
    return dest;
  }

  /** Import skills from a .zip, a folder, or a git URL. Existing skill names
   *  are never overwritten — they land in `skipped`. */
  importSkills(
    workspacePath: string,
    source: string,
  ): { added: string[]; skipped: string[] } {
    const src = source.trim();
    if (!src) throw new Error("Give a zip file, a folder, or a git URL.");
    let root: string;
    let cleanup: string | null = null;
    if (/^(https?:\/\/|git@)/.test(src)) {
      root = cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "monad-pack-"));
      const archiveUrl = githubArchiveUrl(src);
      if (archiveUrl) {
        // GitHub (and skills.sh) repos come down as a zip archive: curl and
        // unzip ship with macOS, unlike git, which is an Xcode CLT shim.
        const zip = path.join(root, "_pack.zip");
        try {
          execFileSync("curl", ["-fsSL", archiveUrl, "-o", zip], {
            stdio: "pipe",
          });
        } catch {
          throw new Error(
            `Could not download ${archiveUrl} — check the URL and that the repo is public.`,
          );
        }
        execFileSync("unzip", ["-q", zip, "-d", root]);
        fs.rmSync(zip);
      } else {
        try {
          execFileSync("git", ["clone", "--depth", "1", src, root], {
            stdio: "pipe",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/xcrun|invalid active developer path|ENOENT/.test(msg)) {
            throw new Error(
              "git isn't available on this Mac (Xcode Command Line Tools not installed). " +
                "Run `xcode-select --install` in Terminal, or paste a github.com URL — those don't need git.",
            );
          }
          throw err;
        }
      }
    } else if (src.toLowerCase().endsWith(".zip")) {
      if (!fs.existsSync(src)) throw new Error(`No such file: ${src}`);
      root = cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "monad-pack-"));
      execFileSync("unzip", ["-q", src, "-d", root]);
    } else {
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
        throw new Error(`Not a folder, zip, or git URL: ${src}`);
      }
      root = src;
    }
    try {
      const found = findSkillDirs(root, 4);
      if (found.length === 0) {
        throw new Error(
          "No skills found (looked for <name>/SKILL.md folders).",
        );
      }
      const targetBase = path.join(workspacePath, ".claude", "skills");
      fs.mkdirSync(targetBase, { recursive: true });
      const added: string[] = [];
      const skipped: string[] = [];
      for (const dir of found) {
        const name = skillName(dir);
        if (!name) {
          skipped.push(path.basename(dir));
          continue;
        }
        const target = path.join(targetBase, name);
        if (fs.existsSync(target)) {
          skipped.push(name);
          continue;
        }
        fs.cpSync(dir, target, { recursive: true });
        added.push(name);
      }
      return { added, skipped };
    } finally {
      if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
    }
  }

  /** Zip the whole brain minus secrets, app state, and archived originals.
   *  This is the "here is your company brain" deliverable. */
  exportWorkspace(
    workspacePath: string,
    workspaceName: string,
    destDir: string,
  ): string {
    const dest = uniqueZip(destDir, `${slug(workspaceName)}-brain`);
    // Exclude every secret shape, not just a bare ".env": .env.local,
    // .env.production, nested sub/.env, and local settings all leak
    // credentials in the "here is your company brain" deliverable. zip applies
    // -x globs against the full relative path, so cover both root and nested.
    execFileSync(
      "zip",
      [
        "-r",
        dest,
        ".",
        "-x",
        ".env",
        ".env.*",
        "*/.env",
        "*/.env.*",
        ".claude/settings.local.json",
        "*/.claude/settings.local.json",
        ".monad/*",
        ".git/*",
        "knowledge/originals/*",
        "*.DS_Store",
        "node_modules/*",
      ],
      { cwd: workspacePath },
    );
    // .env.example is a safe template (no real values) and useful to ship —
    // re-add it after the .env.* exclusion swept it out.
    if (fs.existsSync(path.join(workspacePath, ".env.example"))) {
      execFileSync("zip", [dest, ".env.example"], { cwd: workspacePath });
    }
    return dest;
  }

  /** Unzip an exported brain into parentDir/name; returns the new path.
   *  Registration (and the missing-credentials amber rows) is the caller's job. */
  importWorkspace(zipPath: string, parentDir: string, name: string): string {
    if (!fs.existsSync(zipPath)) throw new Error(`No such file: ${zipPath}`);
    const safe = name.trim().replace(/[/\\:]/g, "-");
    if (!safe) throw new Error("Workspace name is required.");
    const target = path.join(path.resolve(parentDir), safe);
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      throw new Error(`Folder already exists and is not empty: ${target}`);
    }
    fs.mkdirSync(target, { recursive: true });
    execFileSync("unzip", ["-q", zipPath, "-d", target]);
    return target;
  }
}

/** Zip-archive URL for a GitHub repo, so imports work without git installed.
 *  Accepts github.com https/ssh URLs and skills.sh listing pages (which are
 *  `skills.sh/<owner>/<repo>/<skill>`, mirroring a GitHub repo). Returns null
 *  for anything else — those still go through `git clone`. */
function githubArchiveUrl(src: string): string | null {
  const m =
    /^https?:\/\/(?:www\.)?(?:github\.com|skills\.sh)\/([^/\s]+)\/([^/\s]+)/.exec(
      src,
    ) ?? /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(src);
  if (!m) return null;
  const [, owner, repo] = m;
  return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}/archive/HEAD.zip`;
}

/** Directories containing a SKILL.md, searched a few levels deep (zips and git
 *  repos may nest, e.g. repo/.claude/skills/<name> or pack/<name>). */
function findSkillDirs(root: string, depth: number): string[] {
  if (depth < 0) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) out.push(root);
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules")
      continue;
    out.push(...findSkillDirs(path.join(root, e.name), depth - 1));
  }
  return out;
}

/** The skill's install name: its SKILL.md frontmatter `name:` when present
 *  (so a zip extracted to a temp dir doesn't inherit that dir's random name),
 *  else the folder basename. Rejects path separators and leading dots so a
 *  crafted name can't escape the skills directory; returns null if unusable. */
function skillName(dir: string): string | null {
  let candidate = path.basename(dir);
  try {
    const md = fs
      .readFileSync(path.join(dir, "SKILL.md"), "utf8")
      .replace(/^﻿/, "");
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fromFm = fm?.[1]
      ?.match(/^name:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/\r$/, "");
    if (fromFm) candidate = fromFm;
  } catch {
    // no readable SKILL.md — fall back to the basename
  }
  if (/[/\\]/.test(candidate) || candidate.startsWith(".") || !candidate)
    return null;
  return candidate;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

function uniqueZip(destDir: string, base: string): string {
  let target = path.join(destDir, `${base}.zip`);
  let n = 2;
  while (fs.existsSync(target))
    target = path.join(destDir, `${base}-${n++}.zip`);
  return target;
}
