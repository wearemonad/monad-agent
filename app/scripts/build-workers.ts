/** postBuild hook, part 1: build the backend's Bun Workers next to the
 *  bundled index.js.
 *
 *  Electrobun bundles one bun entrypoint (src/bun/index.ts), and Bun.build
 *  does not follow `new Worker(url)` — so a worker file would simply be
 *  missing from the app. Each worker is built here as its own bundle, with
 *  the same externals as the main process (the ONNX packages resolve from
 *  the node_modules bundle-onnx.ts places beside it). MemoryIndex.ts looks
 *  for `memoryIndex.worker.js` next to index.js first.
 *
 *  Runs from projectRoot with ELECTROBUN_BUILD_DIR set (see runHook).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import config from "../electrobun.config";

const WORKERS = ["src/bun/workers/memoryIndex.worker.ts"];

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir || !fs.existsSync(buildDir)) {
  console.log("[build-workers] no ELECTROBUN_BUILD_DIR — nothing to do");
} else {
  const bunDirs = findBunOutputDirs(buildDir);
  if (bunDirs.length === 0) {
    throw new Error(
      "[build-workers] no built bun output (bun/index.js) found — the app would ship without its workers",
    );
  }
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-workers-"));
  try {
    const result = await Bun.build({
      entrypoints: WORKERS,
      outdir,
      target: "bun",
      external: config.build?.bun?.external ?? [],
      define: config.build?.bun?.define ?? {},
    });
    if (!result.success) {
      throw new Error(
        `[build-workers] build failed:\n${result.logs.map(String).join("\n")}`,
      );
    }
    for (const bunDir of bunDirs) {
      for (const output of result.outputs) {
        const name = path.basename(output.path);
        fs.copyFileSync(output.path, path.join(bunDir, name));
        console.log(
          `[build-workers] ${name} → ${path.relative(buildDir, bunDir)}`,
        );
      }
    }
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

/** The built bun output dir(s): any directory named "bun" containing the
 *  compiled entrypoint (same search as bundle-onnx.ts). */
function findBunOutputDirs(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "bun" && fs.existsSync(path.join(full, "index.js"))) {
      found.push(full);
    } else if (entry.name !== "node_modules") {
      findBunOutputDirs(full, found);
    }
  }
  return found;
}
