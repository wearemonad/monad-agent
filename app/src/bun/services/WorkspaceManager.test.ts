import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** WorkspaceManager persists its registry under $HOME (Library/Application
 *  Support) and "forget" moves files to $HOME/.Trash — so the whole suite runs
 *  against a throwaway HOME, set BEFORE the module is imported (the config path
 *  is resolved at import time). */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "monad-wm-test-"));
process.env.HOME = fakeHome;

const { WorkspaceManager, stripRejectedFacts } = await import(
  "./WorkspaceManager"
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-ws-test-"));
const wsDir = path.join(root, "brain");
const watchDir = path.join(root, "watched");

let wm: InstanceType<typeof WorkspaceManager>;
let wsId: string;

beforeAll(() => {
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".Trash"), { recursive: true });
  wm = new WorkspaceManager();
  const info = wm.add(wsDir, "TestCo");
  wsId = info.id;
  wm.setActive(wsId);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("scaffolding", () => {
  test("add() scaffolds the workspace structure", () => {
    expect(fs.existsSync(path.join(wsDir, "inbox"))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, "knowledge", "INDEX.md"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(wsDir, ".claude", "skills", "ingest", "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("create() with a template id writes the vertical CLAUDE.md", () => {
    const info = wm.create(root, "SaaSCo", "saas");
    const md = fs.readFileSync(path.join(info.path, "CLAUDE.md"), "utf8");
    expect(md).toContain("Product & metrics");
    expect(md).toContain("## Operating rules"); // shared safety sections kept
    wm.remove(info.id);
  });
});

describe("deleteBlockedReason", () => {
  test("allows a scaffolded workspace folder", () => {
    expect(wm.deleteBlockedReason(wsId)).toBeNull();
  });

  test("refuses an unknown id", () => {
    expect(wm.deleteBlockedReason("nope")).toMatch(/no longer registered/);
  });

  test("refuses a folder missing the brain markers", () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain, { recursive: true });
    const info = wm.add(plain, "Plain");
    // add() scaffolds, so strip the markers back off to model a folder that
    // was registered and then emptied out.
    fs.rmSync(path.join(plain, "CLAUDE.md"), { force: true });
    expect(wm.deleteBlockedReason(info.id)).toMatch(/no CLAUDE\.md/);
    fs.rmSync(path.join(plain, "knowledge"), { recursive: true, force: true });
    expect(wm.deleteBlockedReason(info.id)).toMatch(/no CLAUDE\.md/);
    wm.remove(info.id);
  });

  test("refuses a home-level container folder even when scaffolded", () => {
    const docs = path.join(fakeHome, "Documents");
    fs.mkdirSync(docs, { recursive: true });
    const info = wm.add(docs, "Docs");
    expect(wm.deleteBlockedReason(info.id)).toMatch(/top-level folder/);
    wm.remove(info.id);
  });

  test("refuses a folder that no longer exists", () => {
    const gone = path.join(root, "gone");
    fs.mkdirSync(gone, { recursive: true });
    const info = wm.add(gone, "Gone");
    fs.rmSync(gone, { recursive: true, force: true });
    expect(wm.deleteBlockedReason(info.id)).toMatch(/no longer exists/);
    wm.remove(info.id);
  });
});

describe("skill activation", () => {
  const skillsDir = () => path.join(wsDir, ".claude", "skills");
  const writeSkill = (name: string) => {
    fs.mkdirSync(path.join(skillsDir(), name), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir(), name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Does ${name} things.\n---\n`,
    );
  };

  test("skills are enabled until switched off, and the flag survives toInfo", () => {
    writeSkill("crm-status");
    writeSkill("morning-briefing");
    expect(wm.listSkills().every((s) => s.enabled)).toBe(true);
    expect(wm.listSkills().map((s) => s.name)).toContain("crm-status");

    wm.setSkillEnabled(wsId, "crm-status", false);
    expect(wm.listSkills().find((s) => s.name === "crm-status")?.enabled).toBe(
      false,
    );
    expect(wm.isSkillDisabled(wsId, "crm-status")).toBe(true);
    expect(wm.isSkillDisabled(wsId, "morning-briefing")).toBe(false);
    expect(wm.disabledSkills(wsId)).toEqual(["crm-status"]);
    expect(wm.list().find((w) => w.id === wsId)?.disabledSkills).toEqual([
      "crm-status",
    ]);

    // Switching the same skill off twice must not duplicate the entry.
    wm.setSkillEnabled(wsId, "crm-status", false);
    expect(wm.disabledSkills(wsId)).toEqual(["crm-status"]);

    wm.setSkillEnabled(wsId, "crm-status", true);
    expect(wm.isSkillDisabled(wsId, "crm-status")).toBe(false);
    fs.rmSync(path.join(skillsDir(), "crm-status"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(skillsDir(), "morning-briefing"), {
      recursive: true,
      force: true,
    });
  });
});

describe("always-allow rules", () => {
  test("exact match and * prefix patterns", () => {
    wm.setAlwaysAllow(wsId, ["Read", "mcp__twenty__*"]);
    expect(wm.isAlwaysAllowed(wsId, "Read")).toBe(true);
    expect(wm.isAlwaysAllowed(wsId, "ReadFile")).toBe(false);
    expect(wm.isAlwaysAllowed(wsId, "mcp__twenty__find_records")).toBe(true);
    expect(wm.isAlwaysAllowed(wsId, "mcp__posthog__query")).toBe(false);
  });
});

describe("remember()", () => {
  test("writes a note with frontmatter and an INDEX line", () => {
    const rel = wm.remember("We agreed Acme pays net-30.\nDetails follow.");
    const doc = fs.readFileSync(path.join(wsDir, "knowledge", rel), "utf8");
    expect(rel).toMatch(
      /^notes\/\d{4}-\d{2}-\d{2}-we-agreed-acme-pays-net-30\.md$/,
    );
    expect(doc).toContain("source: chat");
    expect(doc).toContain("We agreed Acme pays net-30.");
    const index = fs.readFileSync(
      path.join(wsDir, "knowledge", "INDEX.md"),
      "utf8",
    );
    expect(index).toContain(rel);
  });

  test("collision gets a -2 suffix", () => {
    const a = wm.remember("Same title");
    const b = wm.remember("Same title");
    expect(a).not.toBe(b);
    expect(b).toContain("-2");
  });

  test("empty text throws", () => {
    expect(() => wm.remember("   ")).toThrow();
  });
});

describe("watch folder", () => {
  test("rejects a folder inside the workspace", () => {
    expect(() => wm.setWatchFolder(wsId, path.join(wsDir, "inbox"))).toThrow();
  });

  test("copies new files once, re-copies changed files under a new name", () => {
    wm.setWatchFolder(wsId, watchDir);
    const old = (Date.now() - 10_000) / 1000;
    fs.writeFileSync(path.join(watchDir, "doc.txt"), "v1");
    fs.utimesSync(path.join(watchDir, "doc.txt"), old, old);

    expect(wm.pullWatchFolder(wsId)).toEqual(["doc.txt"]);
    expect(wm.pullWatchFolder(wsId)).toEqual([]); // already synced

    fs.writeFileSync(path.join(watchDir, "doc.txt"), "v2 changed");
    fs.utimesSync(path.join(watchDir, "doc.txt"), old + 5, old + 5);
    expect(wm.pullWatchFolder(wsId)).toEqual(["doc-2.txt"]);
  });

  test("skips files modified in the last 2 seconds (still being written)", () => {
    fs.writeFileSync(path.join(watchDir, "hot.txt"), "downloading…");
    expect(wm.pullWatchFolder(wsId)).toEqual([]);
  });
});

describe("review queue", () => {
  test("diffs a snapshot into new/updated items and resolves them", () => {
    const kDir = path.join(wsDir, "knowledge", "clients");
    fs.writeFileSync(path.join(kDir, "acme.md"), "before");
    const before = wm.knowledgeSnapshot(wsId);

    fs.writeFileSync(path.join(kDir, "fresh.md"), "new doc");
    fs.writeFileSync(path.join(kDir, "acme.md"), "after edit");
    // ensure a different mtime even on coarse filesystems
    const later = (Date.now() + 1500) / 1000;
    fs.utimesSync(path.join(kDir, "acme.md"), later, later);

    const queued = wm.queueReviewFromSnapshot(wsId, before);
    const byPath = Object.fromEntries(queued.map((i) => [i.path, i.change]));
    expect(byPath["clients/fresh.md"]).toBe("new");
    expect(byPath["clients/acme.md"]).toBe("updated");

    wm.resolveReview("clients/fresh.md", "accept");
    expect(fs.existsSync(path.join(kDir, "fresh.md"))).toBe(true);
    expect(wm.listReview(wsId).some((i) => i.path === "clients/fresh.md")).toBe(
      false,
    );

    fs.writeFileSync(
      path.join(wsDir, "knowledge", "INDEX.md"),
      "`clients/acme.md` — acme\n",
    );
    wm.resolveReview("clients/acme.md", "reject");
    expect(fs.existsSync(path.join(kDir, "acme.md"))).toBe(false); // trashed
    expect(
      fs.readFileSync(path.join(wsDir, "knowledge", "INDEX.md"), "utf8"),
    ).not.toContain("acme.md");
  });

  test("INDEX.md and originals/ never appear in snapshots", () => {
    const snap = wm.knowledgeSnapshot(wsId);
    expect(Object.keys(snap).some((p) => p.includes("INDEX.md"))).toBe(false);
    expect(Object.keys(snap).some((p) => p.startsWith("originals"))).toBe(
      false,
    );
  });
});

describe("deleteInboxFile", () => {
  test("moves the file to the Trash and out of listInbox", () => {
    const inbox = path.join(wsDir, "inbox");
    fs.writeFileSync(path.join(inbox, "note.txt"), "hello");
    expect(wm.listInbox().map((f) => f.name)).toContain("note.txt");

    wm.deleteInboxFile("note.txt");

    expect(wm.listInbox().map((f) => f.name)).not.toContain("note.txt");
    const trashed = fs.readdirSync(path.join(fakeHome, ".Trash"));
    expect(
      trashed.some(
        (f) => f.startsWith("monad-inbox-") && f.endsWith("note.txt"),
      ),
    ).toBe(true);
  });

  test("path traversal is neutralized to the basename", () => {
    // "../CLAUDE.md" must not reach the workspace root; the basename does not
    // exist in inbox/, so the rename throws — and CLAUDE.md survives.
    expect(() => wm.deleteInboxFile("../CLAUDE.md")).toThrow();
    expect(fs.existsSync(path.join(wsDir, "CLAUDE.md"))).toBe(true);
  });

  test("missing file throws instead of silently succeeding", () => {
    expect(() => wm.deleteInboxFile("never-existed.pdf")).toThrow();
  });
});

describe("inbox triggers", () => {
  test("extension and substring matching produce ingest extras", () => {
    wm.addInboxTrigger(wsId, "*.vtt", "Draft follow-ups from the transcript");
    wm.addInboxTrigger(wsId, "acme", "Flag anything about the Acme renewal");

    const extras = wm.triggerPromptsFor(wsId, [
      "standup-2026.VTT",
      "invoice-ACME.pdf",
      "notes.md",
    ]);
    expect(extras).toHaveLength(2);
    expect(extras[0]).toContain("Draft follow-ups");
    expect(extras[0]).toContain("standup-2026.VTT");
    expect(extras[1]).toContain("invoice-ACME.pdf");

    expect(wm.triggerPromptsFor(wsId, ["plain.md"])).toEqual([]);

    for (const t of wm.get(wsId)!.inboxTriggers!)
      wm.removeInboxTrigger(wsId, t.id);
    expect(wm.triggerPromptsFor(wsId, ["standup.vtt"])).toEqual([]);
  });

  test("empty match or prompt is rejected", () => {
    expect(() => wm.addInboxTrigger(wsId, " ", "do things")).toThrow();
    expect(() => wm.addInboxTrigger(wsId, "*.pdf", " ")).toThrow();
  });
});

describe("budget & meeting prep knobs", () => {
  test("persist through toInfo and clear cleanly", () => {
    wm.setBudget(wsId, 25);
    wm.setMeetingPrep(wsId, true);
    let info = wm.list().find((w) => w.id === wsId)!;
    expect(info.budgetUsd).toBe(25);
    expect(info.meetingPrep).toBe(true);

    wm.setBudget(wsId, undefined);
    wm.setMeetingPrep(wsId, false);
    info = wm.list().find((w) => w.id === wsId)!;
    expect(info.budgetUsd).toBeUndefined();
    expect(info.meetingPrep).toBe(false);
  });

  test("briefing focus defaults on; off is stored, on clears the entry", () => {
    expect(wm.briefingFocusEnabled(wsId)).toBe(true);

    wm.setBriefingFocus(wsId, false);
    expect(wm.briefingFocusEnabled(wsId)).toBe(false);
    expect(wm.list().find((w) => w.id === wsId)!.briefingFocus).toBe(false);

    // Re-enabling returns to the default-by-absence representation.
    wm.setBriefingFocus(wsId, true);
    expect(wm.briefingFocusEnabled(wsId)).toBe(true);
    expect(wm.list().find((w) => w.id === wsId)!.briefingFocus).toBeUndefined();
  });
});

describe("brain health", () => {
  test("counts by folder and surfaces the stalest docs", () => {
    const health = wm.brainHealth();
    expect(health.totalDocs).toBeGreaterThan(0);
    expect(health.byFolder.reduce((n, f) => n + f.count, 0)).toBe(
      health.totalDocs,
    );
    expect(health.stalest.length).toBeGreaterThan(0);
    // stalest is sorted oldest-first
    const times = health.stalest.map((d) => d.mtimeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("writeKnowledge", () => {
  test("overwrites content and adds a missing INDEX line under the folder", () => {
    const kDir = path.join(wsDir, "knowledge", "finance");
    fs.mkdirSync(kDir, { recursive: true });
    fs.writeFileSync(path.join(kDir, "vat.md"), "# VAT\nold");
    fs.writeFileSync(
      path.join(wsDir, "knowledge", "INDEX.md"),
      "# Knowledge Index\n",
    );

    wm.writeKnowledge(
      "finance/vat.md",
      "# VAT returns\nquarterly, due the 7th",
    );
    expect(fs.readFileSync(path.join(kDir, "vat.md"), "utf8")).toContain(
      "due the 7th",
    );
    const index = fs.readFileSync(
      path.join(wsDir, "knowledge", "INDEX.md"),
      "utf8",
    );
    expect(index).toContain("## finance/");
    expect(index).toContain("finance/vat.md");
  });

  test("refuses paths outside knowledge/ and missing docs", () => {
    expect(() => wm.writeKnowledge("../CLAUDE.md", "pwned")).toThrow();
    expect(() => wm.writeKnowledge("finance/none.md", "x")).toThrow(/No such/);
  });
});

describe("chat attachments", () => {
  test("saves under .monad/attachments and returns the absolute path", () => {
    const p = wm.saveChatAttachment(
      "shot.png",
      Buffer.from("png-bytes").toString("base64"),
    );
    expect(p.startsWith(path.join(wsDir, ".monad", "attachments"))).toBe(true);
    expect(p.endsWith("-shot.png")).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("png-bytes");
  });
});

describe("listSkills", () => {
  test("parses SKILL.md frontmatter, sorted by name", () => {
    const skills = wm.listSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.name === "brain-search")).toBe(true);
    const names = skills.map((s) => s.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  test("hides internal skills (artifact, ingest) from the UI list", () => {
    const names = wm.listSkills().map((s) => s.name);
    expect(names).not.toContain("artifact");
    expect(names).not.toContain("ingest");
  });

  test("flags app-scaffolded skills as system", () => {
    const skills = wm.listSkills();
    expect(skills.find((s) => s.name === "brain-search")?.system).toBe(true);
  });

  test("parses disable-model-invocation and user-invocable frontmatter", () => {
    const dir = path.join(wsDir, ".claude", "skills", "manual-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: manual-skill\ndescription: test\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n",
    );
    const s = wm.listSkills().find((x) => x.name === "manual-skill");
    expect(s?.manualOnly).toBe(true);
    expect(s?.userInvocable).toBe(false);
    // Skills without the flags get the permissive defaults.
    const sys = wm.listSkills().find((x) => x.name === "brain-search");
    expect(sys?.manualOnly).toBe(false);
    expect(sys?.userInvocable).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("deleteSkill", () => {
  const userSkillDir = path.join(wsDir, ".claude", "skills", "my-pack-skill");

  test("moves a user-imported skill to the Trash and clears its disabled flag", () => {
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSkillDir, "SKILL.md"),
      "---\nname: my-pack-skill\ndescription: test\n---\nbody\n",
    );
    expect(
      wm.listSkills().find((s) => s.name === "my-pack-skill")?.system,
    ).toBe(false);
    wm.setSkillEnabled(wsId, "my-pack-skill", false);

    wm.deleteSkill(wsId, "my-pack-skill");

    expect(fs.existsSync(userSkillDir)).toBe(false);
    const trashed = fs
      .readdirSync(path.join(fakeHome, ".Trash"))
      .filter((f) => f.includes("my-pack-skill"));
    expect(trashed.length).toBe(1);
    expect(wm.disabledSkills(wsId)).not.toContain("my-pack-skill");
    expect(wm.listSkills().some((s) => s.name === "my-pack-skill")).toBe(false);
  });

  test("refuses system skills and unknown names", () => {
    expect(() => wm.deleteSkill(wsId, "brain-search")).toThrow(/built-in/);
    expect(
      fs.existsSync(path.join(wsDir, ".claude", "skills", "brain-search")),
    ).toBe(true);
    expect(() => wm.deleteSkill(wsId, "no-such-skill")).toThrow(/No skill/);
  });
});

describe("knowledge-graph migration", () => {
  const registryFile = path.join(
    fakeHome,
    "Library/Application Support/Monad/workspaces.json",
  );
  const rerunMigration = () => {
    const reg = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    reg.migrations = (reg.migrations ?? []).filter(
      (m: string) => m !== "knowledge-graph-v2",
    );
    fs.writeFileSync(registryFile, JSON.stringify(reg));
    return new WorkspaceManager();
  };

  test("creates knowledge/entities and keeps a user-edited skill", () => {
    const skill = path.join(wsDir, ".claude/skills/ingest/SKILL.md");
    fs.writeFileSync(skill, "my own ingest rules");
    fs.rmSync(path.join(wsDir, "knowledge/entities"), {
      recursive: true,
      force: true,
    });
    rerunMigration();
    expect(fs.existsSync(path.join(wsDir, "knowledge/entities"))).toBe(true);
    expect(fs.readFileSync(skill, "utf8")).toBe("my own ingest rules");
  });

  test("never resurrects a deleted skill", () => {
    const dir = path.join(wsDir, ".claude/skills/brain-search");
    fs.rmSync(dir, { recursive: true, force: true });
    rerunMigration();
    expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(false);
  });
});

describe("review checkpoints", () => {
  const doc = path.join(wsDir, "knowledge/clients/checkpoint-test.md");

  test("rejecting an UPDATE restores the previous version instead of trashing", () => {
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, "original content");
    const before = wm.knowledgeSnapshot(wsId);
    const cp = wm.checkpointKnowledge(wsId, before);
    fs.writeFileSync(doc, "original content + [[Acme GmbH]] link");
    // force a distinct mtime even on coarse filesystems
    fs.utimesSync(doc, new Date(), new Date(Date.now() + 5_000));
    const queued = wm.queueReviewFromSnapshot(wsId, before, cp);
    const item = queued.find((i) => i.path === "clients/checkpoint-test.md");
    expect(item).toMatchObject({ change: "updated", revertible: true });
    expect(fs.existsSync(cp)).toBe(false); // checkpoint consumed
    wm.resolveReview("clients/checkpoint-test.md", "reject");
    expect(fs.readFileSync(doc, "utf8")).toBe("original content");
  });

  test("accepting keeps the new version and drops the kept copy", () => {
    const before = wm.knowledgeSnapshot(wsId);
    const cp = wm.checkpointKnowledge(wsId, before);
    fs.writeFileSync(doc, "edited");
    fs.utimesSync(doc, new Date(), new Date(Date.now() + 10_000));
    wm.queueReviewFromSnapshot(wsId, before, cp);
    wm.resolveReview("clients/checkpoint-test.md", "accept");
    expect(fs.readFileSync(doc, "utf8")).toBe("edited");
    expect(
      fs.existsSync(
        path.join(wsDir, ".monad/review-previous/clients/checkpoint-test.md"),
      ),
    ).toBe(false);
  });

  test("rejecting a NEW doc still trashes it", () => {
    const before = wm.knowledgeSnapshot(wsId);
    const cp = wm.checkpointKnowledge(wsId, before);
    const fresh = path.join(wsDir, "knowledge/entities/new-entity.md");
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    fs.writeFileSync(fresh, "# New");
    const queued = wm.queueReviewFromSnapshot(wsId, before, cp);
    expect(
      queued.find((i) => i.path === "entities/new-entity.md")?.change,
    ).toBe("new");
    wm.resolveReview("entities/new-entity.md", "reject");
    expect(fs.existsSync(fresh)).toBe(false);
  });
});

describe("entity pages follow their ingested docs", () => {
  const k = (rel: string) => path.join(wsDir, "knowledge", rel);
  const write = (rel: string, text: string, bumpMs = 0) => {
    fs.mkdirSync(path.dirname(k(rel)), { recursive: true });
    fs.writeFileSync(k(rel), text);
    if (bumpMs)
      fs.utimesSync(k(rel), new Date(), new Date(Date.now() + bumpMs));
  };
  /** Simulate one ingest run: snapshot, apply writes, queue as ingest does. */
  const ingest = (writes: () => void) => {
    const before = wm.knowledgeSnapshot(wsId);
    const cp = wm.checkpointKnowledge(wsId, before);
    writes();
    return wm.queueReviewFromSnapshot(wsId, before, cp, {
      entityPagesFollowDocs: true,
    });
  };
  const pending = () =>
    wm
      .listReview(wsId)
      .map((i) => i.path)
      .sort();
  const clear = () => {
    for (const i of wm.listReview(wsId)) wm.resolveReview(i.path, "accept");
  };

  test("only the doc is reviewed; its pages are listed on it", () => {
    clear();
    write("entities/old-co.md", "# Old Co\n\n## Key facts\n- 2025 — founded\n");
    const visible = ingest(() => {
      write("clients/old-co-deal.md", "# Old Co deal\n");
      write(
        "entities/new-person.md",
        "# New Person\n\n- 2026 — met ([[old-co-deal]])\n",
      );
      write(
        "entities/old-co.md",
        "# Old Co\n\n## Key facts\n- 2025 — founded\n- 2026 — deal ([[old-co-deal]])\n",
        20_000,
      );
    });
    expect(visible.map((i) => i.path)).toEqual(["clients/old-co-deal.md"]);
    expect(pending()).toEqual(["clients/old-co-deal.md"]);
    expect(wm.listReview(wsId)[0].linked?.sort()).toEqual([
      "New Person",
      "Old Co",
    ]);
  });

  test("rejecting the doc undoes its pages: new trashed, updated restored", () => {
    wm.resolveReview("clients/old-co-deal.md", "reject");
    expect(fs.existsSync(k("clients/old-co-deal.md"))).toBe(false);
    expect(fs.existsSync(k("entities/new-person.md"))).toBe(false);
    expect(fs.readFileSync(k("entities/old-co.md"), "utf8")).toBe(
      "# Old Co\n\n## Key facts\n- 2025 — founded\n",
    );
    expect(pending()).toEqual([]);
  });

  test("accepting the doc keeps its pages", () => {
    ingest(() => {
      write("clients/old-co-renewal.md", "# Renewal\n");
      write(
        "entities/old-co.md",
        "# Old Co\n\n## Key facts\n- 2025 — founded\n- 2026 — renewal ([[old-co-renewal]])\n",
        40_000,
      );
    });
    wm.resolveReview("clients/old-co-renewal.md", "accept");
    expect(fs.readFileSync(k("entities/old-co.md"), "utf8")).toContain(
      "renewal",
    );
    expect(pending()).toEqual([]);
    expect(
      fs.existsSync(
        path.join(wsDir, ".monad/review-previous/entities/old-co.md"),
      ),
    ).toBe(false);
  });

  test("mixed decisions: page kept, only the rejected doc's new facts removed", () => {
    ingest(() => {
      write("notes/call-a.md", "# Call A\n");
      write("notes/call-b.md", "# Call B\n");
      write(
        "entities/old-co.md",
        "# Old Co\n\n## Key facts\n- 2025 — founded\n- 2026 — renewal ([[old-co-renewal]])\n- 2026-10 — said X ([[call-a]])\n- 2026-10 — said Y ([[notes/call-b|call B]])\n",
        60_000,
      );
    });
    expect(pending()).toEqual(["notes/call-a.md", "notes/call-b.md"]);
    wm.resolveReview("notes/call-a.md", "reject");
    // Still waiting on call B: the page isn't settled yet, but A's fact is gone.
    expect(fs.readFileSync(k("entities/old-co.md"), "utf8")).not.toContain(
      "said X",
    );
    wm.resolveReview("notes/call-b.md", "accept");
    const page = fs.readFileSync(k("entities/old-co.md"), "utf8");
    expect(page).toContain("said Y");
    expect(page).toContain("renewal"); // older fact untouched
    expect(pending()).toEqual([]);
  });

  test("a run that touched only entity pages keeps them reviewable", () => {
    const visible = ingest(() => {
      write("entities/solo.md", "# Solo\n");
    });
    expect(visible.map((i) => i.path)).toEqual(["entities/solo.md"]);
    wm.resolveReview("entities/solo.md", "accept");
  });

  test("runs without the option (backfill) review pages normally", () => {
    const before = wm.knowledgeSnapshot(wsId);
    const cp = wm.checkpointKnowledge(wsId, before);
    write("notes/linked.md", "# Linked\n");
    write("entities/backfilled.md", "# Backfilled\n");
    const visible = wm.queueReviewFromSnapshot(wsId, before, cp);
    expect(visible.map((i) => i.path).sort()).toEqual([
      "entities/backfilled.md",
      "notes/linked.md",
    ]);
    clear();
  });

  test("a doc deleted outside the review leaves its pages kept, not hidden", () => {
    ingest(() => {
      write("notes/gone.md", "# Gone\n");
      write("entities/orphan.md", "# Orphan\n\n- fact ([[gone]])\n");
    });
    fs.rmSync(k("notes/gone.md"));
    expect(pending()).toEqual([]);
    expect(fs.existsSync(k("entities/orphan.md"))).toBe(true);
  });
});

describe("stripRejectedFacts", () => {
  const before = "# Acme\n\n- 2025 — old fact ([[call-a]])\n";
  const after =
    "# Acme\n\nSee [[call-a]] for context.\n\n- 2025 — old fact ([[call-a]])\n- new from A ([[call-a#Pricing]])\n* new from A again ([[notes/call-a.md|the call]])\n- new from B ([[call-b]])\n";
  test("removes only new list facts citing the rejected doc", () => {
    expect(stripRejectedFacts(after, before, "notes/call-a.md")).toBe(
      "# Acme\n\nSee [[call-a]] for context.\n\n- 2025 — old fact ([[call-a]])\n- new from B ([[call-b]])\n",
    );
  });
  test("a slug that merely starts the same isn't a match", () => {
    expect(stripRejectedFacts("- x ([[call-ab]])", "", "notes/call-a.md")).toBe(
      "- x ([[call-ab]])",
    );
  });
});
