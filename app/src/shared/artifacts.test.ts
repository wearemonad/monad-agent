import { describe, expect, test } from "bun:test";
import {
  applyArtifactUpdate,
  artifactExt,
  artifactOpFromToolName,
  isValidArtifactId,
  stripOuterFence,
} from "./artifacts";

describe("artifact ids", () => {
  test("kebab-case ids pass, path-unsafe ids fail", () => {
    expect(isValidArtifactId("q3-pipeline-dashboard")).toBe(true);
    expect(isValidArtifactId("a")).toBe(true);
    expect(isValidArtifactId("Q3")).toBe(false);
    expect(isValidArtifactId("has space")).toBe(false);
    expect(isValidArtifactId("../escape")).toBe(false);
    expect(isValidArtifactId("dot.dot")).toBe(false);
    expect(isValidArtifactId("-leading")).toBe(false);
    expect(isValidArtifactId("trailing-")).toBe(false);
    expect(isValidArtifactId("")).toBe(false);
    expect(isValidArtifactId("x".repeat(65))).toBe(false);
  });
});

describe("applyArtifactUpdate", () => {
  test("unique match replaces", () => {
    const r = applyArtifactUpdate("a b c", "b", "B");
    expect(r).toEqual({ ok: true, content: "a B c" });
  });

  test("no match errors with a rewrite hint", () => {
    const r = applyArtifactUpdate("a b c", "z", "Z");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("artifact_rewrite");
  });

  test("ambiguous match errors with the count", () => {
    const r = applyArtifactUpdate("x y x y x", "x", "X");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("3 times");
  });

  test("empty old_str is rejected", () => {
    expect(applyArtifactUpdate("abc", "", "x").ok).toBe(false);
  });
});

describe("stripOuterFence", () => {
  test("strips a single whole-content fence", () => {
    expect(stripOuterFence("```html\n<p>hi</p>\n```")).toBe("<p>hi</p>");
    expect(stripOuterFence("```\nplain\n```")).toBe("plain");
  });

  test("leaves unfenced and partially fenced content alone", () => {
    expect(stripOuterFence("<p>hi</p>")).toBe("<p>hi</p>");
    const mixed = "intro\n```js\ncode\n```";
    expect(stripOuterFence(mixed)).toBe(mixed);
  });
});

describe("tool name mapping", () => {
  test("artifact tools map to ops, everything else to null", () => {
    expect(artifactOpFromToolName("mcp__artifacts__artifact_create")).toBe(
      "create",
    );
    expect(artifactOpFromToolName("mcp__artifacts__artifact_update")).toBe(
      "update",
    );
    expect(artifactOpFromToolName("mcp__artifacts__artifact_rewrite")).toBe(
      "rewrite",
    );
    expect(artifactOpFromToolName("mcp__artifacts__something_else")).toBe(null);
    expect(artifactOpFromToolName("mcp__google__gmail_search")).toBe(null);
    expect(artifactOpFromToolName("Write")).toBe(null);
  });
});

describe("artifactExt", () => {
  test("every type gets a distinct plain-file extension", () => {
    expect(artifactExt("html")).toBe(".html");
    expect(artifactExt("svg")).toBe(".svg");
    expect(artifactExt("mermaid")).toBe(".mmd");
    expect(artifactExt("markdown")).toBe(".md");
  });
});
