import { describe, expect, test } from "bun:test";
import { lastContextTokens } from "./SessionStore";

// The context meter resumes from persisted usage when a thread is reopened:
// the LAST top-level assistant message's usage is the thread's footprint.

const assistant = (
  usage: Record<string, number> | undefined,
  isSidechain = false,
) => ({
  type: "assistant",
  isSidechain,
  message: usage ? { role: "assistant", usage } : { role: "assistant" },
});

describe("lastContextTokens", () => {
  test("sums input + cache read + cache creation + output of the last call", () => {
    const messages = [
      { type: "user", message: { role: "user", content: "hi" } },
      assistant({
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
        output_tokens: 20,
      }),
      assistant({
        input_tokens: 12,
        cache_read_input_tokens: 26219,
        cache_creation_input_tokens: 88,
        output_tokens: 43,
      }),
    ];
    expect(lastContextTokens(messages)).toBe(12 + 26219 + 88 + 43);
  });

  test("skips sidechain (subagent) messages — they run in their own window", () => {
    const messages = [
      assistant({ input_tokens: 50, output_tokens: 5 }),
      assistant({ input_tokens: 999_999, output_tokens: 999 }, true),
    ];
    expect(lastContextTokens(messages)).toBe(55);
  });

  test("tolerates messages without usage and empty transcripts", () => {
    expect(lastContextTokens([])).toBe(0);
    expect(
      lastContextTokens([
        { type: "user", message: {} },
        assistant(undefined),
        "garbage",
        null,
      ]),
    ).toBe(0);
  });

  test("missing usage fields count as 0, not NaN", () => {
    expect(lastContextTokens([assistant({ output_tokens: 7 })])).toBe(7);
  });
});
