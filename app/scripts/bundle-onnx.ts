/** postBuild hook: make the in-process embedder work in PACKAGED apps.
 *
 *  OnnxEmbedder's packages are marked external in electrobun.config.ts —
 *  Bun.build can't inline onnxruntime's native binaries — so at runtime they
 *  resolve from a node_modules next to the built bun code. Dev runs find the
 *  project's own node_modules by walking up; packaged apps don't, so this
 *  copies the packages (plus their transitive runtime deps) into the bundle,
 *  pruned to the target platform: onnxruntime ships every platform's binaries
 *  (~211 MB — darwin is 35 MB) and shipping all of them would triple the app.
 *
 *  Runs from projectRoot with ELECTROBUN_BUILD_DIR/OS/ARCH set (see runHook).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT_PACKAGES = [
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
];

/** onnxruntime-web is browser-only — the node dist references it in strings
 *  but never imports it. (sharp, by contrast, IS a static top-level import of
 *  transformers.node.mjs and must ship even though we never process images —
 *  its installed optional deps are the current platform's binaries only, so
 *  the copy stays ~16 MB.) */
const EXCLUDE = new Set(["onnxruntime-web"]);

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const targetOs = process.env.ELECTROBUN_OS ?? "macos"; // macos | linux | win
if (!buildDir || !fs.existsSync(buildDir)) {
  console.log("[bundle-onnx] no ELECTROBUN_BUILD_DIR — nothing to do");
  process.exit(0);
}

/** The built bun output dir(s): any directory named "bun" containing the
 *  compiled entrypoint. (Path layout differs per platform bundle.) */
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

/** Package names → their on-disk dirs, following dependencies recursively.
 *  Resolves from the project's node_modules (hoisted install). */
function collectRuntimeDeps(roots: string[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop()!;
    if (resolved.has(name) || EXCLUDE.has(name)) continue;
    const dir = path.join("node_modules", name);
    if (!fs.existsSync(dir)) {
      console.warn(`[bundle-onnx] missing package: ${name} (skipped)`);
      continue;
    }
    resolved.set(name, dir);
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      queue.push(...Object.keys(pkg.dependencies ?? {}));
      // Optional deps that happen to be installed (platform binaries like
      // @img/*) ride along; missing ones are skipped by the check above.
      queue.push(...Object.keys(pkg.optionalDependencies ?? {}));
    } catch {
      // unreadable package.json — copy the dir as-is
    }
  }
  return resolved;
}

/** Depth-first walk of the copied tree. cpSync dereferences symlinks, so
 *  everything here is a real file or directory. */
function walk(
  dir: string,
  visit: (full: string, isDir: boolean) => void,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    visit(full, isDir);
    if (isDir) walk(full, visit);
  }
}

/** Drop other platforms' onnxruntime binaries from the copied tree.
 *
 *  Walks the WHOLE tree rather than one package: @huggingface/transformers
 *  carries its own nested onnxruntime-node (pinned to a different version than
 *  the hoisted one), and pruning only the top-level copy left win32 + linux
 *  binaries inside the macOS app. */
function pruneOnnxBinaries(root: string): void {
  const keep =
    { macos: "darwin", linux: "linux", win: "win32" }[targetOs] ?? "darwin";
  const binRoots: string[] = [];
  walk(root, (full, isDir) => {
    if (isDir && path.basename(full) === "napi-v6") binRoots.push(full);
  });
  for (const binRoot of binRoots) {
    for (const platform of fs.readdirSync(binRoot)) {
      if (platform !== keep) {
        fs.rmSync(path.join(binRoot, platform), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

/** Sign the copied .dylibs with the Developer ID.
 *
 *  Notarization rejects any Mach-O without a Developer ID signature, hardened
 *  runtime and a secure timestamp — and onnxruntime/sharp ship their .dylibs
 *  ad-hoc (linker-signed, no team). Electrobun signs `*.node` under
 *  Resources/app/bun but not the .dylibs beside them (see its cli/index.ts,
 *  "Sign native modules in Resources/app/bun"), so that gap is ours to close.
 *
 *  Safe to do here: postBuild runs before electrobun's codesign step, so the
 *  app bundle's outer signature seals these afterwards. Local
 *  `codesign --verify --deep --strict` passes either way — an ad-hoc signature
 *  is still a valid one — so the only way to catch a regression here is the
 *  notary log. */
function signNativeLibraries(root: string): void {
  const identity = process.env.ELECTROBUN_DEVELOPER_ID;
  if (targetOs !== "macos" || process.platform !== "darwin" || !identity)
    return;

  const libs: string[] = [];
  walk(root, (full, isDir) => {
    if (!isDir && full.endsWith(".dylib")) libs.push(full);
  });

  for (const lib of libs) {
    try {
      execFileSync(
        "codesign",
        [
          "--force",
          "--timestamp",
          "--options",
          "runtime",
          "--sign",
          identity,
          lib,
        ],
        { stdio: "pipe" },
      );
    } catch (err) {
      // Fail the build: an unsigned dylib only surfaces as an "Invalid"
      // notarization 10+ minutes later, which is a miserable way to find out.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[bundle-onnx] codesign failed for ${path.relative(root, lib)}: ${detail}`,
      );
    }
  }
  console.log(
    `[bundle-onnx] signed ${libs.length} dylib(s) with Developer ID (hardened runtime + timestamp)`,
  );
}

const bunDirs = findBunOutputDirs(buildDir);
if (bunDirs.length === 0) {
  console.log("[bundle-onnx] no built bun output found — nothing to do");
  process.exit(0);
}

const deps = collectRuntimeDeps(ROOT_PACKAGES);
for (const bunDir of bunDirs) {
  let bytes = 0;
  for (const [name, srcDir] of deps) {
    const dest = path.join(bunDir, "node_modules", name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(srcDir, dest, { recursive: true, dereference: true });
  }
  const modulesDir = path.join(bunDir, "node_modules");
  // Prune first, then sign — no point signing binaries we're about to delete.
  pruneOnnxBinaries(modulesDir);
  signNativeLibraries(modulesDir);
  // Report what we shipped so bundle-size regressions are visible in build logs.
  const du = (dir: string): number =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
      const full = path.join(dir, e.name);
      return sum + (e.isDirectory() ? du(full) : fs.statSync(full).size);
    }, 0);
  bytes = du(path.join(bunDir, "node_modules"));
  console.log(
    `[bundle-onnx] ${deps.size} package(s) → ${path.relative(buildDir, bunDir)}/node_modules (${(bytes / 1024 / 1024).toFixed(0)} MB after pruning)`,
  );
}
