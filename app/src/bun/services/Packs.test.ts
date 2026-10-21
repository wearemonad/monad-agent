import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Packs } from "./Packs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-packs-test-"));
const wsDir = path.join(root, "ws");
const packDir = path.join(root, "pack-source");
const outDir = path.join(root, "out");
const packs = new Packs();

const writeSkill = (base: string, name: string) => {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\n# ${name}\n`,
  );
};

beforeAll(() => {
  fs.mkdirSync(outDir, { recursive: true });
  // a workspace with one existing skill
  writeSkill(path.join(wsDir, ".claude", "skills"), "existing-skill");
  fs.writeFileSync(path.join(wsDir, ".env"), "SECRET=yes");
  fs.writeFileSync(path.join(wsDir, ".env.local"), "LOCAL_SECRET=yes");
  fs.writeFileSync(path.join(wsDir, ".env.production"), "PROD_SECRET=yes");
  fs.writeFileSync(path.join(wsDir, ".env.example"), "SECRET=");
  fs.mkdirSync(path.join(wsDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "sub", ".env"), "NESTED_SECRET=yes");
  fs.writeFileSync(
    path.join(wsDir, ".claude", "settings.local.json"),
    '{"secret":"local"}',
  );
  fs.mkdirSync(path.join(wsDir, ".monad"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, ".monad", "review.json"), "[]");
  fs.mkdirSync(path.join(wsDir, "knowledge", "originals"), { recursive: true });
  fs.writeFileSync(
    path.join(wsDir, "knowledge", "originals", "raw.pdf"),
    "pdf",
  );
  fs.writeFileSync(path.join(wsDir, "knowledge", "kept.md"), "keep me");
  // a pack folder with two skills, one colliding
  writeSkill(packDir, "existing-skill");
  writeSkill(packDir, "new-skill");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("skill packs", () => {
  test("import from a folder adds new skills, skips existing names", () => {
    const res = packs.importSkills(wsDir, packDir);
    expect(res.added).toEqual(["new-skill"]);
    expect(res.skipped).toEqual(["existing-skill"]);
    expect(
      fs.existsSync(
        path.join(wsDir, ".claude", "skills", "new-skill", "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("export → import roundtrip through a zip", () => {
    const zip = packs.exportSkills(wsDir, "Test Co", outDir);
    expect(zip.endsWith("test-co-skills.zip")).toBe(true);
    expect(fs.existsSync(zip)).toBe(true);

    const otherWs = path.join(root, "other-ws");
    fs.mkdirSync(otherWs, { recursive: true });
    const res = packs.importSkills(otherWs, zip);
    expect(res.added.sort()).toEqual(["existing-skill", "new-skill"]);
  });

  test("import with nothing skill-shaped fails clearly", () => {
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty, { recursive: true });
    expect(() => packs.importSkills(wsDir, empty)).toThrow(/No skills found/);
  });

  // data#A: a SKILL.md at the root of an extracted zip would otherwise inherit
  // the random temp-dir name; the frontmatter name wins.
  test("imported skill uses its frontmatter name, not the containing dir name", () => {
    const oddDir = path.join(root, "tmp-xyz-123");
    fs.mkdirSync(oddDir, { recursive: true });
    fs.writeFileSync(
      path.join(oddDir, "SKILL.md"),
      "---\nname: proper-name\ndescription: d\n---\n# x\n",
    );
    const freshWs = path.join(root, "ws-frontmatter");
    fs.mkdirSync(freshWs, { recursive: true });
    const res = packs.importSkills(freshWs, oddDir);
    expect(res.added).toEqual(["proper-name"]);
    expect(
      fs.existsSync(
        path.join(freshWs, ".claude", "skills", "proper-name", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(freshWs, ".claude", "skills", "tmp-xyz-123")),
    ).toBe(false);
  });
});

describe("workspace export / import", () => {
  test("export excludes secrets, state, and originals; import restores the rest", () => {
    const zip = packs.exportWorkspace(wsDir, "Test Co", outDir);
    const target = packs.importWorkspace(zip, root, "Restored Co");

    expect(fs.existsSync(path.join(target, "knowledge", "kept.md"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(target, ".claude", "skills", "existing-skill", "SKILL.md"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(target, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".monad", "review.json"))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(target, "knowledge", "originals", "raw.pdf")),
    ).toBe(false);
  });

  // H4: every secret shape must stay out of the shareable brain zip.
  test("export excludes all .env variants, nested .env, and local settings", () => {
    const zip = packs.exportWorkspace(wsDir, "Secrets Co", outDir);
    const target = packs.importWorkspace(zip, root, "Secrets Restored");
    expect(fs.existsSync(path.join(target, ".env.local"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".env.production"))).toBe(false);
    expect(fs.existsSync(path.join(target, "sub", ".env"))).toBe(false);
    expect(
      fs.existsSync(path.join(target, ".claude", "settings.local.json")),
    ).toBe(false);
    // the safe template IS included
    expect(fs.existsSync(path.join(target, ".env.example"))).toBe(true);
  });

  test("import refuses a non-empty target", () => {
    const zip = packs.exportWorkspace(wsDir, "Test Co", outDir);
    expect(() => packs.importWorkspace(zip, root, "Restored Co")).toThrow(
      /not empty/,
    );
  });
});
