import { describe, expect, test } from "bun:test";
import { parseLoginStatus } from "./CodexAuth";

describe("parseLoginStatus", () => {
  test("exit 0 is signed in, naming the method", () => {
    expect(parseLoginStatus(0, "Logged in using ChatGPT\n")).toEqual({
      loggedIn: true,
      method: "ChatGPT",
    });
    expect(parseLoginStatus(0, "Logged in using an API key")).toEqual({
      loggedIn: true,
      method: "API key",
    });
  });

  test("a non-zero exit saying so is plainly signed out", () => {
    expect(parseLoginStatus(1, "Not logged in")).toEqual({ loggedIn: false });
  });

  test("anything else is an error, not a sign-out", () => {
    expect(parseLoginStatus(null, "", "spawn ENOENT")).toEqual({
      loggedIn: false,
      error: "spawn ENOENT",
    });
    expect(parseLoginStatus(2, "config error")).toEqual({
      loggedIn: false,
      error: "config error",
    });
  });
});
