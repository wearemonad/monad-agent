import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ChatImageServer, startChatImageServer } from "./chatImageServer";
import { servableImagePath } from "./chatImages";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let root: string;
let image: string;
let secret: string;
let server: ChatImageServer;

beforeAll(() => {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "monad-img-srv-")),
  );
  root = path.join(tmp, "generated_images");
  fs.mkdirSync(path.join(root, "batch"), { recursive: true });
  image = path.join(root, "batch", "a.png");
  fs.writeFileSync(image, PNG);
  secret = path.join(tmp, "secret.txt");
  fs.writeFileSync(secret, "nope");
  server = startChatImageServer((f) => servableImagePath(f, [root]));
});
afterAll(() => {
  server.stop();
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("chat image server", () => {
  test("streams a generated image with its type and long caching", async () => {
    const res = await fetch(server.urlFor(image));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  test("refuses files outside the image folders", async () => {
    const res = await fetch(server.urlFor(secret));
    expect(res.status).toBe(404);
  });

  test("refuses a request without the launch token", async () => {
    const url = new URL(server.urlFor(image));
    url.pathname = "/chat-image/wrong";
    expect((await fetch(url)).status).toBe(404);
  });

  test("refuses a foreign Host header (DNS rebinding)", async () => {
    const res = await fetch(server.urlFor(image), {
      headers: { host: "evil.example:80" },
    });
    expect(res.status).toBe(403);
  });
});
