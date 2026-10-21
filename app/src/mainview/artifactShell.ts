// Builds the HTML document handed to the sandboxed <electrobun-webview> that
// renders an artifact. Two defense layers, both mandatory:
//   1. The webview's `sandbox` attribute (set by the panel) severs Electrobun's
//      RPC bridge — artifact JS cannot reach Monad, Bun, or the filesystem.
//   2. The CSP <meta> below denies ALL network access (no fetch/XHR/WebSocket,
//      no external scripts/styles/images) — inline code and data: URIs only.
// Markdown artifacts never come through here; they render as trusted prose.

import type { ArtifactType } from "../shared/ipc";

/** Inline-only, zero-network policy. A meta-tag CSP cannot be removed or
 *  escaped by scripts inside the document, even under sandbox="allow-scripts".
 *  form-action/base-uri close the non-fetch exfil channels (a form POST or a
 *  <base> retargeting relative URLs). frame-ancestors would be ignored here —
 *  it cannot be delivered via <meta>. */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none';";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

/** The shell canvas colors. The sandboxed document can't see the app's CSS
 *  custom properties (separate document, and the CSP forbids linking our
 *  stylesheet), so the caller passes the resolved token VALUES in — see
 *  ArtifactPanel, which reads them off <html> per scheme/theme change. */
export type ArtifactLook = { bg: string; fg: string; dark: boolean };

/** Fallback when no look is handed in (unit tests): Carbon dark, mirroring
 *  DEFAULT_TOKENS in lib/theme.ts. */
const DEFAULT_LOOK: ArtifactLook = {
  bg: "oklch(0.205 0 0)",
  fg: "oklch(0.985 0 0)",
  dark: true,
};

const baseStyle = (look: ArtifactLook) => `<style>
  html, body { margin: 0; min-height: 100%; }
  body { background: ${look.bg}; color: ${look.fg}; font-family: -apple-system, sans-serif; }
</style>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The one shell every artifact renders through. The app owns the document
 *  head, and the model's markup is placed strictly AFTER the CSP meta — a meta
 *  CSP only governs what the parser sees after it, so splicing the policy into
 *  model-authored <head> markup would let a leading <script> run with full
 *  network before the policy exists. Model content that carries its own
 *  <html>/<head> is flattened into the body instead: the HTML parser ignores
 *  head-only tags there (a nested meta CSP in body position is inert), while
 *  its <style>/<script> still apply — under this document's policy. Nothing
 *  the content contains can close our head or re-open one. */
function wrap(body: string, extraHead = "", look = DEFAULT_LOOK): string {
  return `<!doctype html><html><head><meta charset="utf-8">${CSP_META}${baseStyle(look)}${extraHead}</head><body>${body}</body></html>`;
}

/** Shell for html/svg/mermaid artifacts. `mermaidJs` is the bundled mermaid
 *  UMD source, injected inline (the CSP forbids loading it any other way);
 *  callers only pass it for mermaid artifacts. */
export function buildArtifactShell(
  type: Exclude<ArtifactType, "markdown">,
  content: string,
  mermaidJs?: string,
  look: ArtifactLook = DEFAULT_LOOK,
): string {
  switch (type) {
    case "html":
      return wrap(content, "", look);
    case "svg":
      return wrap(
        `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px;box-sizing:border-box">${content}</div>`,
        "",
        look,
      );
    case "mermaid": {
      // Mermaid 12 defaults to the ELK layout and the "neo" look, which
      // re-lays out and recolours existing diagrams — pin the pre-12 look.
      const config = {
        startOnLoad: true,
        theme: look.dark ? "dark" : "default",
        layout: "dagre",
        look: "classic",
      };
      return wrap(
        `<pre class="mermaid" style="display:flex;justify-content:center;padding:24px 16px;background:transparent">${escapeHtml(content)}</pre>`,
        `<script>${mermaidJs ?? ""}</script><script>mermaid.initialize(${JSON.stringify(config)});</script>`,
        look,
      );
    }
  }
}
