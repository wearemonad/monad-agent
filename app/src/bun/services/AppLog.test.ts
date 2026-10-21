import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installAppLog, redactSecrets } from "./AppLog";

let uninstall: () => void = () => {};
afterEach(() => uninstall());

function tempLog(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "monad-log-")),
    "monad.log",
  );
}

describe("app log", () => {
  test("console output is mirrored to the file with a timestamp and level", () => {
    const file = tempLog();
    const quiet = spyOn(console, "warn").mockImplementation(() => {});
    uninstall = installAppLog(file);
    console.warn("[scheduler] Briefing:", "retry #2");
    uninstall();
    quiet.mockRestore();
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z \[warn\] \[scheduler\] Briefing: retry #2\n$/,
    );
  });

  test("rotates past the size cap, keeping two old files", () => {
    const file = tempLog();
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    uninstall = installAppLog(file, 200);
    for (let i = 0; i < 20; i++) console.log(`line ${i} ${"x".repeat(40)}`);
    uninstall();
    quiet.mockRestore();
    const names = fs.readdirSync(path.dirname(file)).sort();
    expect(names).toEqual(["monad.log", "monad.log.1", "monad.log.2"]);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
    expect(fs.readFileSync(file, "utf8")).toContain("line 19");
  });

  test("secrets are redacted", () => {
    expect(redactSecrets("key sk-ant-api03-abcdefghijklmnop end")).toBe(
      "key sk-ant…[redacted] end",
    );
    expect(redactSecrets("Authorization: Bearer abc.def.ghijklmnop")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactSecrets("token ya29.a0AfH6SMBxyz123")).toBe(
      "token ya29.a…[redacted]",
    );
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });
});
