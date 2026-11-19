import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryIndex } from "./MemoryIndex";
import { MemoryIndexService } from "./MemoryIndexService";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-memory-worker-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const workerUrl = new URL("../workers/memoryIndex.worker.ts", import.meta.url)
  .href;

function line(type: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type,
    message: { content: [{ type: "text", text }] },
  });
}

function seedWorkspace(name: string) {
  const ws = path.join(root, name);
  fs.mkdirSync(path.join(ws, "knowledge", "entities"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "knowledge", "clients.md"),
    "# Acme\n\nAcme pays net-30 through Stripe; late fee after 45 days.",
  );
  fs.writeFileSync(
    path.join(ws, "knowledge", "entities", "acme.md"),
    "---\ntype: company\n---\n# Acme\n\nOur biggest client, based in Berlin.",
  );
  const jsonlPath = path.join(ws, "s1.jsonl");
  fs.writeFileSync(
    jsonlPath,
    `${line("user", "Should we hire the recruiter's candidate?")}\n${line("assistant", "Yes — schedule a final round on Friday.")}\n`,
  );
  return {
    ws,
    sessions: [{ sessionId: "s1", title: "Hiring decision", jsonlPath }],
  };
}

describe("MemoryIndex (worker façade)", () => {
  test("answers exactly what the in-process index answers", async () => {
    const { ws, sessions } = seedWorkspace("parity");
    const viaWorker = new MemoryIndex({ embedder: "none" });
    await viaWorker.sync(ws, sessions);
    const local = new MemoryIndexService();
    local.syncKnowledge(ws);
    local.syncSessions(ws, sessions);

    for (const query of ["stripe late fee", "candidate", "Acme"]) {
      const a = await viaWorker.search(ws, query);
      const b = await local.search(ws, query);
      expect(a.map((h) => [h.sourcePath, h.body])).toEqual(
        b.map((h) => [h.sourcePath, h.body]),
      );
      expect(a.length).toBeGreaterThan(0);
    }
    expect(await viaWorker.sessionChunks(ws, "s1")).toEqual(
      local.sessionChunks(ws, "s1"),
    );
    expect((await viaWorker.graph(ws)).entity("Acme")?.name).toBe("Acme");
    const captured = await viaWorker.condenseLastExchange(
      sessions[0].jsonlPath,
      "2026-11-19",
    );
    expect(captured?.body).toContain("User asked: Should we hire");
    local.close();
    await viaWorker.dispose();
  });

  test("a crashed worker is restarted once; a second crash leaves it down", async () => {
    const { ws } = seedWorkspace("crash");
    const spawned: Worker[] = [];
    const index = new MemoryIndex({
      embedder: "none",
      restartDelayMs: 10,
      spawn: () => {
        const w = new Worker(workerUrl);
        spawned.push(w);
        return w;
      },
    });
    await index.sync(ws);
    const errors = console.error;
    console.error = () => {};
    try {
      spawned[0].terminate();
      await Bun.sleep(50);
      expect((await index.search(ws, "stripe")).length).toBeGreaterThan(0);
      expect(spawned).toHaveLength(2);

      spawned[1].terminate();
      await Bun.sleep(50);
      await expect(index.search(ws, "stripe")).rejects.toThrow(/unavailable/);
    } finally {
      console.error = errors;
      await index.dispose();
    }
  });
});
