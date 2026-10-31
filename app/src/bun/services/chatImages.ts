import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Image types the chat shows inline, by extension → MIME type (the data
 *  URL needs it). Every other file attaches with a file icon. */
export const CHAT_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Where Monad keeps images its API-key image providers made, one folder
 *  per request — the counterpart of Codex's own generated_images. */
export function monadImagesDir(): string {
  return path.join(
    os.homedir(),
    "Library/Application Support/Monad/generated_images",
  );
}

/** The real path of a generated image the webview asked for, or null. The
 *  path comes from the webview, so it must resolve (symlinks included) to an
 *  image directly inside a batch folder of one of `roots` — never an
 *  arbitrary file read. */
export function servableImagePath(
  file: string,
  roots: string[],
): string | null {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return null;
  }
  if (!CHAT_IMAGE_TYPES[path.extname(real).slice(1).toLowerCase()]) return null;
  const parent = path.dirname(path.dirname(real));
  for (const root of roots) {
    try {
      if (fs.realpathSync(root) === parent) return real;
    } catch {
      // a root that doesn't exist yet serves nothing
    }
  }
  return null;
}
