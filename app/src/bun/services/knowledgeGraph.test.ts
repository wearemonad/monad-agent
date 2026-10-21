import { describe, expect, test } from "bun:test";
import {
  type DocFacts,
  KnowledgeGraph,
  entityKey,
  parseDocFacts,
} from "./knowledgeGraph";

const ACME_PAGE = `---
type: Company
aliases: [Acme, "ACME Holdings"]
crm: twenty-123
related: ["[[Jane Doe]]"]
---
# Acme GmbH

Berlin agency, our biggest retainer client since 2025.

## Notes

Works with [[Bob Stone]].
`;

const CONTRACT = `---
source: acme-contract.pdf
ingested: 2026-08-01
tags: [client-acme, contract]
entities: [Acme GmbH, Jane Doe]
---
# Acme services contract

Net-30 payment terms. Signed by the client's CEO.

\`\`\`
[[Not A Link]]
\`\`\`
Inline \`[[also not]]\`.
`;

const MEETING = `---
ingested: 2026-09-10
---
# Kickoff call

Met [[Jane Doe]] and [[ACME]] — see [[acme-contract#Payment]].
`;

function graphOf(docs: Record<string, string>): KnowledgeGraph {
  return KnowledgeGraph.build(
    Object.entries(docs).map(([p, c]) => ({
      path: p,
      facts: parseDocFacts(p, c, "2026-01-01"),
    })),
  );
}

describe("entityKey", () => {
  test("folds case, whitespace and edge punctuation", () => {
    expect(entityKey("  Acme   GmbH ")).toBe("acme gmbh");
    expect(entityKey("“Acme GmbH”.")).toBe("acme gmbh");
  });
});

describe("parseDocFacts", () => {
  test("reads frontmatter entities, wikilinks and the ingest date", () => {
    const f = parseDocFacts("clients/acme-contract.md", CONTRACT, "2026-01-01");
    expect(f.title).toBe("Acme services contract");
    expect(f.date).toBe("2026-08-01");
    expect(f.refs).toEqual(["Acme GmbH", "Jane Doe"]);
    expect(f.links).toEqual([]);
    expect(f.entity).toBeUndefined();
  });

  test("ignores [[links]] inside code", () => {
    const f = parseDocFacts("clients/acme-contract.md", CONTRACT, "2026-01-01");
    expect(f.links).not.toContain("Not A Link");
    expect(f.links).not.toContain("also not");
  });

  test("strips #heading from link targets", () => {
    const f = parseDocFacts("notes/kickoff.md", MEETING, "2026-01-01");
    expect(f.links).toEqual(["Jane Doe", "ACME", "acme-contract"]);
  });

  test("entity pages carry name, type, aliases, crm id and summary", () => {
    const f = parseDocFacts("entities/acme-gmbh.md", ACME_PAGE, "2026-02-02");
    expect(f.entity).toEqual({
      name: "Acme GmbH",
      type: "company",
      aliases: ["Acme", "ACME Holdings"],
      crmId: "twenty-123",
      summary: "Berlin agency, our biggest retainer client since 2025.",
    });
    expect(f.refs).toEqual(["Jane Doe"]);
    expect(f.links).toEqual(["Bob Stone"]);
  });

  test("malformed frontmatter degrades to no lists, not an error", () => {
    const f = parseDocFacts(
      "notes/x.md",
      "---\nentities: [unclosed\n---\n# X\n\nSee [[Jane Doe]].",
      "2026-03-03",
    );
    expect(f.refs).toEqual([]);
    expect(f.links).toEqual(["Jane Doe"]);
    expect(f.date).toBe("2026-03-03");
  });

  test("type synonyms fold onto the canonical set", () => {
    const type = (t: string) =>
      parseDocFacts("entities/x.md", `---\ntype: ${t}\n---\n# X`, "2026-01-01")
        .entity?.type;
    expect(type("Client")).toBe("company");
    expect(type("organisation")).toBe("company");
    expect(type("Tools")).toBe("product");
    expect(type("person")).toBe("person");
    expect(type("spaceship")).toBe("other");
  });

  test("page name falls back to the filename", () => {
    const f = parseDocFacts(
      "entities/jane-doe.md",
      "Just notes.",
      "2026-01-01",
    );
    expect(f.entity?.name).toBe("Jane doe");
  });
});

describe("KnowledgeGraph", () => {
  const g = graphOf({
    "entities/acme-gmbh.md": ACME_PAGE,
    "clients/acme-contract.md": CONTRACT,
    "notes/kickoff.md": MEETING,
  });

  test("aliases resolve to the page's entity", () => {
    const acme = g.entity("acme");
    expect(acme?.name).toBe("Acme GmbH");
    expect(g.entity("ACME Holdings")?.name).toBe("Acme GmbH");
    expect(acme?.crmId).toBe("twenty-123");
    expect(acme?.page).toBe("entities/acme-gmbh.md");
  });

  test("an entity lists its docs newest first", () => {
    expect(g.entity("Acme GmbH")?.docs.map((d) => d.path)).toEqual([
      "notes/kickoff.md",
      "clients/acme-contract.md",
    ]);
    expect(g.entity("Acme GmbH")?.lastMentioned).toBe("2026-09-10");
  });

  test("referenced-but-unwritten names become page-less entities", () => {
    const jane = g.entity("jane doe");
    expect(jane?.page).toBeNull();
    expect(jane?.docs.length).toBe(2);
    expect(g.entity("Bob Stone")?.page).toBeNull();
  });

  test("related = direct page links first, then co-mentions", () => {
    const rel = g.entity("Acme GmbH")?.related ?? [];
    expect(rel.map((r) => [r.name, r.rel])).toEqual([
      ["Bob Stone", "related"],
      ["Jane Doe", "related"],
    ]);
    const janeRel = g.entity("Jane Doe")?.related ?? [];
    expect(janeRel.find((r) => r.name === "Acme GmbH")?.rel).toBe("related");
  });

  test("[[doc]] links resolve by Obsidian-style shortest path", () => {
    const view = g.view({ includeDocs: true });
    expect(view.links).toContainEqual({
      source: "d:notes/kickoff.md",
      target: "d:clients/acme-contract.md",
      rel: "links",
      weight: 1,
    });
  });

  test("[[file-slug]] links the doc; the same name in frontmatter is the entity", () => {
    // The real-world case: clients/preventr.md lists `entities: [Preventr]`,
    // and another doc links [[preventr]] meaning the file.
    const kg = graphOf({
      "clients/preventr.md":
        "---\nentities: [Preventr]\n---\n# Preventr\n\nClient.",
      "legal/agreement.md":
        "---\nentities: [Preventr]\n---\n# Agreement\n\nSee [[preventr]].",
    });
    const links = kg.view({ includeDocs: true }).links;
    expect(links).toContainEqual({
      source: "d:legal/agreement.md",
      target: "d:clients/preventr.md",
      rel: "links",
      weight: 1,
    });
    expect(kg.entity("Preventr")?.docs.map((d) => d.path)).toEqual([
      "clients/preventr.md",
      "legal/agreement.md",
    ]);
  });

  test("a basename tie between a doc and an entity page goes to the page", () => {
    const kg = graphOf({
      "clients/preventr.md": "# Preventr notes",
      "entities/preventr.md": "---\ntype: company\n---\n# Preventr",
      "notes/x.md": "# X\n\nSee [[preventr]].",
    });
    expect(kg.entity("Preventr")?.docs.map((d) => d.path)).toEqual([
      "notes/x.md",
    ]);
  });

  test("unlinked docs are left out of the drawn graph", () => {
    const kg = graphOf({
      "notes/daily/2026-09-15.md": "# Daily log\n\nNothing linked.",
      "notes/a.md": "---\nentities: [X Corp]\n---\n# A",
    });
    const ids = kg.view({ includeDocs: true }).nodes.map((n) => n.id);
    expect(ids.sort()).toEqual(["d:notes/a.md", "e:x corp"]);
  });

  test("entitiesInQuery spots names and aliases as whole phrases", () => {
    expect(g.entitiesInQuery("what did Acme agree to?")).toEqual([
      "e:acme gmbh",
    ]);
    expect(g.entitiesInQuery("acmes everywhere")).toEqual([]);
  });

  test("pathsAbout puts the entity's page first", () => {
    expect(g.pathsAbout(["e:acme gmbh"])).toEqual({
      pages: ["entities/acme-gmbh.md"],
      docs: ["notes/kickoff.md", "clients/acme-contract.md"],
    });
  });

  test("entitiesOfPath names what a doc is about", () => {
    expect(g.entitiesOfPath("clients/acme-contract.md").sort()).toEqual([
      "Acme GmbH",
      "Jane Doe",
    ]);
    expect(g.entitiesOfPath("entities/acme-gmbh.md")).toEqual(["Acme GmbH"]);
  });

  test("entity-only view links entities through shared docs", () => {
    const solo = graphOf({
      "notes/a.md": "---\nentities: [X Corp, Y Ltd]\n---\n# A",
      "notes/b.md": "---\nentities: [X Corp, Y Ltd]\n---\n# B",
    });
    const view = solo.view({ includeDocs: false });
    expect(view.nodes.every((n) => n.kind === "entity")).toBe(true);
    expect(view.links).toEqual([
      { source: "e:x corp", target: "e:y ltd", rel: "co-mentioned", weight: 2 },
    ]);
    expect(view.stats).toEqual({ entities: 2, docs: 0, links: 1 });
  });

  test("entities() filters by type and staleness", () => {
    expect(g.entities({ type: "company" }).map((e) => e.name)).toEqual([
      "Acme GmbH",
    ]);
    const stale = g.entities({
      notMentionedSinceDays: 30,
      nowMs: Date.parse("2026-09-20"), // cutoff 2026-08-21
    });
    expect(stale.map((e) => e.name)).toEqual(["Bob Stone"]);
  });

  test("a duplicate page for the same name stays an ordinary doc", () => {
    const dup = graphOf({
      "entities/acme-gmbh.md": ACME_PAGE,
      "entities/acme-old.md": "---\nname: Acme GmbH\n---\nOld notes.",
    });
    expect(dup.entity("Acme GmbH")?.page).toBe("entities/acme-gmbh.md");
    expect(dup.entity("Acme GmbH")?.docs.map((d) => d.path)).toEqual([
      "entities/acme-old.md",
    ]);
  });

  test("facts survive a JSON round-trip (they are cached as JSON)", () => {
    const f = parseDocFacts("entities/acme-gmbh.md", ACME_PAGE, "2026-01-01");
    expect(JSON.parse(JSON.stringify(f)) as DocFacts).toEqual(f);
  });
});
