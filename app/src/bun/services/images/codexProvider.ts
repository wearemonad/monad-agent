import { Codex } from "@openai/codex-sdk";
import { Effect } from "effect";
import type { CodexAuthStrategy } from "../../auth/CodexAuth";
import type { ImageAspect, ImageRequest } from "../../../shared/images";
import type { CodexAuthStatus } from "../../../shared/ipc";
import { findGeneratedImages } from "../CodexAgentService";
import type { ImageProvider } from "./httpProviders";
import {
  ImageAuthFailed,
  type ImageFailure,
  ImageNotProduced,
  ImageProviderError,
  ImageProviderUnavailable,
  ImageRateLimited,
} from "./ImageFailure";

/** One `codex exec` turn on a fresh thread. Resolves with the thread id and
 *  Codex's reply; `failure` is the turn's error message when it failed. */
export type CodexTurn = (
  prompt: string,
  signal: AbortSignal,
) => Promise<{ threadId: string; reply?: string; failure?: string }>;

export type CodexImageOptions = {
  /** $CODEX_HOME — where Codex's image tool leaves its files. */
  home: string;
  /** The installed CLI (CodexCli): where it is, and whether it's signed in. */
  cli: { resolveBinary(): string; status(): CodexAuthStatus };
  runTurn: CodexTurn;
};

const ASPECT_WORDS: Record<ImageAspect, string> = {
  square: "square (1:1)",
  portrait: "portrait (2:3)",
  landscape: "landscape (3:2)",
};

/** The instruction handed to Codex: use the built-in image tool, once, and
 *  do nothing else — no files written, no shell. */
export function codexImagePrompt(req: ImageRequest): string {
  return [
    "Generate exactly one image with your built-in image generation tool (image_gen).",
    "Do not write files, run commands, or edit anything — just generate the image, then reply with one short sentence.",
    `Aspect: ${ASPECT_WORDS[req.aspect ?? "square"]}.`,
    "",
    "Image prompt:",
    req.prompt,
  ].join("\n");
}

/** Codex reports some failures as a JSON body inside the message; the
 *  human sentence is its `message`. */
function unwrapMessage(raw: string): string {
  const start = raw.indexOf("{");
  if (start < 0) return raw.trim();
  try {
    const parsed = JSON.parse(raw.slice(start)) as {
      message?: string;
      error?: { message?: string };
    };
    return (parsed.error?.message ?? parsed.message ?? raw).trim();
  } catch {
    return raw.trim();
  }
}

/** Sort a failed Codex turn's message into what the user can do about it.
 *  Matches the CLI's own wording (codex-cli 0.16x). */
export function classifyCodexFailure(raw: string): ImageFailure {
  const detail = unwrapMessage(raw);
  if (/usage limit/i.test(detail)) {
    const retryAt = /try again ((?:at|in) [^.\n]+)/i.exec(detail)?.[1]?.trim();
    return new ImageRateLimited({
      provider: "codex",
      detail,
      ...(retryAt ? { retryAt } : {}),
    });
  }
  if (EXPIRED_SESSION.test(detail)) {
    return new ImageAuthFailed({
      provider: "codex",
      reason: "expired",
      detail,
    });
  }
  return new ImageProviderError({
    provider: "codex",
    detail,
    transient: false,
  });
}

/** The ChatGPT sign-in Codex rides has lapsed: its token refresh failed, or
 *  the backend rejected the token. Only `codex login` fixes it. */
const EXPIRED_SESSION =
  /could not be refreshed|sign(ing)? in again|token[_ ](is )?expired|authentication token is expired|refresh token/i;

/** gpt-image through the user's own Codex CLI and ChatGPT login — the
 *  fallback when no image API key is set. */
export function codexImageProvider(opts: CodexImageOptions): ImageProvider {
  return {
    id: "codex",
    generate: (req) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => opts.cli.resolveBinary(),
          catch: (e) =>
            new ImageProviderUnavailable({
              provider: "codex",
              detail: String((e as Error)?.message ?? e),
            }),
        });
        // A plain "not logged in" is certain; a status check that itself
        // failed (timeout, odd config) is not — let the turn find out.
        const status = opts.cli.status();
        if (!status.loggedIn && !status.error) {
          return yield* new ImageAuthFailed({
            provider: "codex",
            reason: "signed-out",
            detail: "Codex is not signed in.",
          });
        }
        const startedAt = Date.now();
        const turn = yield* Effect.tryPromise({
          try: (signal) => opts.runTurn(codexImagePrompt(req), signal),
          // `codex exec` exiting non-zero surfaces as a throw carrying its
          // stderr — the same wording a failed turn reports.
          catch: (e) =>
            classifyCodexFailure(String((e as Error)?.message ?? e)),
        });
        if (turn.failure) return yield* classifyCodexFailure(turn.failure);
        const images = findGeneratedImages(
          opts.home,
          turn.threadId,
          startedAt - 2_000,
        );
        if (images.length === 0) {
          return yield* new ImageNotProduced({
            provider: "codex",
            detail: turn.reply?.trim() || "Codex finished without an image.",
          });
        }
        return images;
      }),
  };
}

/** The real CodexTurn: one `codex exec` on a fresh thread, read-only, with
 *  no approvals to wait on (exec has no UI to ask). `workingDirectory` is a
 *  scratch folder — the image tool writes under $CODEX_HOME, not there. */
export function sdkCodexTurn(deps: {
  auth: CodexAuthStrategy;
  workingDirectory: () => string;
}): CodexTurn {
  return async (prompt, signal) => {
    const {
      codexPathOverride,
      apiKey,
      env: authEnv,
    } = deps.auth.codexOptions();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...authEnv,
    };
    for (const key of Object.keys(env)) if (env[key] === "") delete env[key];
    const codex = new Codex({
      ...(codexPathOverride ? { codexPathOverride } : {}),
      ...(apiKey ? { apiKey } : {}),
      env,
    });
    const thread = codex.startThread({
      workingDirectory: deps.workingDirectory(),
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    });
    const { events } = await thread.runStreamed(prompt, { signal });
    let threadId = "";
    let reply = "";
    let failure: string | undefined;
    for await (const event of events) {
      if (event.type === "thread.started") threadId = event.thread_id;
      else if (event.type === "turn.failed") failure = event.error.message;
      else if (event.type === "error") failure = event.message;
      else if (
        event.type === "item.completed" &&
        event.item.type === "agent_message"
      ) {
        reply = event.item.text;
      }
    }
    return { threadId, reply, ...(failure ? { failure } : {}) };
  };
}
