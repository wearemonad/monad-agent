import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactType, ChatItem } from "../../shared/ipc";
import { deriveArtifacts } from "../../shared/artifacts";
import { SessionStore } from "./SessionStore";
import { buildArtifactTools } from "./artifactTools";

// replayArtifactOp is SessionStore's private reducer for artifact tool_use
// blocks; drive it directly with the maps history() would thread through.
const replay = (
  store: SessionStore,
  cwd: string,
  op: "create" | "update" | "rewrite",
  id: string,
  input: any,
  contentById: Map<string, string>,
  kindById: Map<string, { type: ArtifactType; title: string }>,
) =>
  (store as any).replayArtifactOp(
    cwd,
    op,
    id,
    input,
    contentById,
    kindById,
  ) as ChatItem | null;

let cwd: string;
const store = new SessionStore();

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "monad-replay-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("artifact history replay", () => {
  test("create → update → rewrite folds into successive versions", () => {
    const contentById = new Map<string, string>();
    const kindById = new Map<string, { type: ArtifactType; title: string }>();

    const created = replay(
      store,
      cwd,
      "create",
      "d",
      { id: "d", type: "html", title: "Dash", content: "<p>v1</p>" },
      contentById,
      kindById,
    );
    expect(created).toMatchObject({
      type: "artifact",
      artifactId: "d",
      op: "create",
      content: "<p>v1</p>",
      title: "Dash",
    });

    const updated = replay(
      store,
      cwd,
      "update",
      "d",
      { id: "d", old_str: "v1", new_str: "v2" },
      contentById,
      kindById,
    );
    expect(updated).toMatchObject({ op: "update", content: "<p>v2</p>" });

    const rewritten = replay(
      store,
      cwd,
      "rewrite",
      "d",
      { id: "d", title: "Dash 2", content: "<p>v3</p>" },
      contentById,
      kindById,
    );
    expect(rewritten).toMatchObject({
      op: "rewrite",
      content: "<p>v3</p>",
      title: "Dash 2",
    });

    const artifacts = deriveArtifacts([created!, updated!, rewritten!]);
    expect(artifacts.d.versions).toEqual([
      "<p>v1</p>",
      "<p>v2</p>",
      "<p>v3</p>",
    ]);
    expect(artifacts.d.title).toBe("Dash 2");
  });

  test("a non-applying update keeps the prior version instead of breaking", () => {
    const contentById = new Map<string, string>();
    const kindById = new Map<string, { type: ArtifactType; title: string }>();
    replay(
      store,
      cwd,
      "create",
      "d",
      { id: "d", type: "html", title: "D", content: "<p>base</p>" },
      contentById,
      kindById,
    );
    const item = replay(
      store,
      cwd,
      "update",
      "d",
      { id: "d", old_str: "drifted", new_str: "x" },
      contentById,
      kindById,
    );
    expect(item).toMatchObject({ op: "update", content: "<p>base</p>" });
  });

  test("update to an artifact from another session seeds from disk", async () => {
    // Simulate the earlier session by writing through the real tool.
    const tools = buildArtifactTools(cwd);
    await tools
      .find((t) => t.name === "artifact_create")!
      .handler(
        {
          id: "old",
          type: "markdown",
          title: "From before",
          content: "alpha",
        } as any,
        {},
      );
    const contentById = new Map<string, string>();
    const kindById = new Map<string, { type: ArtifactType; title: string }>();
    const item = replay(
      store,
      cwd,
      "update",
      "old",
      { id: "old", old_str: "alpha", new_str: "omega" },
      contentById,
      kindById,
    );
    expect(item).toMatchObject({
      artifactType: "markdown",
      title: "From before",
      content: "omega",
    });
  });

  test("update to an unknown artifact with no disk state falls back to a tool row", () => {
    const item = replay(
      store,
      cwd,
      "update",
      "ghost",
      { id: "ghost", old_str: "a", new_str: "b" },
      new Map(),
      new Map(),
    );
    expect(item).toBe(null);
  });
});
