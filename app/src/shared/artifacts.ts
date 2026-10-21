// Pure artifact helpers shared by the bun tool server, session replay, and tests.
// Nothing here touches the filesystem.

import type { ArtifactOp, ArtifactType, ChatItem } from "./ipc";

export const ARTIFACT_TYPES: ArtifactType[] = [
  "html",
  "svg",
  "mermaid",
  "markdown",
];

/** MCP server name — tools surface to the model as mcp__artifacts__<tool>. */
export const ARTIFACTS_SERVER = "artifacts";
export const ARTIFACT_TOOL_PREFIX = `mcp__${ARTIFACTS_SERVER}__`;

/** Prefix rule that auto-approves the artifact tools (workspace-scoped writes only). */
export const ARTIFACTS_ALLOW_RULE = `${ARTIFACT_TOOL_PREFIX}*`;

/** artifact_create → "create" (etc.); null for non-artifact tools. */
export function artifactOpFromToolName(name: string): ArtifactOp | null {
  if (!name.startsWith(ARTIFACT_TOOL_PREFIX)) return null;
  const op = name.slice(ARTIFACT_TOOL_PREFIX.length).replace(/^artifact_/, "");
  return op === "create" || op === "update" || op === "rewrite" ? op : null;
}

/** File extension per type — artifacts are plain files a browser/editor can open. */
export function artifactExt(type: ArtifactType): string {
  switch (type) {
    case "html":
      return ".html";
    case "svg":
      return ".svg";
    case "mermaid":
      return ".mmd";
    case "markdown":
      return ".md";
  }
}

/** Stable kebab-case id — also the on-disk filename, so it must be path-safe. */
export function isValidArtifactId(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id);
}

export type UpdateResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** Apply one old_str→new_str replacement with the Edit-tool contract: the match
 *  must be exact and unique, and the error names the failure so the model can
 *  self-correct (add context, or fall back to artifact_rewrite). */
export function applyArtifactUpdate(
  content: string,
  oldStr: string,
  newStr: string,
): UpdateResult {
  if (!oldStr) return { ok: false, error: "old_str must not be empty." };
  const first = content.indexOf(oldStr);
  if (first === -1) {
    return {
      ok: false,
      error:
        "old_str was not found in the artifact. It must match the current content exactly, including whitespace. Re-check the content, or use artifact_rewrite to replace it wholesale.",
    };
  }
  const second = content.indexOf(oldStr, first + 1);
  if (second !== -1) {
    const count = content.split(oldStr).length - 1;
    return {
      ok: false,
      error: `old_str matched ${count} times — it must match exactly once. Include more surrounding context to make it unique, or use artifact_rewrite.`,
    };
  }
  return {
    ok: true,
    content:
      content.slice(0, first) + newStr + content.slice(first + oldStr.length),
  };
}

/** One artifact's UI state: metadata + every version content seen this thread. */
export type ArtifactState = {
  title: string;
  type: ArtifactType;
  versions: string[];
};

/** Fold artifact ChatItems (live or replayed history) into per-id version lists. */
export function deriveArtifacts(
  items: ChatItem[],
): Record<string, ArtifactState> {
  const artifacts: Record<string, ArtifactState> = {};
  for (const item of items) {
    if (item.type !== "artifact") continue;
    const prior = artifacts[item.artifactId];
    artifacts[item.artifactId] = {
      title: item.title,
      type: item.artifactType,
      versions: [...(prior?.versions ?? []), item.content],
    };
  }
  return artifacts;
}

/** Common mistake: the model wraps artifact content in a markdown fence. Strip a
 *  single whole-content fence; anything else passes through untouched. */
export function stripOuterFence(content: string): string {
  const m = content.trim().match(/^```[a-zA-Z0-9-]*\n([\s\S]*)\n```$/);
  return m ? m[1] : content;
}
