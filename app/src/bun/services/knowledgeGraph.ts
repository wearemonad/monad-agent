import wikiLinkPlugin from "@flowershow/remark-wiki-link";
import { UndirectedGraph } from "graphology";
import type { Root } from "mdast";
import { toString as mdToString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import {
  ENTITY_PAGES_DIR,
  ENTITY_TYPES,
  type EntityType,
  entityKey,
  type GraphLinkRel,
  type GraphLinkView,
  type GraphNodeKind,
  type GraphNodeView,
  type KnowledgeGraphView,
} from "../../shared/knowledgeGraph";

export { entityKey };

/** Knowledge graph over a workspace's knowledge/ docs: entities (people,
 *  companies, projects…) and the docs that mention them, derived entirely from
 *  the markdown — `entities:`/`related:` frontmatter, Obsidian-style
 *  [[wikilinks]], and one page per entity under knowledge/entities/. Like the
 *  rest of the memory index it is a disposable cache: the files stay the
 *  source of truth, so the graph can always be rebuilt from them. */

/** Everything the graph needs from one doc, extracted once per file change
 *  and cached in memory.db (graph_docs) so a rebuild never re-parses. */
export type DocFacts = {
  title: string;
  /** YYYY-MM-DD — frontmatter `ingested:` when present, else the file date. */
  date: string;
  /** Present when the doc is an entity page (knowledge/entities/*.md). */
  entity?: {
    name: string;
    type: string;
    aliases: string[];
    crmId?: string;
    summary: string;
  };
  /** Entity names from `entities:`/`related:` frontmatter — always entities. */
  refs: string[];
  /** [[wikilink]] targets — Obsidian rules: a matching file wins, else an
   *  entity by name/alias. */
  links: string[];
};

// Markdown is parsed with remark (the same parser react-markdown uses) so
// [[links]] inside code blocks and inline code are never mistaken for links.
const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(wikiLinkPlugin);

/** Frontmatter list values arrive as YAML arrays, comma strings, or
 *  Obsidian-style "[[Name]]" strings — flatten all three into clean names. */
function nameList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw
    .filter((v) => typeof v === "string" || typeof v === "number")
    .map((v) =>
      String(v)
        .trim()
        .replace(/^\[\[(.*)\]\]$/, "$1")
        .replace(/[#|].*$/, "")
        .trim(),
    )
    .filter(Boolean);
}

/** Synonyms the agent (or a human) may write in `type:`, folded onto the
 *  canonical set so colors, filters and memory_entities agree. */
const TYPE_SYNONYMS: Record<string, EntityType> = {
  people: "person",
  contact: "person",
  individual: "person",
  organisation: "company",
  organization: "company",
  org: "company",
  business: "company",
  client: "company",
  customer: "company",
  prospect: "company",
  supplier: "company",
  vendor: "company",
  partner: "company",
  agency: "company",
  firm: "company",
  tool: "product",
  software: "product",
  app: "product",
  service: "product",
  platform: "product",
  saas: "product",
  initiative: "project",
  engagement: "project",
};

export function normalizeType(raw: unknown): EntityType | "" {
  if (typeof raw !== "string") return "";
  const t = raw.trim().toLowerCase();
  if (!t) return "";
  if ((ENTITY_TYPES as readonly string[]).includes(t)) return t as EntityType;
  return TYPE_SYNONYMS[t] ?? TYPE_SYNONYMS[t.replace(/s$/, "")] ?? "other";
}

function humanize(fileName: string): string {
  const base = fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function isEntityPage(relPath: string): boolean {
  return relPath.startsWith(`${ENTITY_PAGES_DIR}/`);
}

export function parseDocFacts(
  relPath: string,
  content: string,
  fileDate: string,
): DocFacts {
  const tree = parser.parse(content) as Root;
  let fm: Record<string, unknown> = {};
  let title = "";
  let summary = "";
  const links: string[] = [];
  visit(tree, (node, _index, parent) => {
    if (node.type === "yaml") {
      try {
        const parsed = Bun.YAML.parse(node.value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          fm = parsed as Record<string, unknown>;
      } catch {
        // Malformed frontmatter: the doc still indexes, just without its lists.
      }
    } else if (node.type === "heading" && node.depth === 1 && !title) {
      title = mdToString(node).trim();
    } else if (
      node.type === "paragraph" &&
      !summary &&
      parent?.type === "root"
    ) {
      summary = mdToString(node).replace(/\s+/g, " ").trim().slice(0, 280);
    } else if ((node as { type: string }).type === "wikiLink") {
      const target = String((node as { value?: unknown }).value ?? "")
        .replace(/#.*$/, "")
        .trim();
      if (target) links.push(target);
    }
  });

  const ingested = fm.ingested;
  const date =
    typeof ingested === "string" && /^\d{4}-\d{2}-\d{2}/.test(ingested)
      ? ingested.slice(0, 10)
      : ingested instanceof Date && !Number.isNaN(ingested.getTime())
        ? ingested.toISOString().slice(0, 10)
        : fileDate;
  const baseName = relPath.split("/").pop() ?? relPath;

  const facts: DocFacts = {
    title: title || humanize(baseName),
    date,
    refs: [...new Set([...nameList(fm.entities), ...nameList(fm.related)])],
    links: [...new Set(links)],
  };
  if (isEntityPage(relPath)) {
    const name =
      (typeof fm.name === "string" && fm.name.trim()) ||
      title ||
      humanize(baseName);
    const crm = fm.crm ?? fm.crm_id;
    facts.entity = {
      name,
      type: normalizeType(fm.type),
      aliases: nameList(fm.aliases),
      crmId:
        typeof crm === "string" || typeof crm === "number"
          ? String(crm).trim() || undefined
          : undefined,
      summary,
    };
    facts.title = name;
  }
  return facts;
}

type NodeAttrs = {
  kind: GraphNodeKind;
  label: string;
  group: string;
  path: string | null;
  date: string;
  crmId?: string;
  aliases?: string[];
  summary?: string;
};
type EdgeAttrs = { rel: Exclude<GraphLinkRel, "co-mentioned"> };

export type EntityDoc = { path: string; title: string; date: string };
export type EntityRelation = {
  name: string;
  type: string;
  rel: "related" | "co-mentioned";
  /** co-mentioned: number of docs naming both. */
  count: number;
};
export type EntityProfile = {
  name: string;
  type: string;
  aliases: string[];
  crmId?: string;
  page: string | null;
  summary: string;
  lastMentioned: string;
  docs: EntityDoc[];
  related: EntityRelation[];
};
export type EntitySummary = {
  name: string;
  type: string;
  mentions: number;
  lastMentioned: string;
  crmId?: string;
  page: string | null;
};

/** Docs listing more entities than this contribute only their first N to
 *  co-mention pairs — a roster doc naming 200 people would otherwise add
 *  ~20k edges that say nothing. */
const MAX_COMENTION_ENTITIES = 30;
/** Aliases shorter than this are too ambiguous to spot inside free text. */
const MIN_QUERY_ALIAS_CHARS = 3;

const entityId = (key: string) => `e:${key}`;
const docId = (p: string) => `d:${p}`;
const pathKey = (p: string) => p.toLowerCase().replace(/\.md$/i, "");

export class KnowledgeGraph {
  private g = new UndirectedGraph<NodeAttrs, EdgeAttrs>();
  /** Entity name/alias key → entity node id. */
  private aliases = new Map<string, string>();
  /** Doc path key (full, and bare basename) → node id, for [[doc]] links. */
  private paths = new Map<string, string>();
  /** knowledge/-relative path → node id (doc node, or the page's entity). */
  private byPath = new Map<string, string>();

  static build(docs: { path: string; facts: DocFacts }[]): KnowledgeGraph {
    const kg = new KnowledgeGraph();
    kg.load([...docs].sort((a, b) => a.path.localeCompare(b.path)));
    return kg;
  }

  private load(docs: { path: string; facts: DocFacts }[]): void {
    const g = this.g;
    // 1. Entity pages first, so every alias is known before any ref resolves.
    //    Two pages claiming one name: the first (by path) owns it; the other
    //    stays an ordinary doc that mentions the entity.
    for (const { path: p, facts } of docs) {
      const e = facts.entity;
      if (!e) continue;
      const key = entityKey(e.name);
      if (!key || this.aliases.has(key)) continue;
      const id = entityId(key);
      g.addNode(id, {
        kind: "entity",
        label: e.name,
        group: e.type,
        path: p,
        date: facts.date,
        crmId: e.crmId,
        aliases: e.aliases,
        summary: e.summary,
      });
      this.aliases.set(key, id);
      for (const a of e.aliases) {
        const ak = entityKey(a);
        if (ak && !this.aliases.has(ak)) this.aliases.set(ak, id);
      }
      this.byPath.set(p, id);
    }
    // 2. Every other doc is a doc node.
    for (const { path: p, facts } of docs) {
      if (this.byPath.has(p)) continue;
      const id = docId(p);
      g.addNode(id, {
        kind: "doc",
        label: facts.title,
        group: p.includes("/") ? p.split("/")[0] : "",
        path: p,
        date: facts.date,
      });
      this.byPath.set(p, id);
    }
    // Path lookups for [[clients/acme-contract]] and Obsidian's shortest form
    // [[acme-contract]]. A basename tie goes to the entity page (the hub),
    // then to the shorter path, as in Obsidian.
    const byLength = [...this.byPath.keys()].sort(
      (a, b) =>
        Number(!isEntityPage(a)) - Number(!isEntityPage(b)) ||
        a.length - b.length ||
        a.localeCompare(b),
    );
    for (const p of byLength) {
      const id = this.byPath.get(p) as string;
      const full = pathKey(p);
      if (!this.paths.has(full)) this.paths.set(full, id);
      const base = full.split("/").pop() as string;
      if (!this.paths.has(base)) this.paths.set(base, id);
    }
    // 3. Edges. Unknown names become page-less entities — referenced but not
    //    yet written up, like Obsidian's unresolved links.
    for (const { path: p, facts } of docs) {
      const src = this.byPath.get(p) as string;
      // A page demoted to a doc (its name was taken) still points at it.
      const demoted =
        facts.entity && g.getNodeAttribute(src, "kind") === "doc"
          ? [facts.entity.name]
          : [];
      const targets = [
        ...[...demoted, ...facts.refs].map((name) =>
          this.resolveName(name, facts.date),
        ),
        ...(facts.links ?? []).map((link) =>
          this.resolveLink(link, facts.date),
        ),
      ];
      for (const dst of targets) {
        if (!dst || dst === src) continue;
        const srcKind = g.getNodeAttribute(src, "kind");
        const dstKind = g.getNodeAttribute(dst, "kind");
        const rel: EdgeAttrs["rel"] =
          srcKind === "entity" && dstKind === "entity"
            ? "related"
            : srcKind === "doc" && dstKind === "doc"
              ? "links"
              : "mentions";
        if (!g.hasEdge(src, dst)) g.addEdge(src, dst, { rel });
      }
    }
    // 4. An entity's date is its most recent mention (or its page's date).
    g.forEachNode((id, attrs) => {
      if (attrs.kind !== "entity") return;
      let latest = attrs.date;
      g.forEachNeighbor(id, (_n, nAttrs) => {
        if (nAttrs.kind === "doc" && nAttrs.date > latest) latest = nAttrs.date;
      });
      g.setNodeAttribute(id, "date", latest);
    });
  }

  /** A frontmatter name: always an entity — known by name/alias, else a new
   *  page-less one. Never a doc, even if a file happens to share the name. */
  private resolveName(name: string, date: string): string | null {
    const key = entityKey(name);
    if (!key) return null;
    return this.aliases.get(key) ?? this.implicitEntity(key, name, date);
  }

  /** A [[wikilink]]: a matching file first (as Obsidian resolves it), then an
   *  entity by name/alias, else a new page-less entity. */
  private resolveLink(target: string, date: string): string | null {
    const key = entityKey(target);
    if (!key) return null;
    return (
      this.paths.get(pathKey(target)) ??
      this.aliases.get(key) ??
      this.implicitEntity(key, target, date)
    );
  }

  private implicitEntity(key: string, ref: string, date: string): string {
    const id = entityId(key);
    if (!this.g.hasNode(id))
      this.g.addNode(id, {
        kind: "entity",
        label: ref.trim(),
        group: "",
        path: null,
        date,
      });
    this.aliases.set(key, id);
    return id;
  }

  get entityCount(): number {
    let n = 0;
    this.g.forEachNode((_id, a) => {
      if (a.kind === "entity") n++;
    });
    return n;
  }

  /** Node id of the entity a name or alias refers to, or null. */
  findEntity(name: string): string | null {
    const id = this.aliases.get(entityKey(name));
    return id && this.g.getNodeAttribute(id, "kind") === "entity" ? id : null;
  }

  /** Entities whose name contains the query or vice versa — "did you mean". */
  suggest(name: string, limit = 8): string[] {
    const q = entityKey(name);
    if (!q) return [];
    const out: string[] = [];
    this.g.forEachNode((id, a) => {
      if (a.kind !== "entity" || out.length >= limit) return;
      const k = id.slice(2);
      if (k.includes(q) || (k.length >= MIN_QUERY_ALIAS_CHARS && q.includes(k)))
        out.push(a.label);
    });
    return out;
  }

  private docsOf(id: string): EntityDoc[] {
    const docs: EntityDoc[] = [];
    this.g.forEachNeighbor(id, (_n, a) => {
      if (a.kind === "doc" && a.path)
        docs.push({ path: a.path, title: a.label, date: a.date });
    });
    return docs.sort(
      (a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path),
    );
  }

  entity(name: string): EntityProfile | null {
    const id = this.findEntity(name);
    if (!id) return null;
    const a = this.g.getNodeAttributes(id);
    const related = new Map<string, EntityRelation>();
    this.g.forEachNeighbor(id, (nid, n) => {
      if (n.kind === "entity")
        related.set(nid, {
          name: n.label,
          type: n.group,
          rel: "related",
          count: 1,
        });
    });
    for (const [nid, count] of this.coMentions(id)) {
      if (related.has(nid)) continue;
      const n = this.g.getNodeAttributes(nid);
      related.set(nid, {
        name: n.label,
        type: n.group,
        rel: "co-mentioned",
        count,
      });
    }
    return {
      name: a.label,
      type: a.group,
      aliases: a.aliases ?? [],
      crmId: a.crmId,
      page: a.path,
      summary: a.summary ?? "",
      lastMentioned: a.date,
      docs: this.docsOf(id),
      related: [...related.values()].sort(
        (x, y) =>
          Number(y.rel === "related") - Number(x.rel === "related") ||
          y.count - x.count ||
          x.name.localeCompare(y.name),
      ),
    };
  }

  /** Other entities sharing a doc with this one → number of shared docs. */
  private coMentions(id: string): Map<string, number> {
    const counts = new Map<string, number>();
    this.g.forEachNeighbor(id, (docNode, d) => {
      if (d.kind !== "doc") return;
      this.g.forEachNeighbor(docNode, (other, o) => {
        if (other !== id && o.kind === "entity")
          counts.set(other, (counts.get(other) ?? 0) + 1);
      });
    });
    return counts;
  }

  entities(
    opts: {
      type?: string;
      /** Only entities not mentioned in this many days (stale relationships). */
      notMentionedSinceDays?: number;
      sort?: "mentions" | "recent" | "stale";
      limit?: number;
      nowMs?: number;
    } = {},
  ): EntitySummary[] {
    const type = opts.type?.trim().toLowerCase();
    const cutoff =
      opts.notMentionedSinceDays !== undefined
        ? new Date(
            (opts.nowMs ?? Date.now()) -
              opts.notMentionedSinceDays * 86_400_000,
          )
            .toISOString()
            .slice(0, 10)
        : null;
    const out: EntitySummary[] = [];
    this.g.forEachNode((id, a) => {
      if (a.kind !== "entity") return;
      if (type && a.group !== type) return;
      if (cutoff && a.date && a.date >= cutoff) return;
      let mentions = 0;
      this.g.forEachNeighbor(id, (_n, n) => {
        if (n.kind === "doc") mentions++;
      });
      out.push({
        name: a.label,
        type: a.group,
        mentions,
        lastMentioned: a.date,
        crmId: a.crmId,
        page: a.path,
      });
    });
    const sort = opts.sort ?? "mentions";
    out.sort((x, y) =>
      sort === "recent"
        ? y.lastMentioned.localeCompare(x.lastMentioned)
        : sort === "stale"
          ? x.lastMentioned.localeCompare(y.lastMentioned)
          : y.mentions - x.mentions || x.name.localeCompare(y.name),
    );
    return out.slice(0, Math.max(1, opts.limit ?? 50));
  }

  /** Entity ids whose name or an alias appears as a whole phrase in the
   *  query — "what did Acme agree to" → Acme GmbH via its alias "Acme". */
  entitiesInQuery(query: string): string[] {
    const flat = (s: string) =>
      s
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const q = ` ${flat(query)} `;
    const found = new Set<string>();
    for (const [alias, id] of this.aliases) {
      const a = flat(alias);
      if (a.length >= MIN_QUERY_ALIAS_CHARS && q.includes(` ${a} `))
        found.add(id);
    }
    return [...found].filter(
      (id) => this.g.getNodeAttribute(id, "kind") === "entity",
    );
  }

  /** Knowledge paths about these entities: each entity's own page first,
   *  then the docs mentioning it, newest first. */
  pathsAbout(ids: string[]): { pages: string[]; docs: string[] } {
    const pages: string[] = [];
    const docs: string[] = [];
    for (const id of ids) {
      const page = this.g.getNodeAttribute(id, "path");
      if (page) pages.push(page);
    }
    for (const id of ids)
      for (const d of this.docsOf(id))
        if (!docs.includes(d.path)) docs.push(d.path);
    return { pages, docs };
  }

  /** Names of the entities a knowledge doc is about (or the page's own). */
  entitiesOfPath(p: string): string[] {
    const id = this.byPath.get(p);
    if (!id) return [];
    const a = this.g.getNodeAttributes(id);
    if (a.kind === "entity") return [a.label];
    const names: string[] = [];
    this.g.forEachNeighbor(id, (_n, n) => {
      if (n.kind === "entity") names.push(n.label);
    });
    return names;
  }

  /** Drawable snapshot for the viewer. Without docs, entities connect
   *  directly: explicit `related` links plus co-mention edges weighted by how
   *  many docs name both. */
  view(opts: { includeDocs: boolean }): KnowledgeGraphView {
    const g = this.g;
    const links: GraphLinkView[] = [];
    // Docs only earn a node by connecting something: an unlinked doc (a daily
    // log, an untagged note) is a floating square that says nothing.
    const keep = (id: string) =>
      g.getNodeAttribute(id, "kind") === "entity" ||
      (opts.includeDocs && g.degree(id) > 0);
    g.forEachEdge((_e, attrs, s, t) => {
      if (keep(s) && keep(t))
        links.push({ source: s, target: t, rel: attrs.rel, weight: 1 });
    });
    if (!opts.includeDocs) {
      const pairs = new Map<string, number>();
      g.forEachNode((id, a) => {
        if (a.kind !== "doc") return;
        const ents = g
          .neighbors(id)
          .filter((n) => g.getNodeAttribute(n, "kind") === "entity")
          .slice(0, MAX_COMENTION_ENTITIES)
          .sort();
        for (let i = 0; i < ents.length; i++)
          for (let j = i + 1; j < ents.length; j++) {
            if (g.hasEdge(ents[i], ents[j])) continue; // explicit link wins
            const k = `${ents[i]}\u0000${ents[j]}`;
            pairs.set(k, (pairs.get(k) ?? 0) + 1);
          }
      });
      for (const [k, weight] of pairs) {
        const [source, target] = k.split("\u0000");
        links.push({ source, target, rel: "co-mentioned", weight });
      }
    }
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    const nodes: GraphNodeView[] = [];
    let entities = 0;
    let docs = 0;
    g.forEachNode((id, a) => {
      if (!keep(id)) return;
      if (a.kind === "entity") entities++;
      else docs++;
      nodes.push({
        id,
        kind: a.kind,
        label: a.label,
        group: a.group,
        degree: degree.get(id) ?? 0,
        path: a.path,
        crmId: a.crmId,
        aliases: a.aliases?.length ? a.aliases : undefined,
        summary: a.summary || undefined,
        date: a.date || undefined,
      });
    });
    return { nodes, links, stats: { entities, docs, links: links.length } };
  }
}
