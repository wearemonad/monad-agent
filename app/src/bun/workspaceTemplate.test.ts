import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WORKSPACE_TEMPLATE,
  briefingPromptRules,
  claudeMdForTemplate,
} from "./workspaceTemplate";
import { BRAIN_TEMPLATES } from "../shared/brainTemplates";
import { CONNECTOR_CATALOG } from "../shared/connectorCatalog";

describe("brain template gallery", () => {
  test("every gallery id produces a CLAUDE.md with the shared safety sections", () => {
    for (const t of BRAIN_TEMPLATES) {
      const md = claudeMdForTemplate(t.id);
      expect(md).toContain("## Tools");
      expect(md).toContain("## Operating rules");
      expect(md).toContain("Drafts, never sends");
    }
  });

  test("vertical templates replace the intro; generic/unknown fall back", () => {
    expect(claudeMdForTemplate("agency")).toContain("[agency name]");
    expect(claudeMdForTemplate("ecommerce")).toContain("Products & suppliers");
    expect(claudeMdForTemplate("generic")).toBe(
      WORKSPACE_TEMPLATE["CLAUDE.md"],
    );
    expect(claudeMdForTemplate("nope")).toBe(WORKSPACE_TEMPLATE["CLAUDE.md"]);
    expect(claudeMdForTemplate(undefined)).toBe(
      WORKSPACE_TEMPLATE["CLAUDE.md"],
    );
  });

  test("gallery ids are unique", () => {
    const ids = BRAIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("connector catalog", () => {
  test("entries are well-formed for the mcpAdd flow", () => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const c of CONNECTOR_CATALOG) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(names.has(c.server.name)).toBe(false);
      names.add(c.server.name);
      expect(/^[a-zA-Z0-9_-]+$/.test(c.server.name)).toBe(true); // mcpAdd's name rule
      if (c.server.kind === "http") expect(c.server.url).toMatch(/^https:\/\//);
      else expect(c.server.command?.trim()).toBeTruthy();
      expect(c.docsUrl).toMatch(/^https:\/\//);
    }
  });

  test("no secrets inlined — env values must be ${VAR} references", () => {
    for (const c of CONNECTOR_CATALOG) {
      for (const line of (c.server.envLines ?? "")
        .split("\n")
        .filter(Boolean)) {
        expect(line).toMatch(/^[A-Z0-9_]+=\$\{[A-Z0-9_]+\}$/);
      }
    }
  });
});

describe("morning-briefing skill", () => {
  // The briefing is delivered as its Monad thread. A Gmail draft-to-self
  // showed up in the Outbox panel (which lists Gmail drafts) every morning.
  const skills = {
    template: WORKSPACE_TEMPLATE[".claude/skills/morning-briefing/SKILL.md"],
    "workspaces/main": readFileSync(
      join(
        import.meta.dir,
        "../../../workspaces/main/.claude/skills/morning-briefing/SKILL.md",
      ),
      "utf8",
    ),
  };
  for (const [where, skill] of Object.entries(skills)) {
    test(`${where}: no Gmail draft of the briefing; the file is still saved for carry-over`, () => {
      expect(skill).not.toContain("gmail_create_draft");
      expect(skill).toContain("outbox/briefings/<YYYY-MM-DD>-briefing.md");
    });
  }
});

describe("briefingPromptRules (system prompt of every run)", () => {
  // Existing workspaces keep their own skill copy — which still asks for the
  // Gmail draft-to-self — so this line is what actually stops it there.
  test("always forbids a Gmail draft of the briefing, and keeps the file", () => {
    for (const focus of [true, false]) {
      const rules = briefingPromptRules(focus).join("\n");
      expect(rules).toContain("Do NOT create a Gmail draft");
      expect(rules).toContain("still save the briefing file");
    }
  });

  test("the Suggested-focus line appears only when the toggle is off", () => {
    expect(briefingPromptRules(true).join("\n")).not.toContain(
      "Suggested focus",
    );
    expect(briefingPromptRules(false).join("\n")).toContain(
      "omit the 🎯 Suggested focus section",
    );
  });
});
