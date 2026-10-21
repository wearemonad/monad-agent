import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { GoogleDriveService } from "./GoogleDriveService";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const folder = (id: string, name: string, parent?: string) => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  modifiedTime: "t1",
  body: "",
  parent,
});
const doc = (id: string, name: string, parent?: string) => ({
  id,
  name,
  mimeType: "text/markdown",
  modifiedTime: "t1",
  body: name,
  parent,
});

// sync() is exercised with the Drive API mocked out; the constructor only
// stores its dependencies, so dummies are safe here.
let ws: string;
let svc: GoogleDriveService;
let driveFiles: {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  body: string;
  /** Folder this entry is listed under; defaults to the single synced folder. */
  parent?: string;
}[];
let downloads: string[];

const inboxFiles = () =>
  fs
    .readdirSync(path.join(ws, "inbox"))
    .filter((f) => !f.startsWith("."))
    .sort();
const readInbox = (name: string) =>
  fs.readFileSync(path.join(ws, "inbox", name), "utf8");
const runSync = (
  folderIds: string[] = ["folder1"],
  opts?: { recursive?: boolean },
) => svc.sync("ws1", ws, folderIds, opts);

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-drive-"));
  driveFiles = [
    {
      id: "f1",
      name: "notes.md",
      mimeType: "text/markdown",
      modifiedTime: "t1",
      body: "notes v1",
    },
    {
      id: "f2",
      name: "post 14.jpg",
      mimeType: "image/jpeg",
      modifiedTime: "t1",
      body: "jpegbytes",
    },
  ];
  downloads = [];
  svc = new GoogleDriveService({} as any, () => {});
  // Stand in for the two methods that reach Google. Everything under test —
  // the ledger, filename placement, dedupe — sits above these.
  (svc as any).listFolderFiles = async (_ws: string, folderId: string) =>
    driveFiles
      .filter((f) => (f.parent ?? "folder1") === folderId)
      .map(({ body, parent, ...meta }) => meta);
  (svc as any).downloadToFile = async (
    _ws: string,
    fileId: string,
    _exportMime: string | undefined,
    destPath: string,
  ) => {
    const f = driveFiles.find((f) => f.id === fileId)!;
    downloads.push(f.id);
    fs.writeFileSync(destPath, f.body);
    return { hash: sha(f.body) };
  };
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("drive sync dedupe", () => {
  test("first sync downloads everything; second sync is a no-op", async () => {
    expect(await runSync()).toEqual(["inbox/notes.md", "inbox/post 14.jpg"]);
    expect(await runSync()).toEqual([]);
    expect(downloads).toEqual(["f1", "f2"]);
    expect(inboxFiles()).toEqual(["notes.md", "post 14.jpg"]);
  });

  test("a changed file overwrites its previous download — no name-2 duplicate", async () => {
    await runSync();
    driveFiles[0] = { ...driveFiles[0], modifiedTime: "t2", body: "notes v2" };
    expect(await runSync()).toEqual(["inbox/notes.md"]);
    expect(inboxFiles()).toEqual(["notes.md", "post 14.jpg"]);
    expect(readInbox("notes.md")).toBe("notes v2");
  });

  test("lost ledger + identical file already in inbox → adopted, not duplicated", async () => {
    await runSync();
    fs.rmSync(path.join(ws, ".monad", "drive-sync.json"));
    expect(await runSync()).toEqual([]); // re-downloaded but adopted in place
    expect(inboxFiles()).toEqual(["notes.md", "post 14.jpg"]);
    // and the rebuilt ledger makes the next sync a true no-op
    downloads = [];
    await runSync();
    expect(downloads).toEqual([]);
  });

  test("an unrelated same-named user file is preserved via a unique name", async () => {
    fs.mkdirSync(path.join(ws, "inbox"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "inbox", "notes.md"),
      "the user's own notes",
    );
    expect(await runSync()).toEqual(["inbox/notes-2.md", "inbox/post 14.jpg"]);
    expect(readInbox("notes.md")).toBe("the user's own notes");
    expect(readInbox("notes-2.md")).toBe("notes v1");
    // updates to the Drive file keep landing on ITS name, not the user's
    driveFiles[0] = { ...driveFiles[0], modifiedTime: "t2", body: "notes v2" };
    expect(await runSync()).toEqual(["inbox/notes-2.md"]);
    expect(readInbox("notes-2.md")).toBe("notes v2");
  });

  test("ledger survives a failure partway through the file list", async () => {
    (svc as any).downloadToFile = async (
      _ws: string,
      fileId: string,
      _exportMime: string | undefined,
      destPath: string,
    ) => {
      if (fileId === "f2") throw new Error("network"); // not oversize → propagates
      const f = driveFiles[0];
      downloads.push(f.id);
      fs.writeFileSync(destPath, f.body);
      return { hash: sha(f.body) };
    };
    await expect(runSync()).rejects.toThrow("network");
    // f1 completed and was recorded — a retry only fetches f2
    (svc as any).downloadToFile = async (
      _ws: string,
      fileId: string,
      _exportMime: string | undefined,
      destPath: string,
    ) => {
      const f = driveFiles.find((f) => f.id === fileId)!;
      downloads.push(f.id);
      fs.writeFileSync(destPath, f.body);
      return { hash: sha(f.body) };
    };
    expect(await runSync()).toEqual(["inbox/post 14.jpg"]);
    expect(downloads).toEqual(["f1", "f2"]);
    expect(inboxFiles()).toEqual(["notes.md", "post 14.jpg"]);
  });

  test("concurrent syncs for the same workspace collapse to one", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    (svc as any).apiGet = async () => {
      await gate;
      return { files: driveFiles.map(({ body, ...meta }) => meta) };
    };
    const first = runSync();
    const second = runSync(); // in-flight guard → immediate no-op
    release();
    // null (not []) marks the in-flight no-op so the caller skips stamping lastSync
    expect(await second).toBeNull();
    expect((await first)?.length).toBe(2);
    expect(inboxFiles()).toEqual(["notes.md", "post 14.jpg"]);
  });

  // integrations#10: a changed Drive file must not clobber an inbox file the
  // user has since replaced (or that another Drive file reused the name for).
  test("a changed Drive file whose inbox copy was replaced lands under a fresh name", async () => {
    await runSync(); // notes.md ← "notes v1"
    // user overwrites our download with their own content
    fs.writeFileSync(path.join(ws, "inbox", "notes.md"), "user replaced this");
    driveFiles[0] = { ...driveFiles[0], modifiedTime: "t2", body: "notes v2" };
    expect(await runSync()).toEqual(["inbox/notes-2.md"]);
    expect(readInbox("notes.md")).toBe("user replaced this"); // preserved
    expect(readInbox("notes-2.md")).toBe("notes v2");
  });

  // integrations#8: an oversized file is skipped (and recorded so it isn't
  // re-evaluated) rather than downloaded.
  test("a file over the size cap is skipped, not downloaded", async () => {
    driveFiles = [
      {
        id: "big",
        name: "huge.bin",
        mimeType: "application/octet-stream",
        modifiedTime: "t1",
        body: "x",
      },
    ];
    (svc as any).listFolderFiles = async () => [
      {
        id: "big",
        name: "huge.bin",
        mimeType: "application/octet-stream",
        modifiedTime: "t1",
        size: String(200 * 1024 * 1024),
      },
    ];
    expect(await runSync()).toEqual([]);
    expect(downloads).toEqual([]);
    expect(inboxFiles()).toEqual([]);
    // recorded → a second sync doesn't re-evaluate/emit for it
    expect(await runSync()).toEqual([]);
  });

  test("two selected folders sync into one inbox in a single run", async () => {
    driveFiles.push({
      id: "f3",
      name: "brief.md",
      mimeType: "text/markdown",
      modifiedTime: "t1",
      body: "brief",
      parent: "folder2",
    });
    expect(await runSync(["folder1", "folder2"])).toEqual([
      "inbox/notes.md",
      "inbox/post 14.jpg",
      "inbox/brief.md",
    ]);
    expect(inboxFiles()).toEqual(["brief.md", "notes.md", "post 14.jpg"]);
    expect(await runSync(["folder1", "folder2"])).toEqual([]);
  });

  // Drive lets one file live under several parents, and nothing stops a user
  // selecting both of them. The shared ledger is what makes that free.
  test("a file reachable from two selected folders downloads once", async () => {
    driveFiles.push({ ...driveFiles[0], parent: "folder2" });
    expect(await runSync(["folder1", "folder2"])).toEqual([
      "inbox/notes.md",
      "inbox/post 14.jpg",
    ]);
    expect(downloads).toEqual(["f1", "f2"]);
    expect(inboxFiles()).toEqual(["notes.md", "post 14.jpg"]);
  });

  test("subfolders are ignored unless recursion is asked for", async () => {
    driveFiles.push(folder("sub", "Archive"), doc("f4", "old.md", "sub"));
    expect(await runSync()).toEqual(["inbox/notes.md", "inbox/post 14.jpg"]);
    expect(inboxFiles()).toEqual(["notes.md", "post 14.jpg"]);
  });

  test("recursion pulls files out of nested subfolders", async () => {
    driveFiles.push(
      folder("sub", "Archive"),
      doc("f4", "old.md", "sub"),
      folder("deep", "2019", "sub"),
      doc("f5", "older.md", "deep"),
    );
    expect(await runSync(["folder1"], { recursive: true })).toEqual([
      "inbox/notes.md",
      "inbox/post 14.jpg",
      "inbox/old.md",
      "inbox/older.md",
    ]);
    expect(inboxFiles()).toEqual([
      "notes.md",
      "old.md",
      "older.md",
      "post 14.jpg",
    ]);
  });

  // A folder can sit under several parents, so "folder1 contains sub, sub
  // contains folder1" is expressible — the visited set is what ends the walk.
  test("a folder cycle terminates instead of looping forever", async () => {
    driveFiles.push(
      folder("sub", "Loop"),
      folder("folder1", "Back to the top", "sub"),
      doc("f4", "looped.md", "sub"),
    );
    expect(await runSync(["folder1"], { recursive: true })).toEqual([
      "inbox/notes.md",
      "inbox/post 14.jpg",
      "inbox/looped.md",
    ]);
  });

  // The cap stops the walk going deeper; it must never cut a folder's listing
  // short, or files sitting after a subfolder entry vanish from the sync.
  test("the subfolder cap stops descending without dropping files", async () => {
    // 250 sibling subfolders (cap is 200), each holding one file, plus a file
    // listed after them all at the top level.
    for (let i = 0; i < 250; i++) {
      driveFiles.push(folder(`sub${i}`, `Sub ${i}`));
      driveFiles.push(doc(`sf${i}`, `sub-${i}.md`, `sub${i}`));
    }
    driveFiles.push(doc("last", "last.md"));
    const out = (await runSync(["folder1"], { recursive: true })) ?? [];
    // the top-level file after the subfolder entries survived
    expect(out).toContain("inbox/last.md");
    // 199 subfolders were walked (folder1 itself occupies a cap slot)
    const pulled = out.filter((p) => p.startsWith("inbox/sub-"));
    expect(pulled.length).toBe(199);
  });

  test("legacy string-format ledger entries are honored", async () => {
    fs.mkdirSync(path.join(ws, ".monad"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".monad", "drive-sync.json"),
      JSON.stringify({ syncedIds: { f1: "t1", f2: "t1" } }),
    );
    expect(await runSync()).toEqual([]);
    expect(downloads).toEqual([]);
  });
});
