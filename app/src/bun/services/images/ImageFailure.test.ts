import { describe, expect, test } from "bun:test";
import {
  ImageAuthFailed,
  ImageContentBlocked,
  ImageNotProduced,
  ImageProviderError,
  ImageProviderUnavailable,
  ImageQuotaExhausted,
  ImageRateLimited,
  imageFailureMessage,
} from "./ImageFailure";

// What the user reads when an image can't be made: what happened, and the
// one thing that fixes it.

describe("Codex failures", () => {
  test("the plan's usage limit says when to come back and offers a way around it", () => {
    expect(
      imageFailureMessage(
        new ImageRateLimited({
          provider: "codex",
          detail: "You've hit your usage limit. …",
          retryAt: "at 2:02 PM",
        }),
      ),
    ).toBe(
      "You've reached your ChatGPT plan's usage limit for image generation. Try again at 2:02 PM, or add an image API key in Settings → Image models.",
    );
  });

  test("an expired session points to signing in again", () => {
    expect(
      imageFailureMessage(
        new ImageAuthFailed({
          provider: "codex",
          reason: "expired",
          detail: "Your access token could not be refreshed.",
        }),
      ),
    ).toBe(
      "Your Codex sign-in has expired. Sign in again in Settings → Providers → OpenAI (or run `codex login` in a terminal), then retry.",
    );
  });

  test("signed out points to signing in, or an API key", () => {
    expect(
      imageFailureMessage(
        new ImageAuthFailed({
          provider: "codex",
          reason: "signed-out",
          detail: "Codex is not signed in.",
        }),
      ),
    ).toBe(
      "Codex isn't signed in. Sign in in Settings → Providers → OpenAI (or run `codex login` in a terminal), or add an image API key in Settings → Image models.",
    );
  });

  test("a missing CLI says how to install it", () => {
    expect(
      imageFailureMessage(
        new ImageProviderUnavailable({
          provider: "codex",
          detail: "Codex CLI not found.",
        }),
      ),
    ).toBe(
      "Image generation uses the Codex CLI, which isn't installed. Install it (npm i -g @openai/codex) and sign in with your ChatGPT account, or add an image API key in Settings → Image models.",
    );
  });

  test("no image passes Codex's own explanation through", () => {
    expect(
      imageFailureMessage(
        new ImageNotProduced({
          provider: "codex",
          detail: "I can't create images of real people.",
        }),
      ),
    ).toBe(
      "Codex finished without producing an image: I can't create images of real people.",
    );
  });
});

describe("API-key provider failures", () => {
  test("a rate limit asks the user to wait", () => {
    expect(
      imageFailureMessage(
        new ImageRateLimited({
          provider: "openai",
          detail: "Rate limit reached.",
        }),
      ),
    ).toBe(
      "OpenAI is rate-limiting image requests. Wait a minute and try again.",
    );
  });

  test("an exhausted quota points to the provider's billing", () => {
    expect(
      imageFailureMessage(
        new ImageQuotaExhausted({
          provider: "openrouter",
          detail: "Insufficient credits.",
        }),
      ),
    ).toBe(
      "Your OpenRouter account is out of credits (Insufficient credits). Top up with OpenRouter, or choose another default in Settings → Image models.",
    );
  });

  test("a rejected key points to the key in Settings", () => {
    expect(
      imageFailureMessage(
        new ImageAuthFailed({
          provider: "gemini",
          reason: "invalid",
          detail: "API key not valid.",
        }),
      ),
    ).toBe(
      "Google Gemini rejected the API key (API key not valid). Check or replace it in Settings → Image models.",
    );
  });

  test("a safety block suggests rephrasing", () => {
    expect(
      imageFailureMessage(
        new ImageContentBlocked({
          provider: "fal",
          detail: "content_policy_violation",
        }),
      ),
    ).toBe(
      "fal.ai's safety filter declined this image (content_policy_violation). Try rephrasing the prompt.",
    );
  });

  test("anything else names the provider and its own words", () => {
    expect(
      imageFailureMessage(
        new ImageProviderError({
          provider: "openai",
          detail: "The server is overloaded.",
          status: 503,
          transient: true,
        }),
      ),
    ).toBe("OpenAI couldn't generate the image: The server is overloaded.");
  });
});
