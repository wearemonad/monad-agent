import { Data } from "effect";
import { IMAGE_SOURCE_LABELS, type ImageSource } from "../../../shared/images";

/** Every way an image request can fail, sorted by what the user can do about
 *  it. Each carries the provider that failed and its own wording (`detail`). */

/** Slow down: a per-minute rate limit, or the ChatGPT plan's usage window.
 *  `retryAt` is the provider's own "try again at/in …" wording, when given. */
export class ImageRateLimited extends Data.TaggedError("ImageRateLimited")<{
  readonly provider: ImageSource;
  readonly detail: string;
  readonly retryAt?: string;
}> {}

/** Out of credits or quota — waiting won't fix it, billing will. */
export class ImageQuotaExhausted extends Data.TaggedError(
  "ImageQuotaExhausted",
)<{
  readonly provider: ImageSource;
  readonly detail: string;
}> {}

/** The credential is unusable. `expired`: a sign-in session that needs
 *  renewing (Codex); `invalid`: a rejected API key; `signed-out`: no login. */
export class ImageAuthFailed extends Data.TaggedError("ImageAuthFailed")<{
  readonly provider: ImageSource;
  readonly reason: "expired" | "invalid" | "signed-out";
  readonly detail: string;
}> {}

/** The provider's safety system refused the prompt or the output. */
export class ImageContentBlocked extends Data.TaggedError(
  "ImageContentBlocked",
)<{
  readonly provider: ImageSource;
  readonly detail: string;
}> {}

/** The provider can't run here at all (the Codex CLI isn't installed). */
export class ImageProviderUnavailable extends Data.TaggedError(
  "ImageProviderUnavailable",
)<{
  readonly provider: ImageSource;
  readonly detail: string;
}> {}

/** The request "succeeded" but produced no image. */
export class ImageNotProduced extends Data.TaggedError("ImageNotProduced")<{
  readonly provider: ImageSource;
  readonly detail: string;
}> {}

/** Anything else. `transient` = worth retrying (5xx, network). */
export class ImageProviderError extends Data.TaggedError("ImageProviderError")<{
  readonly provider: ImageSource;
  readonly detail: string;
  readonly status?: number;
  readonly transient: boolean;
}> {}

export type ImageFailure =
  | ImageRateLimited
  | ImageQuotaExhausted
  | ImageAuthFailed
  | ImageContentBlocked
  | ImageProviderUnavailable
  | ImageNotProduced
  | ImageProviderError;

const CODEX_SIGN_IN =
  "Settings → Providers → OpenAI (or run `codex login` in a terminal)";
const ADD_KEY = "add an image API key in Settings → Image models";

/** The sentence the user reads: what went wrong and the one thing that
 *  fixes it. The agent relays it as-is. */
export function imageFailureMessage(f: ImageFailure): string {
  const name = IMAGE_SOURCE_LABELS[f.provider];
  const codex = f.provider === "codex";
  switch (f._tag) {
    case "ImageRateLimited": {
      const when = f.retryAt ? `Try again ${f.retryAt}` : "Try again later";
      return codex
        ? `You've reached your ChatGPT plan's usage limit for image generation. ${when}, or ${ADD_KEY}.`
        : `${name} is rate-limiting image requests. ${f.retryAt ? when : "Wait a minute and try again"}.`;
    }
    case "ImageAuthFailed":
      if (codex) {
        return f.reason === "expired"
          ? `Your Codex sign-in has expired. Sign in again in ${CODEX_SIGN_IN}, then retry.`
          : `Codex isn't signed in. Sign in in ${CODEX_SIGN_IN}, or ${ADD_KEY}.`;
      }
      return `${name} rejected the API key (${brief(f.detail)}). Check or replace it in Settings → Image models.`;
    case "ImageQuotaExhausted":
      return `Your ${name} account is out of credits (${brief(f.detail)}). Top up with ${name}, or choose another default in Settings → Image models.`;
    case "ImageContentBlocked":
      return `${name}'s safety filter declined this image (${brief(f.detail)}). Try rephrasing the prompt.`;
    case "ImageProviderUnavailable":
      return `Image generation uses the Codex CLI, which isn't installed. Install it (npm i -g @openai/codex) and sign in with your ChatGPT account, or ${ADD_KEY}.`;
    case "ImageNotProduced":
      return `${name} finished without producing an image: ${f.detail}`;
    case "ImageProviderError":
      return `${name} couldn't generate the image: ${f.detail}`;
  }
}

/** A provider's wording, short enough for a parenthetical. */
function brief(detail: string): string {
  const t = detail.trim().replace(/\.$/, "");
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}
