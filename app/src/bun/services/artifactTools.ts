import * as fs from "node:fs";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ArtifactType } from "../../shared/ipc";
import {
  ARTIFACT_TYPES,
  ARTIFACTS_SERVER,
  applyArtifactUpdate,
  artifactExt,
  isValidArtifactId,
  stripOuterFence,
} from "../../shared/artifacts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const err = (message: string) => ({
  content: [{ type: "text" as const, text: `Error: ${message}` }],
  isError: true,
});

type ArtifactMeta = { type: ArtifactType; title: string; updatedAt: string };
type MetaFile = Record<string, ArtifactMeta>;

function artifactsDir(workspacePath: string): string {
  return path.join(workspacePath, "artifacts");
}

function metaPath(workspacePath: string): string {
  return path.join(artifactsDir(workspacePath), ".meta.json");
}

function readMeta(workspacePath: string): MetaFile {
  try {
    return JSON.parse(fs.readFileSync(metaPath(workspacePath), "utf8"));
  } catch {
    return {};
  }
}

function writeMeta(workspacePath: string, meta: MetaFile): void {
  fs.mkdirSync(artifactsDir(workspacePath), { recursive: true });
  fs.writeFileSync(metaPath(workspacePath), JSON.stringify(meta, null, 2));
}

/** Absolute path of an artifact's file, or null when it doesn't exist. */
export function artifactPathFor(
  workspacePath: string,
  id: string,
): string | null {
  if (!isValidArtifactId(id)) return null;
  const meta = readMeta(workspacePath)[id];
  if (!meta) return null;
  const p = path.join(
    artifactsDir(workspacePath),
    `${id}${artifactExt(meta.type)}`,
  );
  return fs.existsSync(p) ? p : null;
}

/** Current on-disk state of an artifact (the authority normalize() reads after
 *  each successful tool call). */
export function readArtifact(
  workspacePath: string,
  id: string,
): { type: ArtifactType; title: string; content: string } | null {
  const meta = readMeta(workspacePath)[id];
  const p = artifactPathFor(workspacePath, id);
  if (!meta || !p) return null;
  try {
    return {
      type: meta.type,
      title: meta.title,
      content: fs.readFileSync(p, "utf8"),
    };
  } catch {
    return null;
  }
}

function saveArtifact(
  workspacePath: string,
  id: string,
  type: ArtifactType,
  title: string,
  content: string,
): void {
  const dir = artifactsDir(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}${artifactExt(type)}`), content);
  const meta = readMeta(workspacePath);
  meta[id] = { type, title, updatedAt: new Date().toISOString() };
  writeMeta(workspacePath, meta);
}

const idSchema = z
  .string()
  .describe(
    "Stable kebab-case id, e.g. 'q3-pipeline-dashboard'. Reuse it to edit later.",
  );

/** In-process MCP server giving the agent a structured way to emit renderable
 *  artifacts. Files land in the workspace's artifacts/ folder (latest version);
 *  the UI's version history is reconstructed from the tool-call stream. */
export function buildArtifactToolsServer(workspacePath: string) {
  return createSdkMcpServer({
    name: ARTIFACTS_SERVER,
    version: "1.0.0",
    instructions:
      "Artifact tools: create self-contained renderable artifacts (reports, dashboards, diagrams, documents) shown in a side panel next to the chat and saved as files in the workspace's artifacts/ folder. Use the workspace's 'artifact' skill for guidance on when an artifact is appropriate.",
    tools: buildArtifactTools(workspacePath),
  });
}

/** Tool definitions, exported separately so tests can drive the handlers. */
export function buildArtifactTools(workspacePath: string) {
  return [
    tool(
      "artifact_create",
      "Create a new artifact, rendered live in the app's side panel and saved to artifacts/. Content must be COMPLETE and self-contained (no placeholders, no markdown fence around it, no external URLs — the renderer blocks all network access).",
      {
        id: idSchema,
        type: z
          .enum(ARTIFACT_TYPES as [ArtifactType, ...ArtifactType[]])
          .describe(
            "html = full page; svg = vector image; mermaid = diagram source; markdown = document",
          ),
        title: z
          .string()
          .describe("Short human title shown in the panel header"),
        content: z.string().describe("Complete artifact content"),
      },
      async ({ id, type, title, content }) => {
        if (!isValidArtifactId(id)) {
          return err(
            "id must be kebab-case: lowercase letters, digits and hyphens, max 64 chars.",
          );
        }
        if (!title.trim()) return err("title must not be empty.");
        const body = stripOuterFence(content);
        if (!body.trim()) return err("content must not be empty.");
        if (readArtifact(workspacePath, id)) {
          return err(
            `Artifact '${id}' already exists. Use artifact_update for small edits or artifact_rewrite to replace it, or pick a new id for a genuinely new artifact.`,
          );
        }
        try {
          saveArtifact(workspacePath, id, type, title.trim(), body);
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
        return text(
          `Artifact '${id}' created (${type}) and saved to artifacts/${id}${artifactExt(type)}. It is now shown in the side panel — no need to repeat its content in chat.`,
        );
      },
    ),
    tool(
      "artifact_update",
      "Surgically edit an existing artifact: replace old_str with new_str. old_str must match the CURRENT content exactly once (including whitespace). For large changes use artifact_rewrite.",
      {
        id: idSchema,
        old_str: z
          .string()
          .describe("Exact text to replace — must occur exactly once"),
        new_str: z.string().describe("Replacement text"),
      },
      async ({ id, old_str, new_str }) => {
        const current = readArtifact(workspacePath, id);
        if (!current) {
          return err(
            `No artifact '${id}' exists. Create it first with artifact_create.`,
          );
        }
        const result = applyArtifactUpdate(current.content, old_str, new_str);
        if (!result.ok) return err(result.error);
        try {
          saveArtifact(
            workspacePath,
            id,
            current.type,
            current.title,
            result.content,
          );
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
        return text(
          `Artifact '${id}' updated. The panel now shows the new version.`,
        );
      },
    ),
    tool(
      "artifact_rewrite",
      "Replace an existing artifact's entire content (and optionally its title). Use when an edit would touch a large fraction of the artifact.",
      {
        id: idSchema,
        title: z
          .string()
          .optional()
          .describe("New title (omit to keep the current one)"),
        content: z.string().describe("Complete replacement content"),
      },
      async ({ id, title, content }) => {
        const current = readArtifact(workspacePath, id);
        if (!current) {
          return err(
            `No artifact '${id}' exists. Create it first with artifact_create.`,
          );
        }
        const body = stripOuterFence(content);
        if (!body.trim()) return err("content must not be empty.");
        try {
          saveArtifact(
            workspacePath,
            id,
            current.type,
            (title ?? current.title).trim(),
            body,
          );
        } catch (e) {
          return err(String((e as Error).message ?? e));
        }
        return text(
          `Artifact '${id}' rewritten. The panel now shows the new version.`,
        );
      },
    ),
  ];
}
