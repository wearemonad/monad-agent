import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryIndexService } from "./MemoryIndexService";
import { buildMemoryTools } from "./memoryTools";

// The graph as wired into the memory index: per-workspace storage, backfill,
// graph-boosted search and the agent tools. Keyword-only (no embedder) so the
// graph's own contribution is what's under test.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-graph-test-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function makeWorkspace(name: string, docs: Record<string, string>): string {
  const ws = path.join(root, name);
  for (const [rel, content] of Object.entries(docs)) {
    const full = path.join(ws, "knowledge", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return ws;
}

const ACME_DOCS = {
  "entities/acme-gmbh.md":
    "---\ntype: company\naliases: [Acme]\ncrm: twenty-42\n---\n# Acme GmbH\n\nBerlin agency and retainer client.\n",
  // Frontmatter is the ONLY place this doc names Acme — keyword search over
  // the body can't find it; the graph can.
  "finance/q3-retainer.md":
    "---\ningested: 2026-09-01\nentities: [Acme GmbH]\n---\n# Q3 retainer\n\nThe client pays 4,000 EUR monthly, invoiced on the first.\n",
  "brand/colors.md":
    "---\ningested: 2026-05-01\n---\n# Colors\n\nPrimary indigo, secondary slate for all decks.\n",
};

describe("graph in the memory index", () => {
  const ws = makeWorkspace("acme", ACME_DOCS);
  const index = new MemoryIndexService();
  afterAll(() => index.close());

  test("sync builds the graph from knowledge/", () => {
    index.syncKnowledge(ws);
    const acme = index.graph(ws).entity("Acme");
    expect(acme?.crmId).toBe("twenty-42");
    expect(acme?.docs.map((d) => d.path)).toEqual(["finance/q3-retainer.md"]);
  });

  test("searching an entity name surfaces frontmatter-only docs", async () => {
    const hits = await index.search(ws, "Acme");
    const paths = hits.map((h) => h.sourcePath);
    expect(paths).toContain("entities/acme-gmbh.md");
    expect(paths).toContain("finance/q3-retainer.md");
    expect(paths).not.toContain("brand/colors.md");
    const retainer = hits.find(
      (h) => h.sourcePath === "finance/q3-retainer.md",
    );
    expect(retainer?.entities).toEqual(["Acme GmbH"]);
    // About the entity, not provably about the question → a lead, not evidence.
    expect(retainer?.confidence).toBe("weak");
    const page = hits.find((h) => h.sourcePath === "entities/acme-gmbh.md");
    expect(page?.confidence).toBe("strong");
  });

  test("session-scoped search ignores the graph", async () => {
    expect(await index.search(ws, "Acme", { scope: "session" })).toEqual([]);
  });

  test("edits and deletions update the graph on the next sync", () => {
    const doc = path.join(ws, "knowledge/finance/q3-retainer.md");
    fs.rmSync(doc);
    index.syncKnowledge(ws);
    expect(index.graph(ws).entity("Acme")?.docs).toEqual([]);
    fs.writeFileSync(doc, ACME_DOCS["finance/q3-retainer.md"]);
    index.syncKnowledge(ws);
    expect(index.graph(ws).entity("Acme")?.docs.length).toBe(1);
  });
});

describe("backfill for docs indexed before the graph existed", () => {
  test("already-chunked docs get graph facts without re-chunking", () => {
    const ws = makeWorkspace("legacy", ACME_DOCS);
    const first = new MemoryIndexService();
    first.syncKnowledge(ws);
    first.close();
    // Simulate a pre-graph memory.db: chunks + stamps present, no facts.
    const db = new Database(path.join(ws, ".monad/memory.db"));
    const chunkIds = db.query("SELECT id FROM chunks ORDER BY id").all();
    db.exec("DELETE FROM graph_docs");
    db.close();

    const second = new MemoryIndexService();
    try {
      second.syncKnowledge(ws);
      expect(second.graph(ws).entity("Acme")?.docs.length).toBe(1);
      const after = new Database(path.join(ws, ".monad/memory.db"));
      // Same chunk rows → no re-embedding cost.
      expect(after.query("SELECT id FROM chunks ORDER BY id").all()).toEqual(
        chunkIds,
      );
      after.close();
    } finally {
      second.close();
    }
  });
});

describe("workspace isolation", () => {
  test("each workspace sees only its own entities", async () => {
    const a = makeWorkspace("iso-a", ACME_DOCS);
    const b = makeWorkspace("iso-b", {
      "entities/globex.md":
        "---\ntype: company\n---\n# Globex\n\nA prospect.\n",
    });
    const index = new MemoryIndexService();
    try {
      index.syncKnowledge(a);
      index.syncKnowledge(b);
      expect(index.graph(a).entity("Globex")).toBeNull();
      expect(index.graph(b).entity("Acme")).toBeNull();
      expect(
        index
          .graph(b)
          .view({ includeDocs: true })
          .nodes.map((n) => n.id),
      ).toEqual(["e:globex"]);
      expect(await index.search(b, "Acme")).toEqual([]);
      expect(fs.existsSync(path.join(b, ".monad/memory.db"))).toBe(true);
    } finally {
      index.close();
    }
  });
});

describe("graph tools", () => {
  const ws = makeWorkspace("tools", {
    ...ACME_DOCS,
    "notes/kickoff.md":
      "---\ningested: 2026-09-10\nentities: [Acme GmbH, Jane Doe]\n---\n# Kickoff\n\nAgreed scope with [[Jane Doe]].\n",
  });
  const index = new MemoryIndexService();
  const tools = buildMemoryTools(ws, {
    index,
    sync: async () => index.syncKnowledge(ws),
  });
  const entity = tools.find((t) => t.name === "memory_entity") as any;
  const entities = tools.find((t) => t.name === "memory_entities") as any;
  afterAll(() => index.close());

  test("memory_entity returns a cited profile", async () => {
    const res = await entity.handler({ name: "acme" }, {});
    const out = res.content[0].text as string;
    expect(out).toContain("Entity: Acme GmbH (company)");
    expect(out).toContain("page knowledge/entities/acme-gmbh.md");
    expect(out).toContain("CRM id: twenty-42");
    expect(out).toContain("knowledge/notes/kickoff.md · 2026-09-10");
    expect(out).toContain("Jane Doe — co-mentioned in 1 doc(s)");
  });

  test("memory_entity suggests near names when unknown", async () => {
    const res = await entity.handler({ name: "Jane" }, {});
    const out = res.content[0].text as string;
    expect(out).toContain('No entity named "Jane"');
    expect(out).toContain("Did you mean: Jane Doe");
  });

  test("memory_entities filters by type", async () => {
    const res = await entities.handler({ type: "company" }, {});
    const out = res.content[0].text as string;
    expect(out).toContain("Acme GmbH (company) · 2 doc(s)");
    expect(out).not.toContain("Jane Doe");
  });
});
