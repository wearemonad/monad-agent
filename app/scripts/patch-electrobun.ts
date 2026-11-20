/** Patch Electrobun's webview preload, right after `electrobun sync`
 *  (postinstall, release.sh). internal/PARALLEL-THREADS-PR2-UNBLOCK-BUN.html,
 *  2e — neither fix is in 2.0.2, 2.0.6 or 2.0.7-beta.24.
 *
 *  1. encryption.ts: every RPC message is AES-GCM'd as base64. Decoding used
 *     binary.split("").map(…) — an array entry per byte — everywhere but
 *     Linux, and encoding appended one character per byte. Both are now
 *     typed-array / chunked loops.
 *  2. overlaySync.ts: a 100 ms setTimeout loop called getBoundingClientRect()
 *     for every <electrobun-webview> (our artifact panel), forcing a layout
 *     of the streaming page ten times a second. Moves are now caught by
 *     observers and scroll/resize listeners; the loop keeps its burst mode
 *     after a change and idles at 1 s as a safety net.
 *
 *  The devkit is written by `electrobun sync`, outside node_modules, so
 *  `bun patch` can't reach it. This checks the devkit version and each
 *  file's SHA-256 against the originals and fails LOUDLY on a mismatch — an
 *  Electrobun upgrade must make us revisit these edits — then applies them
 *  and regenerates preload/.generated/compiled.ts with the devkit's own
 *  preload/build.ts (that file is what the app bundles). Idempotent: files
 *  already patched are left alone.
 *
 *  Usage: bun scripts/patch-electrobun.ts   (from app/) */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEVKIT = path.join(import.meta.dir, "..", ".hutch", "devkit");
const PRELOAD = path.join(DEVKIT, "api", "preload");
// encryption.ts and overlaySync.ts are byte-identical in 2.0.2 and 2.0.6, so
// the SHA-256s below hold for both.
const EXPECTED_VERSION = "2.0.6";

type FilePatch = {
  file: string;
  originalSha256: string;
  edits: { old: string; new: string }[];
};

const PATCHES: FilePatch[] = [
  {
    file: "encryption.ts",
    originalSha256:
      "0f180ed152cb0a7999307cbd571b79f15f39765b8f16dcb51d2cc3ab6772c5bc",
    edits: [
      {
        old: `	const binary = atob(base64);
	if (window.__electrobunPlatform === "linux") {
		// WebKitGTK becomes allocation-bound on large RPC bursts if every byte
		// is first expanded into a split/map array.
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	return new Uint8Array(binary.split("").map((char) => char.charCodeAt(0)));`,
        new: `	const binary = atob(base64);
	// Every platform: expanding each byte into a split/map array makes large
	// RPC bursts allocation-bound (first seen on WebKitGTK, same on WKWebView).
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;`,
      },
      {
        old: `	let binary = "";
	for (let i = 0; i < uint8Array.length; i++) {
		binary += String.fromCharCode(uint8Array[i]!);
	}
	return btoa(binary);`,
        new: `	// One string append per 32 KB block instead of one per byte.
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < uint8Array.length; i += CHUNK) {
		binary += String.fromCharCode.apply(
			null,
			uint8Array.subarray(i, i + CHUNK) as unknown as number[],
		);
	}
	return btoa(binary);`,
      },
    ],
  },
  {
    file: "overlaySync.ts",
    originalSha256:
      "fbea102772b960e1e1d8acd080b78f8e2d7de0cca070db84c4569b4ee4d21d11",
    edits: [
      {
        old: `	private resizeObserver: ResizeObserver | null = null;
	private positionLoop: ReturnType<typeof setTimeout> | null = null;
	private resizeHandler: (() => void) | null = null;
	private burstUntil = 0;`,
        new: `	private resizeObserver: ResizeObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private positionLoop: ReturnType<typeof setTimeout> | null = null;
	private resizeHandler: (() => void) | null = null;
	private scrollHandler: (() => void) | null = null;
	private burstUntil = 0;`,
      },
      {
        old: `			baseIntervalMs: options.baseIntervalMs ?? 100,`,
        // Idle safety net only: observers and listeners catch real moves.
        new: `			baseIntervalMs: options.baseIntervalMs ?? 1000,`,
      },
      {
        old: `		const loop = () => {
			this.sync();
			const now = performance.now();
			const interval =
				now < this.burstUntil
					? this.options.burstIntervalMs
					: this.options.baseIntervalMs;
			this.positionLoop = setTimeout(loop, interval);
		};
		this.positionLoop = setTimeout(loop, this.options.baseIntervalMs);

		this.resizeHandler = () => this.sync(true);
		window.addEventListener("resize", this.resizeHandler);
	}`,
        new: `		// Visibility/position changes against the viewport (layout shifts that
		// move the element across a threshold).
		this.intersectionObserver = new IntersectionObserver(() => this.sync(), {
			threshold: [0, 0.25, 0.5, 0.75, 1],
		});
		this.intersectionObserver.observe(this.element);

		// Any ancestor scrolling moves the element: capture phase sees them all.
		this.scrollHandler = () => {
			this.sync();
			this.burst();
		};
		window.addEventListener("scroll", this.scrollHandler, {
			capture: true,
			passive: true,
		});

		// Polling is the safety net for moves no observer sees: fast for a
		// short burst after a change, otherwise once a second. (It used to
		// poll every 100 ms, forcing a layout of the page each time.)
		this.schedule(this.options.baseIntervalMs);

		this.resizeHandler = () => {
			this.sync(true);
			this.burst();
		};
		window.addEventListener("resize", this.resizeHandler);
	}

	private loop = () => {
		this.positionLoop = null;
		this.sync();
		this.schedule(
			performance.now() < this.burstUntil
				? this.options.burstIntervalMs
				: this.options.baseIntervalMs,
		);
	};

	private schedule(ms: number) {
		if (this.positionLoop) clearTimeout(this.positionLoop);
		this.positionLoop = setTimeout(this.loop, ms);
	}

	/** Poll at burst cadence for a while: right after a move or an
	 *  interaction, follow-up moves come fast. */
	private burst() {
		const wasIdle = performance.now() >= this.burstUntil;
		this.burstUntil = performance.now() + this.options.burstDurationMs;
		if (wasIdle && this.resizeObserver) {
			this.schedule(this.options.burstIntervalMs);
		}
	}`,
      },
      {
        old: `		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (this.positionLoop) clearTimeout(this.positionLoop);
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
		}
		this.resizeObserver = null;
		this.positionLoop = null;
		this.resizeHandler = null;`,
        new: `		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (this.intersectionObserver) this.intersectionObserver.disconnect();
		if (this.positionLoop) clearTimeout(this.positionLoop);
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
		}
		if (this.scrollHandler) {
			window.removeEventListener("scroll", this.scrollHandler, {
				capture: true,
			});
		}
		this.resizeObserver = null;
		this.intersectionObserver = null;
		this.positionLoop = null;
		this.resizeHandler = null;
		this.scrollHandler = null;`,
      },
      {
        old: `		this.burstUntil = performance.now() + this.options.burstDurationMs;
		this.lastRect = newRect;`,
        new: `		this.burst();
		this.lastRect = newRect;`,
      },
    ],
  },
];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fail(message: string): never {
  console.error(`\n[patch-electrobun] ${message}\n`);
  process.exit(1);
}

/** The original's text with every edit applied; throws if an edit's anchor
 *  isn't there exactly once. */
export function applyEdits(original: string, patch: FilePatch): string {
  let text = original;
  for (const edit of patch.edits) {
    const count = text.split(edit.old).length - 1;
    if (count !== 1)
      throw new Error(
        `${patch.file}: expected 1 match for an edit, found ${count}`,
      );
    text = text.replace(edit.old, () => edit.new);
  }
  return text;
}

if (import.meta.main) {
  const pkgPath = path.join(DEVKIT, "package.json");
  if (!fs.existsSync(pkgPath))
    fail(
      `no Electrobun devkit at ${DEVKIT} — run \`bunx electrobun sync\` first.`,
    );
  const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  if (version !== EXPECTED_VERSION)
    fail(
      `Electrobun devkit is ${version}, these patches are for ${EXPECTED_VERSION}. ` +
        "Check whether upstream fixed the preload (encryption.ts, overlaySync.ts), " +
        "then update or drop scripts/patch-electrobun.ts.",
    );

  let changed = 0;
  for (const patch of PATCHES) {
    const file = path.join(PRELOAD, patch.file);
    const current = fs.readFileSync(file, "utf8");
    const currentSha = sha256(current);
    if (currentSha === patch.originalSha256) {
      fs.writeFileSync(file, applyEdits(current, patch));
      changed++;
      continue;
    }
    // Already patched by an earlier run? Then it matches what we'd write.
    const marker = patch.edits[0].new;
    if (current.includes(marker)) continue;
    fail(
      `${patch.file} doesn't match the Electrobun ${EXPECTED_VERSION} original ` +
        `(sha256 ${currentSha}). Revisit scripts/patch-electrobun.ts.`,
    );
  }

  const compiled = path.join(PRELOAD, ".generated", "compiled.ts");
  // Rebuild when sources changed, or when an earlier run patched them but
  // the rebuild didn't happen (identifiers survive the unminified bundle).
  if (
    changed > 0 ||
    !fs.readFileSync(compiled, "utf8").includes("intersectionObserver")
  ) {
    const build = Bun.spawnSync(["bun", path.join(PRELOAD, "build.ts")], {
      cwd: DEVKIT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (build.exitCode !== 0) fail("rebuilding the preload failed.");
  }
  console.log(
    changed
      ? `[patch-electrobun] patched ${changed} preload file(s) and rebuilt compiled.ts`
      : "[patch-electrobun] preload already patched",
  );
}
