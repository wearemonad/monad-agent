import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  artifactPathFor,
  buildArtifactTools,
  readArtifact,
} from "./artifactTools";

let ws: string;
let tools: ReturnType<typeof buildArtifactTools>;

const call = async (name: string, args: Record<string, unknown>) => {
  const t = tools.find((t) => t.name === name)!;
  return (await t.handler(args as any, {})) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
};

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-artifacts-"));
  tools = buildArtifactTools(ws);
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("artifact_create", () => {
  test("writes the file and meta, returns a success message", async () => {
    const res = await call("artifact_create", {
      id: "q3-dash",
      type: "html",
      title: "Q3 Dashboard",
      content: "<p>hello</p>",
    });
    expect(res.isError).toBeFalsy();
    expect(
      fs.readFileSync(path.join(ws, "artifacts/q3-dash.html"), "utf8"),
    ).toBe("<p>hello</p>");
    expect(readArtifact(ws, "q3-dash")).toEqual({
      type: "html",
      title: "Q3 Dashboard",
      content: "<p>hello</p>",
    });
  });

  test("strips a whole-content markdown fence", async () => {
    await call("artifact_create", {
      id: "fenced",
      type: "html",
      title: "F",
      content: "```html\n<p>x</p>\n```",
    });
    expect(readArtifact(ws, "fenced")?.content).toBe("<p>x</p>");
  });

  test("rejects path-unsafe ids", async () => {
    const res = await call("artifact_create", {
      id: "../evil",
      type: "html",
      title: "E",
      content: "<p>x</p>",
    });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(ws, "evil.html"))).toBe(false);
  });

  test("rejects duplicate ids with guidance", async () => {
    await call("artifact_create", {
      id: "dup",
      type: "html",
      title: "A",
      content: "<p>1</p>",
    });
    const res = await call("artifact_create", {
      id: "dup",
      type: "html",
      title: "B",
      content: "<p>2</p>",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("artifact_update");
    expect(readArtifact(ws, "dup")?.content).toBe("<p>1</p>");
  });
});

describe("artifact_update", () => {
  beforeEach(async () => {
    await call("artifact_create", {
      id: "doc",
      type: "markdown",
      title: "Doc",
      content: "alpha beta gamma",
    });
  });

  test("unique old_str updates the file", async () => {
    const res = await call("artifact_update", {
      id: "doc",
      old_str: "beta",
      new_str: "BETA",
    });
    expect(res.isError).toBeFalsy();
    expect(readArtifact(ws, "doc")?.content).toBe("alpha BETA gamma");
  });

  test("missing old_str errors and leaves the file untouched", async () => {
    const res = await call("artifact_update", {
      id: "doc",
      old_str: "nope",
      new_str: "x",
    });
    expect(res.isError).toBe(true);
    expect(readArtifact(ws, "doc")?.content).toBe("alpha beta gamma");
  });

  test("ambiguous old_str errors with the count", async () => {
    await call("artifact_update", {
      id: "doc",
      old_str: "gamma",
      new_str: "alpha",
    });
    const res = await call("artifact_update", {
      id: "doc",
      old_str: "alpha",
      new_str: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("2 times");
  });

  test("unknown id errors with create guidance", async () => {
    const res = await call("artifact_update", {
      id: "ghost",
      old_str: "a",
      new_str: "b",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("artifact_create");
  });
});

describe("artifact_rewrite", () => {
  test("replaces content and optionally the title", async () => {
    await call("artifact_create", {
      id: "r",
      type: "svg",
      title: "Old",
      content: "<svg>1</svg>",
    });
    const res = await call("artifact_rewrite", {
      id: "r",
      title: "New",
      content: "<svg>2</svg>",
    });
    expect(res.isError).toBeFalsy();
    expect(readArtifact(ws, "r")).toEqual({
      type: "svg",
      title: "New",
      content: "<svg>2</svg>",
    });
  });

  test("keeps the extension of the original type", async () => {
    await call("artifact_create", {
      id: "r2",
      type: "mermaid",
      title: "M",
      content: "graph TD; a-->b",
    });
    await call("artifact_rewrite", { id: "r2", content: "graph LR; x-->y" });
    expect(artifactPathFor(ws, "r2")).toBe(path.join(ws, "artifacts/r2.mmd"));
  });
});

describe("artifactPathFor", () => {
  test("resolves only existing, valid ids", async () => {
    await call("artifact_create", {
      id: "p",
      type: "html",
      title: "P",
      content: "<p>x</p>",
    });
    expect(artifactPathFor(ws, "p")).toBe(path.join(ws, "artifacts/p.html"));
    expect(artifactPathFor(ws, "missing")).toBe(null);
    expect(artifactPathFor(ws, "../escape")).toBe(null);
  });
});
