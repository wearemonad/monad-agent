import { randomBytes } from "node:crypto";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  Layer,
} from "effect";

/** One Google sign-in, reduced to the parts that differ per caller. */
export interface AuthorizationFlow<T, A> {
  /** Google's consent URL for this attempt's loopback redirect and state. */
  readonly consentUrl: (redirectUri: string, state: string) => string;
  /** Show the consent URL to the user (opens the browser). */
  readonly open: (url: string) => void;
  /** Trade the code for tokens. The signal aborts when the attempt is
   *  superseded or the app quits. */
  readonly exchange: (
    code: string,
    redirectUri: string,
    signal: AbortSignal,
  ) => Promise<T>;
  /** Check and store the tokens. Runs only while the attempt is current, so
   *  a superseded or abandoned sign-in never writes anything. */
  readonly finish: (tokens: T) => A;
}

export class GoogleSignInFailed extends Data.TaggedError("GoogleSignInFailed")<{
  readonly message: string;
}> {}

/** No keep-alive: once the wait is over the server stops gracefully (so this
 *  page still reaches the browser), and a kept-alive connection would go on
 *  serving stale redirects. */
const CLOSE = { Connection: "close" };

function page(text: string): Response {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:3rem;text-align:center"><h2>${text}</h2></body></html>`,
    { headers: { "Content-Type": "text/html", ...CLOSE } },
  );
}

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Serve the loopback redirect until Google sends the browser back with a
 *  code. The server lives exactly as long as the wait. */
const awaitCode = <T, A>(flow: AuthorizationFlow<T, A>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = randomBytes(16).toString("base64url");
      const code = yield* Deferred.make<string, GoogleSignInFailed>();
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (req) => {
              const url = new URL(req.url);
              if (url.pathname !== "/callback")
                return new Response("Not found", {
                  status: 404,
                  headers: CLOSE,
                });
              const err = url.searchParams.get("error");
              const got = url.searchParams.get("code");
              if (err || !got || url.searchParams.get("state") !== state) {
                Deferred.doneUnsafe(
                  code,
                  Effect.fail(
                    new GoogleSignInFailed({
                      message: `Google sign-in failed: ${err ?? "invalid response"}`,
                    }),
                  ),
                );
                return page("Sign-in failed. You can close this tab.");
              }
              Deferred.doneUnsafe(code, Effect.succeed(got));
              return page(
                "Monad is connected to Google Drive. You can close this tab.",
              );
            },
          }),
        ),
        (server) => Effect.sync(() => void server.stop()),
      );
      const redirectUri = `http://127.0.0.1:${server.port}/callback`;
      flow.open(flow.consentUrl(redirectUri, state));
      return { code: yield* Deferred.await(code), redirectUri };
    }),
  ).pipe(
    // The browser can sit on one of Google's pages forever (e.g. "Access
    // blocked"), which never redirects.
    Effect.timeoutOrElse({
      duration: SIGN_IN_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new GoogleSignInFailed({
            message: "Google sign-in timed out (5 minutes).",
          }),
        ),
    }),
  );

const signIn = <T, A>(flow: AuthorizationFlow<T, A>) =>
  Effect.gen(function* () {
    const { code, redirectUri } = yield* awaitCode(flow);
    const tokens = yield* Effect.tryPromise({
      try: (signal) => flow.exchange(code, redirectUri, signal),
      catch: (e) =>
        new GoogleSignInFailed({
          message: e instanceof Error ? e.message : String(e),
        }),
    });
    return yield* Effect.try({
      try: () => flow.finish(tokens),
      catch: (e) =>
        new GoogleSignInFailed({
          message: e instanceof Error ? e.message : String(e),
        }),
    });
  });

export class GoogleOAuth extends Context.Service<
  GoogleOAuth,
  {
    readonly authorize: <T, A>(flow: AuthorizationFlow<T, A>) => Promise<A>;
  }
>()("monad/GoogleOAuth") {
  static readonly layer = Layer.effect(
    GoogleOAuth,
    Effect.gen(function* () {
      const handle = yield* FiberHandle.make();
      const fork = yield* FiberHandle.runtime(handle)<never>();
      return {
        authorize: <T, A>(flow: AuthorizationFlow<T, A>) =>
          Effect.runPromise(Fiber.await(fork(signIn(flow)))).then((exit) => {
            if (Exit.isSuccess(exit)) return exit.value;
            if (Cause.hasInterruptsOnly(exit.cause))
              throw new Error("superseded");
            throw Cause.squash(exit.cause);
          }),
      };
    }),
  );
}
