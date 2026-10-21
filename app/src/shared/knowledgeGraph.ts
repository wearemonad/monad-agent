// Shared knowledge-graph contract (bun process + webview).

/** Canonical lookup key for an entity name or alias: Unicode-normalized,
 *  case-folded, whitespace-collapsed, edge punctuation stripped — "Acme GmbH",
 *  "acme  gmbh" and "“Acme GmbH”." are the same entity. */
export function entityKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,;:]+$/g, "");
}

/** Folder (knowledge/-relative) holding one markdown page per entity. */
export const ENTITY_PAGES_DIR = "entities";

export type GraphNodeKind = "entity" | "doc";

/** One node of a workspace's knowledge graph, as drawn by the viewer. Ids are
 *  namespaced — `e:<entity key>` / `d:<knowledge-relative path>` — so an
 *  entity and a doc that share a name can never collide. */
export type GraphNodeView = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Entity type from its page's frontmatter (person, company, …); "" when
   *  untyped. Docs carry their top-level knowledge folder (clients, notes…). */
  group: string;
  /** Number of connections — drives node size. */
  degree: number;
  /** knowledge/-relative path of the entity's page or the doc itself; null
   *  for an entity that is only referenced, never given a page. */
  path: string | null;
  crmId?: string;
  aliases?: string[];
  summary?: string;
  /** YYYY-MM-DD: doc ingest date, or an entity's most recent mention. */
  date?: string;
};

export type GraphLinkRel = "mentions" | "links" | "related" | "co-mentioned";

export type GraphLinkView = {
  source: string;
  target: string;
  rel: GraphLinkRel;
  /** co-mentioned: number of docs naming both entities; 1 otherwise. */
  weight: number;
};

export type KnowledgeGraphView = {
  nodes: GraphNodeView[];
  links: GraphLinkView[];
  stats: { entities: number; docs: number; links: number };
};

/** Canonical entity types. Pages may use synonyms ("client", "vendor",
 *  "tool"…); the parser folds them onto these so colors and filters agree. */
export const ENTITY_TYPES = [
  "person",
  "company",
  "project",
  "product",
  "other",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Where a workspace's one-off "connect existing knowledge" pass stands. */
export type GraphBackfillStatus = {
  state: "pending" | "running" | "done" | "failed" | "stopped" | "empty";
  finishedAt?: string;
  /** Docs the pass added/changed, queued for review. */
  reviewCount?: number;
  error?: string;
};
