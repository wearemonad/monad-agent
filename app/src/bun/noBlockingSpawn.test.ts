import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/** bun's main thread serves every RPC and every Thread's stream, so nothing
 *  under app/src/bun may wait on a child process synchronously
 *  (internal/PARALLEL-THREADS-PR2-UNBLOCK-BUN.html, 2c). Biome's
 *  noRestrictedImports catches `import { spawnSync } from "node:child_process"`;
 *  this catches what lint can't see: member calls like `Bun.spawnSync(…)` or
 *  `cp.execSync(…)` through a namespace import. Use services/spawnAsync.ts. */

/** Files allowed to block: CLI/dev tooling that never runs inside the app.
 *  Paths relative to app/src/bun. */
const ALLOWLIST = new Set<string>([]);

const BLOCKING_CALL = /\.(spawnSync|execSync|execFileSync)\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      out.push(full);
  }
  return out;
}

test("no synchronous process spawns in the bun backend", () => {
  const root = import.meta.dir;
  const offenders: string[] = [];
  for (const file of sourceFiles(root)) {
    const rel = path.relative(root, file);
    if (ALLOWLIST.has(rel)) continue;
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.trimStart().startsWith("//")) return;
        if (BLOCKING_CALL.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
  }
  expect(offenders).toEqual([]);
});

test("the guard catches a blocking member call", () => {
  expect(BLOCKING_CALL.test('Bun.spawnSync(["sw_vers"])')).toBe(true);
  expect(BLOCKING_CALL.test("cp.execFileSync('zip', [])")).toBe(true);
  expect(BLOCKING_CALL.test("await run(['zip'])")).toBe(false);
});
