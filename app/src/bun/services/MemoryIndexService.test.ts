import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MemoryIndexService,
  chunkMarkdown,
  chunkSessionJsonl,
  rerank,
  rrfMerge,
  sanitizeFtsQuery,
  type Embedder,
} from "./MemoryIndexService";
import { buildMemoryTools, formatResults } from "./memoryTools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-memory-test-"));
const ws = path.join(root, "brain");

/** Deterministic fake embedder: maps a fixed vocabulary onto axes so texts
 *  sharing MEANING (per the table) land close, without keyword overlap. */
const VOCAB: Record<string, number> = {
  // axis 0: payments
  stripe: 0,
  "net-30": 0,
  invoice: 0,
  payment: 0,
  payments: 0,
  billing: 0,
  // axis 1: hiring
  hire: 1,
  hiring: 1,
  recruiter: 1,
  candidate: 1,
  // axis 2: infra
  server: 2,
  deploy: 2,
  hosting: 2,
};
function fakeVector(text: string): Float32Array {
  const v = new Float32Array(259);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []) {
    if (word in VOCAB) v[VOCAB[word]] += 1;
    // Residual axes hash-bucketed per word (like a real embedder, unrelated
    // texts land nearly orthogonal — never on a shared constant axis).
    else v[3 + (djb2(word) % 256)] += 0.5;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}
const fakeEmbedder = (id = "fake-v1"): Embedder => ({
  modelId: () => id,
  embed: async (texts) => texts.map(fakeVector),
});

function writeKnowledge(rel: string, content: string): void {
  const full = path.join(ws, "knowledge", rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function sessionLine(
  type: "user" | "assistant",
  text: string,
  timestamp?: string,
): string {
  return JSON.stringify({
    type,
    timestamp,
    message: { content: [{ type: "text", text }] },
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(ws, "knowledge"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("chunkMarkdown", () => {
  test("splits by headings and carries the frontmatter date", () => {
    const chunks = chunkMarkdown(
      `---\nsource: chat\ningested: 2026-05-01\ntags: [note]\n---\n\n# Acme Corp\n\nAcme is our biggest client since 2024.\n\n## Payment terms\n\nInvoices are net-30 via Stripe. Late fees apply after 45 days.\n`,
      "2026-08-01",
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe("Acme Corp");
    expect(chunks[0].date).toBe("2026-05-01");
    expect(chunks[1].heading).toBe("Payment terms");
    expect(chunks[1].body).toContain("net-30");
  });

  test("falls back to the file date and skips trivial sections", () => {
    const chunks = chunkMarkdown(
      "# Title\n\nx\n\n## Real\n\nThis section has enough substance to index.",
      "2026-07-07",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].date).toBe("2026-07-07");
  });

  test("splits oversized sections at paragraph boundaries", () => {
    const para =
      "A paragraph of reasonable length about the quarterly plan. ".repeat(10);
    const chunks = chunkMarkdown(
      `# Big\n\n${para}\n\n${para}\n\n${para}\n\n${para}`,
      "2026-01-01",
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.body.length).toBeLessThanOrEqual(3200);
  });
});

describe("chunkSessionJsonl", () => {
  test("one chunk per exchange, system payloads and tool noise excluded", () => {
    const jsonl = [
      sessionLine("user", "<system-reminder>injected</system-reminder>"),
      sessionLine(
        "user",
        "What did we agree with Acme about payments?",
        "2026-06-10T10:00:00Z",
      ),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      }),
      sessionLine(
        "assistant",
        "Acme pays net-30 through Stripe, agreed in the March call.",
      ),
      sessionLine("user", "Great, and the late fee?", "2026-06-10T10:05:00Z"),
      sessionLine("assistant", "1.5% monthly after 45 days."),
    ].join("\n");
    const chunks = chunkSessionJsonl(jsonl, "2026-06-11");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].body).toContain("User: What did we agree");
    expect(chunks[0].body).toContain("Assistant: Acme pays net-30");
    expect(chunks[0].date).toBe("2026-06-10");
    expect(chunks[1].body).toContain("late fee");
  });

  test("truncates giant exchanges instead of indexing whole transcripts", () => {
    const jsonl = [
      sessionLine("user", "q ".repeat(2000)),
      sessionLine("assistant", "a ".repeat(2000)),
    ].join("\n");
    const [chunk] = chunkSessionJsonl(jsonl, "2026-01-01");
    expect(chunk.body.length).toBeLessThan(2000);
  });
});

describe("sanitizeFtsQuery", () => {
  test("quotes content terms and OR-joins so punctuation can't break MATCH", () => {
    expect(sanitizeFtsQuery('what "about" net-30 (payments)?')).toBe(
      '"net" OR "30" OR "payments"',
    );
  });
  test("stop-words are dropped — 'we' must not match every chunk", () => {
    expect(sanitizeFtsQuery("when do we get paid")).toBe('"paid"');
  });
  test("empty when nothing searchable (pure stop-words or punctuation)", () => {
    expect(sanitizeFtsQuery("!?():")).toBe("");
    expect(sanitizeFtsQuery("what do we have")).toBe("");
  });
});

describe("rrfMerge + rerank", () => {
  test("an id ranked in both lists beats single-list ids", () => {
    const scores = rrfMerge([
      [1, 2, 3],
      [2, 4],
    ]);
    expect(scores.get(2)!).toBeGreaterThan(scores.get(1)!);
    expect(scores.get(2)!).toBeGreaterThan(scores.get(4)!);
  });
  test("knowledge outweighs sessions; recency breaks ties, never buries relevance", () => {
    const now = Date.parse("2026-08-09");
    const rrf = 1 / 61;
    expect(rerank(rrf, "knowledge", "2026-01-01", now)).toBeGreaterThan(
      rerank(rrf, "session", "2026-01-01", now),
    );
    expect(rerank(rrf, "session", "2026-08-08", now)).toBeGreaterThan(
      rerank(rrf, "session", "2025-08-08", now),
    );
    // A clearly better match (rank 1 vs rank 30) wins despite being old.
    expect(rerank(1 / 61, "session", "2024-01-01", now)).toBeGreaterThan(
      rerank(1 / 90, "session", "2026-08-08", now),
    );
  });
});

describe("MemoryIndexService", () => {
  const index = new MemoryIndexService(fakeEmbedder());
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  afterAll(() => index.close());

  test("indexes knowledge and finds it by keyword", async () => {
    writeKnowledge(
      "clients/acme.md",
      "---\nsource: contract\ningested: 2026-03-05\n---\n\n# Acme Corp\n\nBiggest client. Contact: Jo Reyes.\n\n## Payment terms\n\nInvoices net-30 via Stripe; 1.5% late fee after 45 days.",
    );
    writeKnowledge(
      "product/hosting.md",
      "# Hosting\n\nWe deploy the product on a Hetzner server in Falkenstein.",
    );
    index.syncKnowledge(ws);
    const hits = await index.search(ws, "stripe late fee");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sourcePath).toBe("clients/acme.md");
    expect(hits[0].heading).toBe("Payment terms");
    expect(hits[0].date).toBe("2026-03-05");
  });

  test("finds by MEANING with zero keyword overlap once embeddings backfill", async () => {
    await index.backfillEmbeddings(ws);
    const stats = index.stats(ws);
    expect(stats.embedded).toBe(stats.chunks);
    // "billing invoice" shares no keyword with the hosting doc and only
    // "invoices" (stemmed) with acme — the vector axis does the work.
    const hits = await index.search(ws, "billing payment");
    expect(hits[0].sourcePath).toBe("clients/acme.md");
  });

  test("indexes sessions, prunes deleted ones, and re-index is idempotent", async () => {
    const jsonl = [
      sessionLine(
        "user",
        "Should we hire the recruiter's candidate?",
        "2026-07-01T09:00:00Z",
      ),
      sessionLine(
        "assistant",
        "Yes — schedule a final round; hiring closes Friday.",
      ),
    ].join("\n");
    const jsonlPath = path.join(sessionsDir, "s1.jsonl");
    fs.writeFileSync(jsonlPath, jsonl);
    const sources = [{ sessionId: "s1", title: "Hiring decision", jsonlPath }];
    index.syncSessions(ws, sources);
    const before = index.stats(ws).chunks;
    index.syncSessions(ws, sources); // unchanged stamp → no rewrite
    expect(index.stats(ws).chunks).toBe(before);

    const hits = await index.search(ws, "candidate", { scope: "session" });
    expect(hits[0].sourcePath).toBe("s1");
    expect(hits[0].heading).toBe("Hiring decision");

    index.syncSessions(ws, []); // session deleted → chunks pruned
    expect(
      (await index.search(ws, "candidate", { scope: "session" })).length,
    ).toBe(0);
    index.syncSessions(ws, sources); // restore for later tests
  });

  test("working-memory.md is never indexed (already injected every session)", async () => {
    writeKnowledge(
      "working-memory.md",
      "# Working Memory\n\n## Key facts\n\n- The zanzibar account number is 42-4242",
    );
    index.syncKnowledge(ws);
    expect((await index.search(ws, "zanzibar account")).length).toBe(0);
  });

  test("re-indexes a changed knowledge file and drops vanished ones", async () => {
    writeKnowledge(
      "notes/tmp.md",
      "# Temp\n\nThe office wifi password is on the whiteboard.",
    );
    index.syncKnowledge(ws);
    expect((await index.search(ws, "wifi password")).length).toBeGreaterThan(0);
    fs.rmSync(path.join(ws, "knowledge/notes/tmp.md"));
    index.syncKnowledge(ws);
    expect((await index.search(ws, "wifi password")).length).toBe(0);
  });

  test("switching embedding models clears vectors for re-embedding", async () => {
    const index2 = new MemoryIndexService(fakeEmbedder("fake-v2"));
    try {
      expect(index2.stats(ws).embedded).toBe(0); // cleared on open
      await index2.backfillEmbeddings(ws);
      expect(index2.stats(ws).embedded).toBe(index2.stats(ws).chunks);
    } finally {
      index2.close();
    }
  });

  test("keyword-only degradation when the embedder is unavailable", async () => {
    const down = new MemoryIndexService({
      modelId: () => "fake-v2",
      embed: async () => null,
    });
    try {
      const hits = await down.search(ws, "stripe");
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      down.close(); // shared DB file — close before other tests reopen
    }
  });
});

describe("incremental session indexing", () => {
  /** Counts every text it is asked to embed. */
  const embedded: string[] = [];
  const counting: Embedder = {
    modelId: () => "fake-v1",
    embed: async (texts) => {
      embedded.push(...texts);
      return texts.map(fakeVector);
    },
  };
  const wsInc = path.join(root, "incremental");
  const jsonlPath = path.join(root, "incremental-session.jsonl");
  const source = { sessionId: "inc", title: "Payments chat", jsonlPath };
  const exchange = (q: string, a: string) =>
    `${sessionLine("user", q)}\n${sessionLine("assistant", a)}\n`;

  test("appending to a Session embeds only the new exchange", async () => {
    const index = new MemoryIndexService(counting);
    fs.writeFileSync(
      jsonlPath,
      exchange(
        "How does Acme pay us these days?",
        "Acme pays net-30 through Stripe since March.",
      ) +
        exchange(
          "Who handles the hiring loop?",
          "The recruiter runs it; the candidate pool closes Friday.",
        ),
    );
    index.syncSessions(wsInc, [source]);
    await index.backfillEmbeddings(wsInc);
    expect(embedded).toHaveLength(2);

    embedded.length = 0;
    fs.appendFileSync(
      jsonlPath,
      exchange(
        "Where is the product hosted?",
        "On a Hetzner server; deploys go out from CI.",
      ),
    );
    index.syncSessions(wsInc, [source]);
    await index.backfillEmbeddings(wsInc);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toContain("Hetzner");

    // Search still sees the whole conversation, in order.
    const chunks = index.sessionChunks(wsInc, "inc");
    expect(chunks.map((c) => c.body.slice(6, 20))).toEqual([
      "How does Acme ",
      "Who handles th",
      "Where is the p",
    ]);
    const hits = await index.search(wsInc, "Hetzner", { scope: "session" });
    expect(hits[0].body).toContain("Hetzner");
    index.close();
  });

  test("a reply landing after its question updates that exchange only", async () => {
    const index = new MemoryIndexService(counting);
    const ws2 = path.join(root, "incremental-reply");
    fs.writeFileSync(
      jsonlPath,
      exchange("How does Acme pay us these days?", "Net-30 through Stripe.") +
        `${sessionLine("user", "And who handles the hiring loop now?")}\n`,
    );
    index.syncSessions(ws2, [source]);
    await index.backfillEmbeddings(ws2);
    embedded.length = 0;
    fs.appendFileSync(
      jsonlPath,
      `${sessionLine("assistant", "The recruiter runs the hiring loop.")}\n`,
    );
    index.syncSessions(ws2, [source]);
    await index.backfillEmbeddings(ws2);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toContain("recruiter runs");
    expect(index.sessionChunks(ws2, "inc")).toHaveLength(2);
    index.close();
  });

  test("a half-written last line waits until it is complete", async () => {
    const index = new MemoryIndexService(counting);
    const ws3 = path.join(root, "incremental-partial");
    const full = sessionLine("user", "Where is the product hosted today?");
    fs.writeFileSync(
      jsonlPath,
      exchange("How does Acme pay us these days?", "Net-30 through Stripe.") +
        full.slice(0, 30),
    );
    index.syncSessions(ws3, [source]);
    expect(index.sessionChunks(ws3, "inc")).toHaveLength(1);
    fs.appendFileSync(jsonlPath, `${full.slice(30)}\n`);
    index.syncSessions(ws3, [source]);
    expect(index.sessionChunks(ws3, "inc").map((c) => c.body)).toEqual([
      "User: How does Acme pay us these days?\nAssistant: Net-30 through Stripe.",
      "User: Where is the product hosted today?",
    ]);
    index.close();
  });

  test("a file that shrank is re-indexed whole", async () => {
    const index = new MemoryIndexService(counting);
    const ws4 = path.join(root, "incremental-shrink");
    fs.writeFileSync(
      jsonlPath,
      exchange("How does Acme pay us these days?", "Net-30 through Stripe.") +
        exchange("Who handles the hiring loop?", "The recruiter does."),
    );
    index.syncSessions(ws4, [source]);
    fs.writeFileSync(
      jsonlPath,
      exchange("Where is the product hosted?", "On a Hetzner server."),
    );
    index.syncSessions(ws4, [source]);
    expect(index.sessionChunks(ws4, "inc").map((c) => c.body)).toEqual([
      "User: Where is the product hosted?\nAssistant: On a Hetzner server.",
    ]);
    index.close();
  });

  test("Sessions with a Turn in flight are skipped, not pruned", async () => {
    const index = new MemoryIndexService(counting);
    const ws5 = path.join(root, "incremental-skip");
    fs.writeFileSync(
      jsonlPath,
      exchange("How does Acme pay us these days?", "Net-30 through Stripe."),
    );
    index.syncSessions(ws5, [source]);
    fs.appendFileSync(
      jsonlPath,
      exchange("Who handles the hiring loop?", "The recruiter does."),
    );
    index.syncSessions(ws5, [source], { skip: new Set(["inc"]) });
    expect(index.sessionChunks(ws5, "inc")).toHaveLength(1);
    index.syncSessions(ws5, [source]);
    expect(index.sessionChunks(ws5, "inc")).toHaveLength(2);
    index.close();
  });
});

describe("memory tools", () => {
  const index = new MemoryIndexService(fakeEmbedder("fake-v2"));
  const deps = { index, sync: async () => index.syncKnowledge(ws) };
  const [search, session] = buildMemoryTools(ws, deps);

  afterAll(() => index.close());

  test("memory_search returns cited results", async () => {
    const res: any = await (search as any).handler(
      { query: "stripe payment terms" },
      {},
    );
    const out = res.content[0].text as string;
    expect(out).toContain("knowledge/clients/acme.md");
    expect(out).toContain("2026-03-05");
    expect(out).toContain("Payment terms");
  });

  test("memory_search says so explicitly when nothing matches", async () => {
    const res: any = await (search as any).handler(
      { query: "zeppelin maintenance" },
      {},
    );
    expect(res.content[0].text).toContain("No memory matches");
    expect(res.content[0].text).toContain("say so plainly");
  });

  test("memory_session returns bookends and match context", async () => {
    const res: any = await (session as any).handler(
      { session_id: "s1", query: "candidate" },
      {},
    );
    const out = res.content[0].text as string;
    expect(out).toContain('Conversation "Hiring decision"');
    expect(out).toContain("opening");
    expect(out).toContain("recruiter");
  });

  test("memory_session errors on unknown session", async () => {
    const res: any = await (session as any).handler({ session_id: "nope" }, {});
    expect(res.isError).toBe(true);
  });
});

describe("formatResults", () => {
  test("session hits cite the conversation title and id", () => {
    const out = formatResults(
      [
        {
          sourceType: "session",
          sourcePath: "abc-123",
          heading: "Pricing chat",
          date: "2026-02-02",
          body: "User: what price?\nAssistant: €99.",
          score: 1,
          confidence: "strong",
        },
      ],
      "price",
    );
    expect(out).toContain('past conversation "Pricing chat"');
    expect(out).toContain("abc-123");
    expect(out).toContain("2026-02-02");
    expect(out).not.toContain("verify before citing"); // no per-hit weak marker
  });

  test("all-weak results read as 'no reliable record', hits kept as leads", () => {
    const out = formatResults(
      [
        {
          sourceType: "knowledge",
          sourcePath: "brand/logo.md",
          heading: "Logo",
          date: "2026-07-16",
          body: "The primary brand mark.",
          score: 0.01,
          confidence: "weak",
        },
      ],
      "authentication decisions",
    );
    expect(out).toContain("No strong match");
    expect(out).toContain("WEAK match — verify before citing");
    expect(out).toContain("brand/logo.md");
  });
});
