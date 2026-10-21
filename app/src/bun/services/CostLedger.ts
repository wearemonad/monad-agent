import * as fs from "node:fs";
import * as path from "node:path";
import type { CostSummary } from "../../shared/ipc";

type CostEntry = { ts: string; costUsd: number; turns: number };

/** Per-run API cost, persisted per workspace as JSONL and aggregated by month.
 *  The per-run number was already flowing through the app and being discarded —
 *  this makes API-key mode answerable: "what does this cost to run?" */
export class CostLedger {
  append(workspacePath: string, costUsd: number, turns: number): void {
    if (!(costUsd > 0)) return; // subscription-CLI runs report no cost
    try {
      const dir = path.join(workspacePath, ".monad");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "costs.jsonl"),
        `${JSON.stringify({ ts: new Date().toISOString(), costUsd, turns })}\n`,
      );
    } catch {
      // never sink a run over bookkeeping
    }
  }

  summary(workspacePath: string, now = new Date()): CostSummary {
    const out: CostSummary = {
      thisMonthUsd: 0,
      lastMonthUsd: 0,
      allTimeUsd: 0,
      runsThisMonth: 0,
    };
    let raw = "";
    try {
      raw = fs.readFileSync(
        path.join(workspacePath, ".monad", "costs.jsonl"),
        "utf8",
      );
    } catch {
      return out;
    }
    const thisMonth = now.toISOString().slice(0, 7);
    const lastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    )
      .toISOString()
      .slice(0, 7);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: CostEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!(entry.costUsd > 0)) continue;
      out.allTimeUsd += entry.costUsd;
      const month = entry.ts?.slice(0, 7);
      if (month === thisMonth) {
        out.thisMonthUsd += entry.costUsd;
        out.runsThisMonth += 1;
      } else if (month === lastMonth) {
        out.lastMonthUsd += entry.costUsd;
      }
    }
    return out;
  }
}
