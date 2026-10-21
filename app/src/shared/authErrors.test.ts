import { describe, expect, test } from "bun:test";
import { isClaudeLoginError } from "./authErrors";

describe("isClaudeLoginError", () => {
  test("recognises the CLI's expired-OAuth failure (the one users hit)", () => {
    expect(
      isClaudeLoginError(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(true);
  });

  test("recognises the other login-shaped failures", () => {
    for (const s of [
      "Not logged in. Please run /login",
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      "OAuth token expired",
      "refresh token is invalid",
      "Invalid authentication credentials",
    ]) {
      expect(isClaudeLoginError(s)).toBe(true);
    }
  });

  test("ignores unrelated failures and empty input", () => {
    for (const s of [
      "",
      undefined,
      null,
      "Twenty CRM returned 401 Unauthorized",
      "fetch failed",
      "Max turns reached",
      "The run ended in error.",
    ]) {
      expect(isClaudeLoginError(s)).toBe(false);
    }
  });
});
