import { Context, Data, Effect, FiberSet, Layer } from "effect";

/** Shape of the OAuth/Gaxios errors the Google libraries throw. Only the parts
 *  read below — the libraries type these loosely themselves. */
type GoogleErrorish = {
  message?: string;
  response?: {
    status?: number;
    data?: unknown;
    headers?: Headers | Record<string, string | undefined>;
  };
};

/** Compact one-line message for the UI/agent ("Google API 404: …"). */
export function googleErrorMessage(e: unknown): string {
  const err = e as GoogleErrorish;
  const status = err?.response?.status;
  const data = err?.response?.data;
  const detail =
    typeof data === "string" ? data : data ? JSON.stringify(data) : "";
  if (status) return `Google API ${status}: ${detail.slice(0, 200)}`;
  return err?.message ?? String(e);
}

/** Google is down or unreachable for now: a 5xx, a 408, or no response.
 *  `retryAfterMs` is its Retry-After, when it sent one. */
export class GoogleTransient extends Data.TaggedError("GoogleTransient")<{
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly cause: unknown;
}> {}

/** The refresh token itself is dead (revoked, expired, or the grant was
 *  withdrawn). Never recovers by retrying — the workspace must reconnect. */
export class GoogleGrantRevoked extends Data.TaggedError("GoogleGrantRevoked")<{
  readonly message: string;
  readonly status?: number;
  /** Google's "expired or revoked" wording — for an OAuth client still in
   *  Testing mode, the 7-day token expiry. */
  readonly expiredOrRevoked: boolean;
  readonly cause: unknown;
}> {}

/** Google asked us to slow down (429). `retryAfterMs` is its Retry-After. */
export class GoogleRateLimited extends Data.TaggedError("GoogleRateLimited")<{
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly cause: unknown;
}> {}

/** Google refused this request (401/403 that isn't a rate limit): a missing
 *  scope, a file the account can't see. Retrying won't change it. */
export class GoogleAccessDenied extends Data.TaggedError("GoogleAccessDenied")<{
  readonly message: string;
  readonly status?: number;
  readonly cause: unknown;
}> {}

/** Anything else: a 4xx that retrying won't fix, or an error raised before
 *  the request reached Google (e.g. the workspace isn't connected). */
export class GooglePermanent extends Data.TaggedError("GooglePermanent")<{
  readonly message: string;
  readonly status?: number;
  readonly cause: unknown;
}> {}

export type GoogleFailure =
  | GoogleTransient
  | GoogleRateLimited
  | GoogleGrantRevoked
  | GoogleAccessDenied
  | GooglePermanent;

/** True when Google says the refresh token itself is dead — as opposed to a
 *  transient/API-level failure. Deliberately narrow: a network failure (wake
 *  from sleep, captive portal) or a 5xx must NOT match, or a healthy grant
 *  would be thrown away. */
function isInvalidGrant(err: GoogleErrorish): boolean {
  const data = err?.response?.data as { error?: string } | undefined;
  return (
    data?.error === "invalid_grant" || /invalid_grant/.test(err?.message ?? "")
  );
}

/** Google's wording when a refresh token has expired — which, for an OAuth
 *  client whose consent screen is still in "Testing", happens 7 days after
 *  every consent. Indistinguishable from the user revoking access in their
 *  Google account. */
function isExpiredOrRevoked(err: GoogleErrorish): boolean {
  const data = err?.response?.data as
    | { error_description?: string }
    | undefined;
  return /expired or revoked/i.test(
    `${data?.error_description ?? ""} ${err?.message ?? ""}`,
  );
}

/** Drive and Gmail report per-user rate limits as a 403 with this reason. */
function isRateLimitReason(err: GoogleErrorish): boolean {
  const data = err?.response?.data as
    | { error?: { errors?: { reason?: string }[] } }
    | undefined;
  return (data?.error?.errors ?? []).some(
    (x) =>
      x.reason === "rateLimitExceeded" || x.reason === "userRateLimitExceeded",
  );
}

/** Retry-After in ms: delay-seconds or an HTTP date. */
function retryAfterMs(err: GoogleErrorish): number | undefined {
  const headers = err?.response?.headers;
  const raw =
    headers instanceof Headers
      ? headers.get("retry-after")
      : (headers?.["retry-after"] ?? headers?.["Retry-After"]);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** The request never got a response: gaxios under Bun reports a refused or
 *  dropped connection as a GaxiosError with no response, Node's fetch as a
 *  "fetch failed" TypeError. Anything else without a status is a local error
 *  (e.g. the workspace isn't connected) and retrying can't help. */
function isNoResponse(e: unknown): boolean {
  const err = e as GoogleErrorish & { name?: string };
  if (err?.response) return false;
  return (
    err?.name === "GaxiosError" ||
    (e instanceof TypeError && err.message === "fetch failed")
  );
}

/** Sort a thrown Google error into what the caller can do about it, keeping
 *  the status and the original error. */
export function classifyGoogleError(e: unknown): GoogleFailure {
  const err = e as GoogleErrorish;
  const fields = {
    message: googleErrorMessage(e),
    status: err?.response?.status,
    cause: e,
  };
  if (isInvalidGrant(err)) {
    return new GoogleGrantRevoked({
      ...fields,
      expiredOrRevoked: isExpiredOrRevoked(err),
    });
  }
  const status = fields.status;
  if (status === 429 || (status === 403 && isRateLimitReason(err))) {
    return new GoogleRateLimited({
      ...fields,
      retryAfterMs: retryAfterMs(err),
    });
  }
  if (
    isNoResponse(e) ||
    (status !== undefined && (status === 408 || status >= 500))
  ) {
    return new GoogleTransient({ ...fields, retryAfterMs: retryAfterMs(err) });
  }
  if (status === 401 || status === 403) return new GoogleAccessDenied(fields);
  return new GooglePermanent(fields);
}

/** Waits before retry 1, 2 and 3 of a read. Three at most: a read that still
 *  fails is reported, and the loop or the user tries again later. */
const BACKOFF_MS = [1_000, 2_000, 4_000];
/** A longer Retry-After isn't waited out: it would hold a sync loop or an
 *  RPC call for minutes. */
const MAX_RETRY_AFTER_MS = 60_000;

/** How long to wait before retry number `retries` (0-based), or undefined
 *  when this failure isn't worth retrying. */
function retryDelay(
  failure: GoogleFailure,
  retries: number,
): number | undefined {
  if (retries >= BACKOFF_MS.length) return undefined;
  switch (failure._tag) {
    case "GoogleTransient":
    case "GoogleRateLimited":
      if (failure.retryAfterMs === undefined) return BACKOFF_MS[retries];
      return failure.retryAfterMs <= MAX_RETRY_AFTER_MS
        ? failure.retryAfterMs
        : undefined;
    default:
      return undefined;
  }
}

/** One Google request as an Effect. Interrupting it aborts `signal`. */
export function googleRequest<A>(
  fn: (signal: AbortSignal) => Promise<A>,
  opts: { retry: boolean },
): Effect.Effect<A, GoogleFailure> {
  const attempt = (retries: number): Effect.Effect<A, GoogleFailure> =>
    Effect.tryPromise({ try: fn, catch: classifyGoogleError }).pipe(
      Effect.catch((failure) => {
        const delay = opts.retry ? retryDelay(failure, retries) : undefined;
        if (delay === undefined) return Effect.fail(failure);
        return Effect.logWarning(
          `[google] ${failure.message} — retry ${retries + 1} of ${BACKOFF_MS.length} in ${Math.round(delay / 1000)}s`,
        ).pipe(
          Effect.andThen(Effect.sleep(delay)),
          Effect.andThen(attempt(retries + 1)),
        );
      }),
    );
  return attempt(0);
}

/** Owner of every Google request in the backend. Each runs as a fiber of the
 *  app runtime, so quitting aborts the ones in flight (their HTTP requests
 *  included) and refuses new ones. */
export class GoogleOperations extends Context.Service<
  GoogleOperations,
  {
    /** Run one request. `retry` is for reads only (get, list, download):
     *  sends, deletes and creates are attempted exactly once. Rejects with a
     *  GoogleFailure, whose message is the UI's. */
    readonly request: <A>(
      fn: (signal: AbortSignal) => Promise<A>,
      opts?: { retry?: boolean },
    ) => Promise<A>;
  }
>()("monad/GoogleOperations") {
  static readonly layer = Layer.effect(
    GoogleOperations,
    Effect.gen(function* () {
      const fibers = yield* FiberSet.make();
      const run = yield* FiberSet.runtimePromise(fibers)<never>();
      return {
        request: (fn, opts) =>
          run(googleRequest(fn, { retry: opts?.retry ?? false })),
      };
    }),
  );
}

/** The health check's line for a failed access check. Only failures that a
 *  reconnect can fix ask for one; Google being unreachable or busy doesn't. */
export function googleAccessIssue(e: unknown): string {
  const failure =
    e instanceof GoogleTransient ||
    e instanceof GoogleRateLimited ||
    e instanceof GoogleGrantRevoked ||
    e instanceof GoogleAccessDenied ||
    e instanceof GooglePermanent
      ? e
      : classifyGoogleError(e);
  const detail = failure.message.slice(0, 80);
  return failure._tag === "GoogleTransient" ||
    failure._tag === "GoogleRateLimited"
    ? `Couldn't reach Google to check access (${detail}) — will check again later.`
    : `Google token check failed (${detail}) — reconnect in Settings.`;
}
