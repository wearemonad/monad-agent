import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  forgetSessionOwner,
  forgetSessionOwners,
  readSessionOwners,
  recordSessionOwner,
  recordSessionOwners,
} from "./sessionMeta";

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-owners-"));
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe("session owners registry", () => {
  test("record, read back, forget", () => {
    recordSessionOwner(ws, "s1", "ws1");
    recordSessionOwner(ws, "s2", "ws1");
    expect(readSessionOwners(ws)).toEqual({
      s1: { owner: "ws1" },
      s2: { owner: "ws1" },
    });
    forgetSessionOwner(ws, "s1");
    expect(Object.keys(readSessionOwners(ws))).toEqual(["s2"]);
    forgetSessionOwners(ws, () => true);
    expect(readSessionOwners(ws)).toEqual({});
  });

  test("a positive owner is never downgraded by a later negative scan", () => {
    recordSessionOwner(ws, "s1", "ws1");
    recordSessionOwners(ws, { s1: { owner: null, fp: "10:1" } });
    expect(readSessionOwners(ws).s1).toEqual({ owner: "ws1" });
  });

  test("negative entries update with the file fingerprint", () => {
    recordSessionOwners(ws, { s1: { owner: null, fp: "10:1" } });
    recordSessionOwners(ws, { s1: { owner: null, fp: "20:2" } });
    expect(readSessionOwners(ws).s1).toEqual({ owner: null, fp: "20:2" });
  });

  test("a corrupt file degrades to empty (and is quarantined), never throws", () => {
    fs.mkdirSync(path.join(ws, ".monad"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".monad", "session-owners.json"), "{nope");
    expect(readSessionOwners(ws)).toEqual({});
    recordSessionOwner(ws, "s1", "ws1");
    expect(readSessionOwners(ws)).toEqual({ s1: { owner: "ws1" } });
  });

  test("an unwritable workspace path is a silent no-op", () => {
    expect(() =>
      recordSessionOwner("/nonexistent-root-dir/ws", "s1", "ws1"),
    ).not.toThrow();
  });
});
