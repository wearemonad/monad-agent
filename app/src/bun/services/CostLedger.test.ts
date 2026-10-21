import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CostLedger } from "./CostLedger";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-costs-test-"));
const ledger = new CostLedger();

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("CostLedger", () => {
  test("aggregates this month, last month, and all time", () => {
    const now = new Date("2026-07-11T10:00:00Z");
    const file = path.join(dir, ".monad", "costs.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ts: "2026-07-02T08:00:00Z", costUsd: 0.5, turns: 4 }),
        JSON.stringify({ ts: "2026-07-10T08:00:00Z", costUsd: 0.25, turns: 2 }),
        JSON.stringify({ ts: "2026-06-20T08:00:00Z", costUsd: 1.0, turns: 9 }),
        JSON.stringify({ ts: "2026-01-01T08:00:00Z", costUsd: 2.0, turns: 3 }),
        "not json — ignored",
      ].join("\n"),
    );
    const s = ledger.summary(dir, now);
    expect(s.thisMonthUsd).toBeCloseTo(0.75);
    expect(s.runsThisMonth).toBe(2);
    expect(s.lastMonthUsd).toBeCloseTo(1.0);
    expect(s.allTimeUsd).toBeCloseTo(3.75);
  });

  test("append writes an entry; zero/absent cost is skipped", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-costs2-"));
    ledger.append(ws, 0, 5); // subscription runs report no cost
    ledger.append(ws, 0.123, 5);
    const lines = fs
      .readFileSync(path.join(ws, ".monad", "costs.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).costUsd).toBeCloseTo(0.123);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test("no ledger file → zeroed summary", () => {
    const s = ledger.summary("/nonexistent");
    expect(s.allTimeUsd).toBe(0);
    expect(s.runsThisMonth).toBe(0);
  });
});
