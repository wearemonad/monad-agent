import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { servableImagePath } from "./chatImages";

// The webview names an image by path; only images in a batch folder of a
// generated-images root may be read back — never an arbitrary file.

let tmp: string;
let codexRoot: string;
let monadRoot: string;

const put = (file: string, body = "png") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "monad-chat-img-")),
  );
  codexRoot = path.join(tmp, "codex", "generated_images");
  monadRoot = path.join(tmp, "monad", "generated_images");
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(monadRoot, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const roots = () => [codexRoot, monadRoot];

describe("servableImagePath", () => {
  test("serves an image Codex generated", () => {
    const file = put(path.join(codexRoot, "thread-1", "ig_1.png"));
    expect(servableImagePath(file, roots())).toBe(file);
  });

  test("serves an image an API-key provider generated into Monad's store", () => {
    const file = put(path.join(monadRoot, "batch-1", "image-1.jpg"));
    expect(servableImagePath(file, roots())).toBe(file);
  });

  test("refuses files outside the generated-images roots", () => {
    const file = put(path.join(tmp, "elsewhere", "secret.png"));
    expect(servableImagePath(file, roots())).toBeNull();
  });

  test("refuses a non-image file inside a root", () => {
    const file = put(path.join(monadRoot, "batch-1", "notes.txt"));
    expect(servableImagePath(file, roots())).toBeNull();
  });

  test("refuses a symlink in a root that points outside it", () => {
    const target = put(path.join(tmp, "elsewhere", "secret.png"));
    const link = path.join(monadRoot, "batch-1", "image-1.png");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    expect(servableImagePath(link, roots())).toBeNull();
  });

  test("refuses a path that climbs out with ..", () => {
    const file = put(path.join(tmp, "elsewhere", "secret.png"));
    const sneaky = path.join(
      monadRoot,
      "batch-1",
      "..",
      "..",
      "..",
      "elsewhere",
      "secret.png",
    );
    expect(servableImagePath(sneaky, roots())).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });

  test("a missing root doesn't stop the others from serving", () => {
    const file = put(path.join(codexRoot, "thread-1", "ig_1.png"));
    fs.rmSync(monadRoot, { recursive: true });
    expect(servableImagePath(file, roots())).toBe(file);
  });
});
