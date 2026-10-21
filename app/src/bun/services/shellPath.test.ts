import { test, expect } from "bun:test";
import { fixProcessPath, mergePaths } from "./shellPath";

test("mergePaths keeps shell order first and dedupes", () => {
  expect(
    mergePaths(["/opt/homebrew/bin", "/usr/bin"], "/usr/bin:/bin", [
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ]),
  ).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin");
});

test("mergePaths survives an empty shell result", () => {
  expect(mergePaths([], "/usr/bin:/bin", [])).toBe("/usr/bin:/bin");
});

test("mergePaths drops empty segments", () => {
  expect(mergePaths([""], ":/usr/bin::", [""])).toBe("/usr/bin");
});

// Simulates the Dock launch: strip PATH to launchd's default, run the fix,
// and the tools the terminal sees (bun is a safe proxy — it's how these tests
// run) must be findable again.
test("fixProcessPath restores tools hidden from a minimal GUI PATH", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    fixProcessPath();
    expect(Bun.which("bun")).toBeTruthy();
    // The minimal entries must survive the merge too.
    expect(process.env.PATH).toContain("/usr/bin");
  } finally {
    process.env.PATH = original;
  }
});
