import { existsSync, readFileSync } from "node:fs";
import type { ElectrobunConfig } from "electrobun";

// Electrobun 2 doesn't load app/.env (release.sh exports it for releases), so
// dev builds read the built-in Google client from it here — without it, a dev
// app couldn't refresh tokens of workspaces connected with that client.
const dotenv = existsSync(".env") ? readFileSync(".env", "utf8") : "";
function env(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const line = dotenv.match(new RegExp(`^\\s*${key}\\s*=(.*)$`, "m"));
  const value = line?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  return value || undefined;
}

export default {
  app: {
    name: "Monad",
    identifier: "com.monad.app",
    version: "0.6.4",
  },
  build: {
    // Electrobun 2 defaults the main process to Cottontail. Monad's backend
    // depends on Bun (bun:sqlite, bun:ffi in nativeWindow.ts, onnxruntime's
    // native addon), so pin it — the directory name doesn't select the runtime.
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
      // The in-process embedder (OnnxEmbedder) rides on native ONNX binaries
      // that Bun.build cannot inline. These packages resolve from
      // node_modules at runtime instead: the project's in dev, the pruned
      // copy scripts/bundle-onnx.ts places next to the built bun code in
      // packaged apps (scripts.postBuild below).
      external: [
        "@huggingface/transformers",
        "@huggingface/jinja",
        "@huggingface/tokenizers",
        "onnxruntime-node",
        "onnxruntime-common",
        "sharp",
      ],
      // Official releases bake the built-in Google OAuth client in from
      // app/.env (release.sh exports it). Source builds without these fall
      // back to the client entered in Settings → Google.
      define: Object.fromEntries(
        ["MONAD_GOOGLE_CLIENT_ID", "MONAD_GOOGLE_CLIENT_SECRET"]
          .filter((key) => env(key))
          .map((key) => [`process.env.${key}`, JSON.stringify(env(key))]),
      ),
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      // App icon: icon.iconset/ is converted to AppIcon.icns via iconutil at build time.
      // The iconset is generated from icon-master-1024.png by scripts/generate-iconset.ts
      // (run via `bun run icons`; build:canary runs it automatically), which bakes in
      // Apple's rounded-rect icon shape — required for macOS 15 and earlier, which
      // render the icns as-is (only macOS 26 Tahoe masks icons itself).
      // If the mark changes, re-export the full-bleed master from the Figma
      // "Monad Agent — App Icon" frame and rebuild.
      icons: "icon.iconset",
      // Signing switches on automatically when credentials exist (see .env.example).
      codesign: !!process.env.ELECTROBUN_DEVELOPER_ID,
      notarize:
        !!process.env.ELECTROBUN_DEVELOPER_ID &&
        !!process.env.ELECTROBUN_APPLEID &&
        !!process.env.ELECTROBUN_APPLEIDPASS &&
        !!process.env.ELECTROBUN_TEAMID,
    },
  },
  scripts: {
    // Copies the embedder's external packages (marked external in build.bun
    // above) into the packaged app's bun/node_modules, pruned to the target
    // platform's native binaries. Dev builds resolve from the project's
    // node_modules and don't need this, but the hook is harmless there.
    postBuild: "scripts/bundle-onnx.ts",
  },
  release: {
    // Where packaged apps poll for updates + the diff base for patch generation.
    // Set MONAD_UPDATE_BASE_URL in app/.env once the R2 bucket exists — see
    // docs/releasing.md. Electrobun 2 does NOT load app/.env itself; release.sh
    // exports it before building and refuses to publish a build without it.
    // IMPORTANT: baseUrl must live under `release`, not `build` — electrobun reads
    // release.baseUrl, and a misplaced baseUrl is silently ignored ("No baseUrl
    // configured, skipping patch generation").
    ...(process.env.MONAD_UPDATE_BASE_URL
      ? { baseUrl: process.env.MONAD_UPDATE_BASE_URL }
      : {}),
  },
} satisfies ElectrobunConfig;
