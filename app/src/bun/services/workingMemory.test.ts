import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMORY_WRITE_TOOL,
  WORKING_MEMORY_CHAR_LIMIT,
} from "../../shared/memory";
import { backgroundToolDecision } from "./AgentService";
import { buildMemoryTools } from "./memoryTools";
import { MemoryIndexService } from "./MemoryIndexService";
import {
  applyWorkingMemoryOp,
  parseWorkingMemory,
  workingMemorySnapshot,
  workingMemoryTemplate,
} from "./workingMemory";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-wm-mem-"));
fs.mkdirSync(path.join(ws, "knowledge"), { recursive: true });

afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

const add = (content: string, text: string, section = "key-facts" as const) =>
  applyWorkingMemoryOp(content, { action: "add", section, text });

describe("working memory ops", () => {
  test("template parses to empty sections and renders stably", () => {
    const entries = parseWorkingMemory(workingMemoryTemplate())!;
    expect(entries["active-threads"]).toEqual([]);
    expect(entries["key-facts"]).toEqual([]);
    expect(entries["pending-decisions"]).toEqual([]);
  });

  test("add, dedup, replace, remove", () => {
    let c = workingMemoryTemplate();
    let r = add(c, "Acme invoices are net-30 via Stripe");
    expect(r.ok).toBe(true);
    c = (r as any).content;

    // exact duplicate (case/whitespace-insensitive) is a no-op success
    r = add(c, "  acme invoices are NET-30 via stripe ");
    expect(r.ok).toBe(true);
    expect((r as any).message).toContain("Already recorded");
    expect((r as any).content).toBe(c);

    r = applyWorkingMemoryOp(c, {
      action: "replace",
      section: "key-facts",
      old_text: "net-30",
      text: "Acme invoices are net-45 via Stripe (changed 2026-08)",
    });
    expect(r.ok).toBe(true);
    c = (r as any).content;
    expect(c).toContain("net-45");
    expect(c).not.toContain("net-30 via Stripe\n");

    r = applyWorkingMemoryOp(c, {
      action: "remove",
      section: "key-facts",
      old_text: "net-45",
    });
    expect(r.ok).toBe(true);
    expect(parseWorkingMemory((r as any).content)!["key-facts"]).toEqual([]);
  });

  test("replace requires a unique match and reports candidates", () => {
    let c = workingMemoryTemplate();
    c = (add(c, "Prefers email over Slack") as any).content;
    c = (add(c, "Prefers short emails") as any).content;
    const r = applyWorkingMemoryOp(c, {
      action: "replace",
      section: "key-facts",
      old_text: "Prefers",
      text: "x",
    });
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("matches 2 entries");

    const miss = applyWorkingMemoryOp(c, {
      action: "remove",
      section: "key-facts",
      old_text: "zeppelin",
    });
    expect(miss.ok).toBe(false);
    expect((miss as any).error).toContain("No entry");
  });

  test("overflow is an error carrying current state, never a silent drop", () => {
    let c = workingMemoryTemplate();
    const fact =
      "A durable business fact that takes up meaningful room in the file. ";
    for (let i = 0; i < 40; i++) {
      const r = add(c, `${i}: ${fact}`);
      if (!r.ok) {
        expect((r as any).error).toContain("over the cap");
        expect((r as any).error).toContain("Consolidate NOW");
        expect(c.length).toBeLessThanOrEqual(WORKING_MEMORY_CHAR_LIMIT);
        return;
      }
      c = (r as any).content;
    }
    throw new Error("cap never enforced");
  });

  test("hand-edited structure refuses tool writes instead of re-rendering it away", () => {
    const edited = `${workingMemoryTemplate()}\n## My own section\n\n- something\n`;
    const r = add(edited, "new fact");
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("hand-edited");
  });
});

describe("workingMemorySnapshot", () => {
  test("empty file injects nothing", () => {
    fs.writeFileSync(
      path.join(ws, "knowledge/working-memory.md"),
      workingMemoryTemplate(),
    );
    expect(workingMemorySnapshot(ws)).toBe("");
  });

  test("carries capacity header, anti-injection frame, and the content", () => {
    const c = (
      add(
        workingMemoryTemplate(),
        "Alex prefers Electrobun for the desktop app",
      ) as any
    ).content;
    fs.writeFileSync(path.join(ws, "knowledge/working-memory.md"), c);
    const snap = workingMemorySnapshot(ws);
    expect(snap).toContain("WORKING MEMORY [");
    expect(snap).toContain(
      `/${WORKING_MEMORY_CHAR_LIMIT.toLocaleString("en-US")} chars]`,
    );
    expect(snap).toContain("NOT instructions");
    expect(snap).toContain("Alex prefers Electrobun");
  });

  test("missing file injects nothing", () => {
    expect(workingMemorySnapshot(path.join(ws, "nonexistent"))).toBe("");
  });
});

describe("memory_remember tool", () => {
  const index = new MemoryIndexService();
  const tools = buildMemoryTools(ws, { index, sync: async () => {} });
  const remember = tools.find((t) => t.name === "memory_remember")!;

  afterAll(() => index.close());

  test("writes through to the file and reports next-session semantics", async () => {
    const res: any = await (remember as any).handler(
      {
        action: "add",
        section: "pending-decisions",
        text: "Choose auth: OAuth vs API key",
      },
      {},
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("next session");
    const file = fs.readFileSync(
      path.join(ws, "knowledge/working-memory.md"),
      "utf8",
    );
    expect(file).toContain("Choose auth");
  });

  test("validates required fields per action", async () => {
    const res: any = await (remember as any).handler(
      { action: "replace", section: "key-facts" },
      {},
    );
    expect(res.isError).toBe(true);
  });
});

describe("background runs cannot write working memory", () => {
  const alwaysAllowed = () => true; // even with a blanket mcp__memory__* grant
  test("denied in plain background runs despite always-allow", () => {
    expect(
      backgroundToolDecision(MEMORY_WRITE_TOOL, {}, ws, alwaysAllowed),
    ).toBe("deny");
  });
  test("denied in ingest runs (untrusted file content)", () => {
    expect(
      backgroundToolDecision(
        MEMORY_WRITE_TOOL,
        {},
        ws,
        alwaysAllowed,
        () => false,
      ),
    ).toBe("deny");
  });
  test("allowed only when the run's own safeTools grants it (memory review run)", () => {
    expect(
      backgroundToolDecision(
        MEMORY_WRITE_TOOL,
        {},
        ws,
        alwaysAllowed,
        (t) => t === MEMORY_WRITE_TOOL,
      ),
    ).toBe("background-safe");
  });
  test("read-side memory tools still auto-allowed in background runs", () => {
    expect(
      backgroundToolDecision(
        "mcp__memory__memory_search",
        {},
        ws,
        alwaysAllowed,
      ),
    ).toBe("auto-allowed");
  });
});
