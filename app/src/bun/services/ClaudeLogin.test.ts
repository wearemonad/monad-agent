import { describe, expect, test } from "bun:test";
import {
  extractLoginUrl,
  loginFailureReason,
  parseAuthStatus,
} from "./ClaudeLogin";

// Exact shapes captured from claude 2.1.278 (`claude auth login` and
// `claude auth status --json`).
const LOGIN_STDOUT =
  "Opening browser to sign in…\n" +
  "If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\x1b\\https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\x1b]8;;\x1b\\\n" +
  "Paste code here if prompted > ";

describe("extractLoginUrl", () => {
  test("pulls the authorize link out of the OSC-8 hyperlink noise", () => {
    expect(extractLoginUrl(LOGIN_STDOUT)).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz",
    );
  });

  test("returns null while the link hasn't been printed yet", () => {
    expect(extractLoginUrl("Opening browser to sign in…\n")).toBeNull();
    expect(extractLoginUrl("")).toBeNull();
  });
});

describe("parseAuthStatus", () => {
  test("reads a signed-in status", () => {
    const s = parseAuthStatus(
      '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "email": "p@example.com",\n  "orgId": "x"\n}\n',
    );
    expect(s).toEqual({
      loggedIn: true,
      email: "p@example.com",
      method: "claude.ai",
    });
  });

  test("reads a signed-out status without inventing an email", () => {
    expect(parseAuthStatus('{"loggedIn": false}')).toEqual({ loggedIn: false });
  });

  test("non-JSON output (missing binary, crash) is signed-out with a reason", () => {
    const s = parseAuthStatus("", "zsh: command not found: claude");
    expect(s.loggedIn).toBe(false);
    expect(s.error).toContain("command not found");
    expect(parseAuthStatus("{not json").loggedIn).toBe(false);
  });
});

describe("loginFailureReason", () => {
  test("extracts the CLI's failure line", () => {
    expect(
      loginFailureReason("Login failed: Request failed with status code 400\n"),
    ).toBe("Request failed with status code 400");
  });
  test("falls back to the last non-empty line", () => {
    expect(loginFailureReason("\nsomething odd\n\n")).toBe("something odd");
    expect(loginFailureReason("")).toBe("");
  });
});
