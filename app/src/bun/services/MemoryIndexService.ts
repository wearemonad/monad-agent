import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryHit, MemorySourceType } from "../../shared/memory";
import { type DocFacts, KnowledgeGraph, parseDocFacts } from "./knowledgeGraph";

/** Long-term memory index: one bun:sqlite DB per workspace at
 *  .monad/memory.db, holding heading-level chunks of knowledge/ docs and
 *  exchange-level chunks of past conversations, searchable by keyword (FTS5)
 *  and by meaning (embedding vectors) merged with Reciprocal Rank Fusion.
 *  It also caches each doc's knowledge-graph facts (see knowledgeGraph.ts).
 *
 *  The DB is a disposable cache — markdown and session JSONL stay the source
 *  of truth, so deleting it is always safe (the next sync rebuilds). */

/** An embedding backend (Ollama in production, a fake in tests). embed()
 *  returns null when the backend is unavailable — search then degrades to
 *  keyword-only rather than failing. Vectors must be L2-normalized; `kind`
 *  distinguishes queries from documents for asymmetric-retrieval models. */
export type Embedder = {
  modelId(): string;
  embed(
    texts: string[],
    kind: "query" | "document",
  ): Promise<Float32Array[] | null>;
};

/** A session eligible for indexing (already filtered to Monad-tagged ones). */
export type SessionSource = {
  sessionId: string;
  title: string;
  jsonlPath: string;
};

export type MemoryStats = { chunks: number; embedded: number; sources: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
	path TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	stamp TEXT NOT NULL,
	indexed_bytes INTEGER,
	tail_offset INTEGER,
	tail_chunks INTEGER,
	tail_sig TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source_type TEXT NOT NULL,
	source_path TEXT NOT NULL,
	heading TEXT NOT NULL DEFAULT '',
	date TEXT NOT NULL DEFAULT '',
	body TEXT NOT NULL,
	embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	body, heading, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
	INSERT INTO chunks_fts(rowid, body, heading) VALUES (new.id, new.body, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
	INSERT INTO chunks_fts(chunks_fts, rowid, body, heading) VALUES ('delete', old.id, old.body, old.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF body, heading ON chunks BEGIN
	INSERT INTO chunks_fts(chunks_fts, rowid, body, heading) VALUES ('delete', old.id, old.body, old.heading);
	INSERT INTO chunks_fts(rowid, body, heading) VALUES (new.id, new.body, new.heading);
END;
CREATE TABLE IF NOT EXISTS graph_docs (
	path TEXT PRIMARY KEY,
	stamp TEXT NOT NULL,
	facts TEXT NOT NULL
);
`;

/** Bump when parseDocFacts changes what it extracts: graph stamps carry the
 *  version, so every doc re-parses once (chunks and embeddings untouched). */
const GRAPH_FACTS_VERSION = 2;

/** Section chunks longer than this get split at paragraph boundaries. */
const MAX_CHUNK_CHARS = 1_600;
/** Per-side cap when condensing a conversation exchange into one chunk. */
const MAX_EXCHANGE_SIDE_CHARS = 900;
/** Candidates fetched from each ranked list before fusion. */
const CANDIDATES_PER_LIST = 40;
/** Reciprocal Rank Fusion constant (the standard k=60). */
const RRF_K = 60;
/** Cosine floor for semantic candidates. Top-K cosine always returns
 *  SOMETHING — without a floor, an off-topic query ("zeppelin maintenance")
 *  surfaces the least-unrelated chunks as if they matched. Calibrated against
 *  nomic-embed-text on real workspace content: correct hits scored ≥0.53,
 *  off-topic query maxima ≤0.50. */
const MIN_SEMANTIC_SIMILARITY = 0.52;
/** Above this cosine a semantic-only hit counts as strong on its own; between
 *  the floor and this line it's returned but labeled weak (measured: truly
 *  related content ≥ ~0.56–0.66, unrelated tops out ~0.61 — the ranges
 *  overlap, so borderline hits are labeled rather than dropped). */
const STRONG_SEMANTIC_SIMILARITY = 0.62;

export type Chunk = { heading: string; date: string; body: string };

/** Split a knowledge markdown doc into heading-level chunks. The doc date
 *  comes from `ingested:` frontmatter when present (fileDate otherwise) and
 *  rides on every chunk. Oversized sections split at paragraph boundaries so
 *  one giant section can't blow the embedding/context budget. */
export function chunkMarkdown(content: string, fileDate: string): Chunk[] {
  let body = content;
  let date = fileDate;
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    date = fm[1].match(/^ingested:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] ?? date;
    body = body.slice(fm[0].length);
  }
  const chunks: Chunk[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (text.length < 20) return; // headings with no substance aren't recallable facts
    for (const piece of splitLong(text))
      chunks.push({ heading, date, body: piece });
  };
  for (const line of body.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) {
      flush();
      heading = h[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n{2,}/)) {
    if (buf && buf.length + para.length + 2 > MAX_CHUNK_CHARS) {
      out.push(buf.trim());
      buf = "";
    }
    // A single paragraph over the cap is hard-cut — pathological, not prose.
    buf = buf ? `${buf}\n\n${para}` : para.slice(0, MAX_CHUNK_CHARS * 2);
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** One session JSONL line that ended up in an exchange, located by byte. */
type ExchangeStart = { offset: number };

/** A session JSONL parsed into exchange chunks. Each chunk records the byte
 *  offset of the line that opened its exchange; `consumed` is how many bytes
 *  of complete lines were read (a half-flushed last line is left for later),
 *  and `lastExchangeOffset` where the final exchange began — the point an
 *  incremental re-read must restart from, since a reply may still be coming. */
export type ParsedSession = {
  chunks: (Chunk & ExchangeStart)[];
  consumed: number;
  lastExchangeOffset: number | null;
};

/** Condense session JSONL bytes into one chunk per user↔assistant exchange.
 *  Only conversational text counts — tool payloads and system-injected
 *  ("<"-prefixed) blocks are machine noise that would drown recall (the same
 *  filter ⌘K search applies, and the reason Hermes' trigram index skips tool
 *  rows). Each side is truncated: recall needs the gist plus enough exact
 *  wording to search on, not the full transcript (the JSONL keeps that).
 *  `baseOffset` is where `bytes` starts in the file. */
export function parseSessionExchanges(
  bytes: Uint8Array,
  fileDate: string,
  baseOffset = 0,
): ParsedSession {
  type Exchange = {
    user: string[];
    assistant: string[];
    date: string;
    offset: number;
  };
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;
  const decoder = new TextDecoder();
  let consumed = 0;
  let lineStart = 0;
  while (lineStart < bytes.length) {
    const nl = bytes.indexOf(0x0a, lineStart);
    const lineEnd = nl === -1 ? bytes.length : nl;
    const line = decoder.decode(bytes.subarray(lineStart, lineEnd));
    const offset = baseOffset + lineStart;
    const next = nl === -1 ? bytes.length : nl + 1;
    let msg: any = null;
    if (line.includes("{")) {
      try {
        msg = JSON.parse(line);
      } catch {
        // A last line without its newline that doesn't parse is still being
        // written: stop before it, the next sync reads it whole.
        if (nl === -1) break;
      }
    }
    consumed = next;
    lineStart = next;
    if (!msg || (msg.type !== "user" && msg.type !== "assistant")) continue;
    const content = msg.message?.content;
    const texts: string[] =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content
              .filter((b: any) => b?.type === "text" && b.text)
              .map((b: any) => b.text)
          : [];
    const visible = texts
      .map((t) => t.trim())
      .filter((t) => t && !t.startsWith("<"));
    if (!visible.length) continue;
    const date =
      typeof msg.timestamp === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(msg.timestamp)
        ? msg.timestamp.slice(0, 10)
        : fileDate;
    if (msg.type === "user") {
      current = { user: visible, assistant: [], date, offset };
      exchanges.push(current);
    } else if (current) {
      current.assistant.push(...visible);
    } else {
      current = { user: [], assistant: visible, date, offset };
      exchanges.push(current);
    }
  }
  const chunks: (Chunk & ExchangeStart)[] = [];
  for (const ex of exchanges) {
    const user = ex.user.join("\n").slice(0, MAX_EXCHANGE_SIDE_CHARS);
    const assistant = ex.assistant.join("\n").slice(0, MAX_EXCHANGE_SIDE_CHARS);
    const body = [
      user && `User: ${user}`,
      assistant && `Assistant: ${assistant}`,
    ]
      .filter(Boolean)
      .join("\n");
    if (body.length < 20) continue;
    chunks.push({ heading: "", date: ex.date, body, offset: ex.offset });
  }
  return {
    chunks,
    consumed,
    lastExchangeOffset: exchanges[exchanges.length - 1]?.offset ?? null,
  };
}

/** parseSessionExchanges over a whole JSONL string. */
export function chunkSessionJsonl(jsonl: string, fileDate: string): Chunk[] {
  return parseSessionExchanges(
    new TextEncoder().encode(jsonl),
    fileDate,
  ).chunks.map(({ heading, date, body }) => ({ heading, date, body }));
}

/** English stop-words dropped from keyword queries. OR-joined natural-language
 *  queries otherwise degenerate: "when do we get paid" matches every chunk
 *  containing "we", and BM25 then favors whichever short chunk says "we" —
 *  observed live before this list existed. Content words only. */
const STOP_WORDS = new Set(
  "a about an and any are as at be been being but by can could did do does for from get had has have how i if in into is it its just me my not now of on or our should so than that the their them then there they this to was we what when where which who will with would you your".split(
    " ",
  ),
);

/** FTS5 treats punctuation as query syntax and throws on raw user input —
 *  reduce the query to quoted content terms OR-joined (implicit AND would zero
 *  out recall on natural-language questions). Returns "" when nothing
 *  searchable, e.g. a pure stop-word query — the semantic list still runs. */
export function sanitizeFtsQuery(query: string): string {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => !STOP_WORDS.has(t),
  );
  return terms
    .slice(0, 24)
    .map((t) => `"${t}"`)
    .join(" OR ");
}

/** Merge ranked id lists with Reciprocal Rank Fusion: 1/(k + rank), summed. */
export function rrfMerge(lists: number[][], k = RRF_K): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

/** Final ordering: fused score, weighted so curated knowledge outranks raw
 *  conversation at equal relevance, plus a small recency boost that decays
 *  over ~3 months — enough to break ties toward fresh context, never enough
 *  to bury a strong old match. */
export function rerank(
  rrf: number,
  sourceType: MemorySourceType,
  date: string,
  nowMs: number,
): number {
  const weight = sourceType === "knowledge" ? 1.15 : 1.0;
  const ageDays = date
    ? Math.max(0, (nowMs - Date.parse(date)) / 86_400_000)
    : 365;
  const recency = Number.isFinite(ageDays)
    ? 0.004 * Math.exp(-ageDays / 90)
    : 0;
  return rrf * weight + recency;
}

export class MemoryIndexService {
  private dbs = new Map<string, Database>();
  /** Built knowledge graph per workspace, dropped whenever graph_docs
   *  changes — rebuilt lazily from the cached facts, never from the files. */
  private graphs = new Map<string, KnowledgeGraph>();
  /** Per-workspace embedding backfill in flight (dedup guard). */
  private backfilling = new Set<string>();

  constructor(private embedder?: Embedder) {}

  private db(wsPath: string): Database {
    let db = this.dbs.get(wsPath);
    if (db) return db;
    const dir = path.join(wsPath, ".monad");
    fs.mkdirSync(dir, { recursive: true });
    db = new Database(path.join(dir, "memory.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    migrate(db);
    this.dbs.set(wsPath, db);
    this.reconcileEmbeddingModel(db);
    return db;
  }

  /** Switching embedding models makes every stored vector incomparable with
   *  new queries — clear them all so the backfill re-embeds consistently. */
  private reconcileEmbeddingModel(db: Database): void {
    if (!this.embedder) return;
    const model = this.embedder.modelId();
    const row = db
      .query("SELECT value FROM meta WHERE key = 'embed_model'")
      .get() as { value: string } | null;
    if (row?.value === model) return;
    if (row) db.exec("UPDATE chunks SET embedding = NULL");
    db.query(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('embed_model', ?)",
    ).run(model);
  }

  close(wsPath?: string): void {
    for (const [p, db] of this.dbs) {
      if (wsPath && p !== wsPath) continue;
      db.close();
      this.dbs.delete(p);
      this.graphs.delete(p);
    }
  }

  stats(wsPath: string): MemoryStats {
    const db = this.db(wsPath);
    const chunks = (
      db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    const embedded = (
      db
        .query("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL")
        .get() as {
        n: number;
      }
    ).n;
    const sources = (
      db.query("SELECT COUNT(*) AS n FROM sources").get() as { n: number }
    ).n;
    return { chunks, embedded, sources };
  }

  /** Incrementally index knowledge/*.md (INDEX.md, working-memory.md,
   *  originals/ and dotfiles excluded — INDEX is a catalog, working memory is
   *  already injected into every prompt; indexing either would return
   *  boilerplate as "recall"). Unchanged files (mtime:size stamp) are
   *  skipped; vanished files drop their chunks. The knowledge graph's per-doc
   *  facts ride along under their own stamp, so a parser upgrade re-parses
   *  docs without re-chunking (and re-embedding) them. */
  syncKnowledge(wsPath: string): boolean {
    const db = this.db(wsPath);
    const base = path.join(wsPath, "knowledge");
    const seen = new Set<string>();
    let graphChanged = false;
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
          continue;
        }
        if (!entry.name.endsWith(".md") || entry.name === "INDEX.md") continue;
        const rel = path.relative(base, full);
        if (rel === "working-memory.md") continue;
        seen.add(rel);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue; // vanished mid-walk — pruned on the next sync
        }
        const stamp = `${st.mtimeMs}:${st.size}`;
        const graphStamp = `g${GRAPH_FACTS_VERSION}:${stamp}`;
        const chunksStale = this.sourceStamp(db, rel) !== stamp;
        const graphStale = this.graphStamp(db, rel) !== graphStamp;
        if (!chunksStale && !graphStale) continue;
        let content: string;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const fileDate = new Date(st.mtimeMs).toISOString().slice(0, 10);
        if (chunksStale)
          this.replaceSource(
            db,
            "knowledge",
            rel,
            stamp,
            chunkMarkdown(content, fileDate),
          );
        if (graphStale) {
          db.query(
            "INSERT OR REPLACE INTO graph_docs (path, stamp, facts) VALUES (?, ?, ?)",
          ).run(
            rel,
            graphStamp,
            JSON.stringify(parseDocFacts(rel, content, fileDate)),
          );
          graphChanged = true;
        }
      }
    };
    walk(base);
    this.pruneSources(db, "knowledge", seen);
    for (const { path: p } of db.query("SELECT path FROM graph_docs").all() as {
      path: string;
    }[]) {
      if (seen.has(p)) continue;
      db.query("DELETE FROM graph_docs WHERE path = ?").run(p);
      graphChanged = true;
    }
    if (graphChanged) this.graphs.delete(wsPath);
    return graphChanged;
  }

  private graphStamp(db: Database, docPath: string): string | null {
    const row = db
      .query("SELECT stamp FROM graph_docs WHERE path = ?")
      .get(docPath) as { stamp: string } | null;
    return row?.stamp ?? null;
  }

  /** This workspace's knowledge graph, as of the last syncKnowledge. Each
   *  workspace has its own memory.db, so graphs can never mix. */
  graph(wsPath: string): KnowledgeGraph {
    const cached = this.graphs.get(wsPath);
    if (cached) return cached;
    const graph = KnowledgeGraph.build(this.graphDocs(wsPath));
    this.graphs.set(wsPath, graph);
    return graph;
  }

  /** The cached per-doc graph facts the graph is built from — what the
   *  worker hands the main thread, which builds its own copy. */
  graphDocs(wsPath: string): { path: string; facts: DocFacts }[] {
    const rows = this.db(wsPath)
      .query("SELECT path, facts FROM graph_docs")
      .all() as { path: string; facts: string }[];
    const docs: { path: string; facts: DocFacts }[] = [];
    for (const r of rows) {
      try {
        docs.push({ path: r.path, facts: JSON.parse(r.facts) as DocFacts });
      } catch {
        // corrupt row — the doc re-parses when its file next changes
      }
    }
    return docs;
  }

  /** Incrementally index past conversations. Callers pass the Monad-tagged
   *  sessions only, so hidden runs (ingest, background jobs) never pollute
   *  recall — the same noise-exclusion lesson Hermes learned the hard way.
   *  `skip` names Sessions with a Turn in flight: they keep their chunks and
   *  are indexed once the Turn ends.
   *
   *  Session JSONL only grows, so a grown file is read from where its last
   *  exchange began (a reply may have been on its way), and only exchanges
   *  that changed are rewritten — the rest keep their embeddings. A file
   *  that shrank or no longer matches at that point is re-indexed whole. */
  syncSessions(
    wsPath: string,
    sessions: SessionSource[],
    opts: { skip?: ReadonlySet<string> } = {},
  ): void {
    const db = this.db(wsPath);
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.sessionId);
      if (opts.skip?.has(s.sessionId)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(s.jsonlPath);
      } catch {
        continue;
      }
      const stamp = `${st.mtimeMs}:${st.size}:${s.title}`;
      const state = this.sessionState(db, s.sessionId);
      if (state?.stamp === stamp) continue;
      try {
        this.indexSession(db, s, st, stamp, state);
      } catch {
        // unreadable right now — retried on the next sync
      }
    }
    this.pruneSources(db, "session", seen);
  }

  private sessionState(db: Database, sessionId: string): SessionState | null {
    return db
      .query(
        "SELECT stamp, indexed_bytes, tail_offset, tail_chunks, tail_sig FROM sources WHERE path = ?",
      )
      .get(sessionId) as SessionState | null;
  }

  private indexSession(
    db: Database,
    s: SessionSource,
    st: fs.Stats,
    stamp: string,
    state: SessionState | null,
  ): void {
    const fd = fs.openSync(s.jsonlPath, "r");
    try {
      const incremental =
        state?.indexed_bytes != null &&
        state.tail_offset != null &&
        state.tail_chunks != null &&
        st.size >= state.indexed_bytes &&
        state.tail_sig ===
          lineSignature(readBytes(fd, state.tail_offset, SIG_BYTES));
      const from = incremental ? (state.tail_offset as number) : 0;
      const bytes = readBytes(fd, from, st.size - from);
      const fileDate = new Date(st.mtimeMs).toISOString().slice(0, 10);
      const parsed = parseSessionExchanges(bytes, fileDate, from);
      const chunks = parsed.chunks.map((c) => ({ ...c, heading: s.title }));
      // Next time, restart at the last exchange: its reply may still grow.
      const tailOffset = parsed.lastExchangeOffset ?? from;
      const settled = chunks.filter((c) => c.offset < tailOffset).length;
      const insert = db.query(
        "INSERT INTO chunks (source_type, source_path, heading, date, body) VALUES ('session', ?, ?, ?, ?)",
      );
      db.transaction(() => {
        let pending = chunks;
        if (!incremental) {
          db.query("DELETE FROM chunks WHERE source_path = ?").run(s.sessionId);
        } else {
          // Chunks already stored from the re-read region: keep the ones
          // that came out identical (and their vectors), replace the rest.
          const stored = db
            .query(
              "SELECT id, body FROM chunks WHERE source_path = ? ORDER BY id LIMIT -1 OFFSET ?",
            )
            .all(s.sessionId, state.tail_chunks as number) as {
            id: number;
            body: string;
          }[];
          let same = 0;
          while (
            same < stored.length &&
            same < chunks.length &&
            stored[same].body === chunks[same].body
          )
            same++;
          const drop = db.query("DELETE FROM chunks WHERE id = ?");
          for (const row of stored.slice(same)) drop.run(row.id);
          pending = chunks.slice(same);
          db.query(
            "UPDATE chunks SET heading = ? WHERE source_path = ? AND heading != ?",
          ).run(s.title, s.sessionId, s.title);
        }
        for (const c of pending)
          insert.run(s.sessionId, c.heading, c.date, c.body);
        db.query(
          `INSERT OR REPLACE INTO sources (path, type, stamp, indexed_bytes, tail_offset, tail_chunks, tail_sig)
           VALUES (?, 'session', ?, ?, ?, ?, ?)`,
        ).run(
          s.sessionId,
          stamp,
          from + parsed.consumed,
          tailOffset,
          (incremental ? (state.tail_chunks as number) : 0) + settled,
          lineSignature(
            bytes.subarray(tailOffset - from, tailOffset - from + SIG_BYTES),
          ),
        );
      })();
    } finally {
      fs.closeSync(fd);
    }
  }

  private sourceStamp(db: Database, sourcePath: string): string | null {
    const row = db
      .query("SELECT stamp FROM sources WHERE path = ?")
      .get(sourcePath) as { stamp: string } | null;
    return row?.stamp ?? null;
  }

  private replaceSource(
    db: Database,
    type: MemorySourceType,
    sourcePath: string,
    stamp: string,
    chunks: Chunk[],
  ): void {
    const insert = db.query(
      "INSERT INTO chunks (source_type, source_path, heading, date, body) VALUES (?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      db.query("DELETE FROM chunks WHERE source_path = ?").run(sourcePath);
      for (const c of chunks)
        insert.run(type, sourcePath, c.heading, c.date, c.body);
      db.query(
        "INSERT OR REPLACE INTO sources (path, type, stamp) VALUES (?, ?, ?)",
      ).run(sourcePath, type, stamp);
    })();
  }

  private pruneSources(
    db: Database,
    type: MemorySourceType,
    seen: Set<string>,
  ): void {
    const rows = db
      .query("SELECT path FROM sources WHERE type = ?")
      .all(type) as {
      path: string;
    }[];
    for (const { path: p } of rows) {
      if (seen.has(p)) continue;
      db.transaction(() => {
        db.query("DELETE FROM chunks WHERE source_path = ?").run(p);
        db.query("DELETE FROM sources WHERE path = ?").run(p);
      })();
    }
  }

  /** Hybrid search: FTS5 (BM25) and vector cosine run as two ranked lists,
   *  plus a third from the knowledge graph when the query names a known
   *  entity (its page, then the docs linked to it — catching docs that only
   *  name it in frontmatter or by alias). Merged with RRF, then reranked by
   *  source weight + recency. Degrades to keyword-only whenever embeddings
   *  are unavailable (no Ollama, cold backfill) — never an error. */
  async search(
    wsPath: string,
    query: string,
    opts: { limit?: number; scope?: MemorySourceType } = {},
  ): Promise<MemoryHit[]> {
    const db = this.db(wsPath);
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
    const scopeSql = opts.scope ? ` AND source_type = '${opts.scope}'` : "";

    const fts = sanitizeFtsQuery(query);
    const keywordIds: number[] = fts
      ? (
          db
            .query(
              `SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
							 WHERE chunks_fts MATCH ?${scopeSql} ORDER BY f.rank LIMIT ?`,
            )
            .all(fts, CANDIDATES_PER_LIST) as { id: number }[]
        ).map((r) => r.id)
      : [];

    const semantic = await this.semanticCandidates(db, query, scopeSql);
    const semanticIds = semantic ? semantic.map((s) => s.id) : null;
    const graph = opts.scope === "session" ? null : this.graph(wsPath);
    const linked = graph
      ? this.graphCandidates(db, graph, query)
      : { ids: [], pageIds: new Set<number>() };

    const lists = [keywordIds];
    if (semanticIds) lists.push(semanticIds);
    if (linked.ids.length) lists.push(linked.ids);
    const fused = rrfMerge(lists);
    if (fused.size === 0) return [];
    const keywordSet = new Set(keywordIds);
    const simById = new Map((semantic ?? []).map((s) => [s.id, s.sim]));

    const now = Date.now();
    const get = db.query(
      "SELECT source_type, source_path, heading, date, body FROM chunks WHERE id = ?",
    );
    const hits: MemoryHit[] = [];
    for (const [id, rrf] of fused) {
      const row = get.get(id) as {
        source_type: MemorySourceType;
        source_path: string;
        heading: string;
        date: string;
        body: string;
      } | null;
      if (!row) continue;
      const about =
        graph && row.source_type === "knowledge"
          ? graph.entitiesOfPath(row.source_path).slice(0, 5)
          : [];
      hits.push({
        sourceType: row.source_type,
        sourcePath: row.source_path,
        heading: row.heading,
        date: row.date,
        body: row.body,
        score: rerank(rrf, row.source_type, row.date, now),
        // A graph-only hit is ABOUT the entity but not necessarily about the
        // question ("Acme payment terms" → Acme's brand doc): weak, unless it
        // is the entity's own page.
        confidence:
          keywordSet.has(id) ||
          linked.pageIds.has(id) ||
          (simById.get(id) ?? 0) >= STRONG_SEMANTIC_SIMILARITY
            ? "strong"
            : "weak",
        ...(about.length ? { entities: about } : {}),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Chunk ids linked through the graph to entities the query names: the
   *  entities' own pages first, then the docs mentioning them, newest first. */
  private graphCandidates(
    db: Database,
    graph: KnowledgeGraph,
    query: string,
  ): { ids: number[]; pageIds: Set<number> } {
    const entities = graph.entitiesInQuery(query);
    const pageIds = new Set<number>();
    if (entities.length === 0) return { ids: [], pageIds };
    const { pages, docs } = graph.pathsAbout(entities);
    const ordered = [...pages, ...docs.filter((d) => !pages.includes(d))].slice(
      0,
      CANDIDATES_PER_LIST,
    );
    const byPath = db.query(
      "SELECT id FROM chunks WHERE source_type = 'knowledge' AND source_path = ? ORDER BY id",
    );
    const ids: number[] = [];
    for (const p of ordered) {
      for (const { id } of byPath.all(p) as { id: number }[]) {
        ids.push(id);
        if (pages.includes(p)) pageIds.add(id);
      }
      if (ids.length >= CANDIDATES_PER_LIST) break;
    }
    return { ids: ids.slice(0, CANDIDATES_PER_LIST), pageIds };
  }

  /** Top-K (id, cosine) over the stored vectors, best first, or null when the
   *  semantic layer can't contribute (no embedder, backend down, nothing
   *  embedded). Brute force over Float32Array blobs — measured ~1ms at 2k
   *  chunks, so an ANN index would cost more than it saves until ~100k. */
  private async semanticCandidates(
    db: Database,
    query: string,
    scopeSql: string,
  ): Promise<{ id: number; sim: number }[] | null> {
    if (!this.embedder) return null;
    const rows = db
      .query(
        `SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL${scopeSql}`,
      )
      .all() as { id: number; embedding: Uint8Array }[];
    if (rows.length === 0) return null;
    const q = (await this.embedder.embed([query], "query"))?.[0];
    if (!q) return null;
    const scored: { id: number; sim: number }[] = [];
    for (const row of rows) {
      const v = toFloat32(row.embedding);
      if (v.length !== q.length) continue; // stale dims mid-model-switch
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * v[i];
      if (dot >= MIN_SEMANTIC_SIMILARITY) scored.push({ id: row.id, sim: dot });
    }
    return scored.sort((a, b) => b.sim - a.sim).slice(0, CANDIDATES_PER_LIST);
  }

  /** All chunks of one session in conversation order — powers the
   *  memory_session tool's bookends + context window. */
  sessionChunks(wsPath: string, sessionId: string): Chunk[] {
    const db = this.db(wsPath);
    const rows = db
      .query(
        "SELECT heading, date, body FROM chunks WHERE source_path = ? AND source_type = 'session' ORDER BY id",
      )
      .all(sessionId) as Chunk[];
    return rows;
  }

  /** Embed chunks that don't have a vector yet, in batches, fire-and-forget.
   *  Stops quietly when the backend is unavailable — the next call resumes
   *  where it left off (embedding IS NULL is the work queue). */
  async backfillEmbeddings(wsPath: string, batchSize = 32): Promise<number> {
    if (!this.embedder || this.backfilling.has(wsPath)) return 0;
    this.backfilling.add(wsPath);
    let total = 0;
    try {
      const db = this.db(wsPath);
      const pick = db.query(
        "SELECT id, heading, body FROM chunks WHERE embedding IS NULL LIMIT ?",
      );
      const store = db.query("UPDATE chunks SET embedding = ? WHERE id = ?");
      for (;;) {
        const rows = pick.all(batchSize) as {
          id: number;
          heading: string;
          body: string;
        }[];
        if (rows.length === 0) break;
        const vectors = await this.embedder.embed(
          // Heading prefixed into the embedded text: "Payment terms\nNet-30…"
          // carries the section topic into the vector.
          rows.map((r) => (r.heading ? `${r.heading}\n${r.body}` : r.body)),
          "document",
        );
        if (!vectors || vectors.length !== rows.length) break;
        db.transaction(() => {
          rows.forEach((r, i) => {
            const v = vectors[i];
            store.run(
              new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
              r.id,
            );
          });
        })();
        total += rows.length;
      }
    } finally {
      this.backfilling.delete(wsPath);
    }
    return total;
  }
}

/** Where incremental session indexing left off (null columns: indexed
 *  before incremental indexing existed — the next change re-reads it whole). */
type SessionState = {
  stamp: string;
  /** Bytes of complete lines read so far; a smaller file was rewritten. */
  indexed_bytes: number | null;
  /** Byte offset where the last indexed exchange began. */
  tail_offset: number | null;
  /** Stored chunks that come before tail_offset. */
  tail_chunks: number | null;
  /** lineSignature of the line at tail_offset. */
  tail_sig: string | null;
};

/** Columns added after the first release: CREATE IF NOT EXISTS won't add
 *  them to an existing memory.db. */
function migrate(db: Database): void {
  const cols = new Set(
    (db.query("PRAGMA table_info(sources)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const [name, type] of [
    ["indexed_bytes", "INTEGER"],
    ["tail_offset", "INTEGER"],
    ["tail_chunks", "INTEGER"],
    ["tail_sig", "TEXT"],
  ])
    if (!cols.has(name))
      db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
}

/** How much of the line at tail_offset its signature covers. */
const SIG_BYTES = 256;

/** Identifies the line starting at these bytes (up to its newline, at most
 *  SIG_BYTES), so a rewritten file is noticed even when it didn't shrink. */
function lineSignature(bytes: Uint8Array): string {
  const nl = bytes.indexOf(0x0a);
  return Bun.hash(nl === -1 ? bytes : bytes.subarray(0, nl)).toString(36);
}

function readBytes(fd: number, position: number, length: number): Uint8Array {
  const buf = Buffer.alloc(Math.max(0, length));
  const n = length > 0 ? fs.readSync(fd, buf, 0, length, position) : 0;
  return buf.subarray(0, n);
}

function toFloat32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
