import { afterEach, expect, test } from "bun:test";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import {
  classifyGoogleError,
  GoogleOperations,
  googleAccessIssue,
} from "./GoogleOperations";

let rt: ManagedRuntime.ManagedRuntime<
  GoogleOperations | TestClock.TestClock,
  never
>;
afterEach(() => rt?.dispose());

let logs: string[] = [];

async function setup() {
  logs = [];
  rt = ManagedRuntime.make(
    GoogleOperations.layer.pipe(
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(
        Logger.layer([
          Logger.make((o) => {
            const parts = Array.isArray(o.message) ? o.message : [o.message];
            logs.push(`${o.logLevel} ${parts.join(" ")}`);
          }),
        ]),
      ),
    ),
  );
  const google = await rt.runPromise(Effect.service(GoogleOperations));
  const advance = async (ms: number) => {
    await rt.runPromise(TestClock.adjust(ms));
    await settle();
  };
  return { google, advance };
}

/** Let fibers and the fake request's promises settle. */
const settle = () => Bun.sleep(1);

/** Shaped like the errors gaxios/google-auth-library actually throw. */
const gaxiosError = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    name: "GaxiosError",
    response: { status, data, headers: new Headers(headers) },
  });

/** A fake Google endpoint: each attempt takes the next scripted reply. */
function scripted<A>(...replies: (A | Error)[]) {
  const attempts: AbortSignal[] = [];
  const fn = (signal: AbortSignal): Promise<A> => {
    attempts.push(signal);
    const reply = replies[Math.min(attempts.length, replies.length) - 1];
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply as A);
  };
  return { fn, attempts };
}

/** Track a promise's state without awaiting it. */
function track<A>(p: Promise<A>) {
  const state: { value?: A; error?: unknown; done: boolean } = { done: false };
  p.then(
    (value) => Object.assign(state, { value, done: true }),
    (error) => Object.assign(state, { error, done: true }),
  );
  return state;
}

test("a read that hits a 503 is retried and returns once Google recovers", async () => {
  const { google, advance } = await setup();
  const api = scripted<number>(gaxiosError(503, { error: "backend" }), 42);
  const result = track(google.request(api.fn, { retry: true }));
  await settle();
  expect(api.attempts.length).toBe(1);
  await advance(1_000);
  expect(result).toEqual({ value: 42, done: true });
  expect(api.attempts.length).toBe(2);
});

test("a read gives up after three retries, spaced 1 s, 2 s and 4 s, keeping the status", async () => {
  const { google, advance } = await setup();
  const api = scripted<number>(gaxiosError(503, { error: "backend" }));
  const result = track(google.request(api.fn, { retry: true }));
  await settle();
  for (const [wait, attemptsAfter] of [
    [999, 1],
    [1, 2],
    [1_999, 2],
    [1, 3],
    [3_999, 3],
    [1, 4],
  ] as const) {
    await advance(wait);
    expect(api.attempts.length).toBe(attemptsAfter);
  }
  expect(result.done).toBe(true);
  expect(result.error).toMatchObject({
    _tag: "GoogleTransient",
    status: 503,
    message: 'Google API 503: {"error":"backend"}',
  });
  await advance(60_000);
  expect(api.attempts.length).toBe(4);
});

test("a revoked grant fails at once and is never retried", async () => {
  const { google, advance } = await setup();
  const api = scripted<number>(
    gaxiosError(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }),
  );
  const result = track(google.request(api.fn, { retry: true }));
  await advance(60_000);
  expect(api.attempts.length).toBe(1);
  expect(result.error).toMatchObject({
    _tag: "GoogleGrantRevoked",
    status: 400,
    expiredOrRevoked: true,
  });
});

test("invalid_grant is also recognised when it only appears in the message", async () => {
  const { google, advance } = await setup();
  const api = scripted<number>(new Error("invalid_grant: bad token"));
  const result = track(google.request(api.fn, { retry: true }));
  await advance(60_000);
  expect(api.attempts.length).toBe(1);
  expect(result.error).toMatchObject({
    _tag: "GoogleGrantRevoked",
    expiredOrRevoked: false,
  });
});

test("a permanent failure (404, or an error raised before reaching Google) is not retried", async () => {
  const { google, advance } = await setup();
  for (const err of [
    gaxiosError(404, { error: { message: "File not found" } }),
    new Error("Google Drive is not connected for this workspace."),
  ]) {
    const api = scripted<number>(err);
    const result = track(google.request(api.fn, { retry: true }));
    await advance(60_000);
    expect(api.attempts.length).toBe(1);
    expect(result.error).toMatchObject({
      _tag: "GooglePermanent",
      message: googleMessageOf(err),
    });
  }
});

const googleMessageOf = (err: Error & { response?: { status: number } }) =>
  err.response
    ? 'Google API 404: {"error":{"message":"File not found"}}'
    : err.message;

test("a network failure with no response (e.g. waking from sleep) is retried", async () => {
  const { google, advance } = await setup();
  for (const err of [
    // Under Bun, gaxios reports connection/DNS failures like this.
    Object.assign(
      new Error("Unable to connect. Is the computer able to access the url?"),
      { name: "GaxiosError", code: "ConnectionRefused" },
    ),
    // Node's fetch.
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    }),
  ]) {
    const api = scripted<string>(err, "ok");
    const result = track(google.request(api.fn, { retry: true }));
    await advance(1_000);
    expect(api.attempts.length).toBe(2);
    expect(result.value).toBe("ok");
  }
});

test("a 429 waits for Retry-After instead of the default backoff", async () => {
  const { google, advance } = await setup();
  const api = scripted<string>(
    gaxiosError(429, { error: "slow down" }, { "Retry-After": "5" }),
    "ok",
  );
  const result = track(google.request(api.fn, { retry: true }));
  await advance(4_999);
  expect(api.attempts.length).toBe(1);
  await advance(1);
  expect(api.attempts.length).toBe(2);
  expect(result.value).toBe("ok");
});

test("a 403 rate-limit reason is retried; any other 403 is access denied, not retried", async () => {
  const { google, advance } = await setup();
  const forbidden = (reason: string) =>
    gaxiosError(403, {
      error: { code: 403, message: reason, errors: [{ reason }] },
    });

  const limited = scripted<string>(forbidden("userRateLimitExceeded"), "ok");
  const ok = track(google.request(limited.fn, { retry: true }));
  await advance(1_000);
  expect(limited.attempts.length).toBe(2);
  expect(ok.value).toBe("ok");

  const denied = scripted<string>(forbidden("insufficientPermissions"));
  const result = track(google.request(denied.fn, { retry: true }));
  await advance(60_000);
  expect(denied.attempts.length).toBe(1);
  expect(result.error).toMatchObject({
    _tag: "GoogleAccessDenied",
    status: 403,
  });
});

test("a Retry-After over a minute fails at once, keeping the delay for the caller", async () => {
  const { google, advance } = await setup();
  const api = scripted<string>(
    gaxiosError(429, { error: "quota" }, { "Retry-After": "3600" }),
  );
  const result = track(google.request(api.fn, { retry: true }));
  await advance(1);
  expect(result.done).toBe(true);
  expect(api.attempts.length).toBe(1);
  expect(result.error).toMatchObject({
    _tag: "GoogleRateLimited",
    retryAfterMs: 3_600_000,
  });
});

test("a write is never retried: a 503 on send is one attempt", async () => {
  const { google, advance } = await setup();
  const api = scripted<string>(gaxiosError(503, { error: "backend" }));
  const result = track(google.request(api.fn));
  await advance(60_000);
  expect(api.attempts.length).toBe(1);
  expect(result.error).toMatchObject({ _tag: "GoogleTransient" });
});

test("quitting aborts a request in flight, and later requests never reach Google", async () => {
  const { google } = await setup();
  const signals: AbortSignal[] = [];
  const hanging = track(
    google.request(
      (signal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      },
      { retry: true },
    ),
  );
  await settle();
  await rt.dispose();
  await settle();
  expect(signals[0]?.aborted).toBe(true);
  expect(hanging.done).toBe(true);
  expect(hanging.error).toBeDefined();

  let reached = false;
  const late = track(
    google.request(async () => {
      reached = true;
      return 1;
    }),
  );
  await settle();
  expect(late.error).toBeDefined();
  expect(reached).toBe(false);
});

test("each retry is logged with the failure and the wait", async () => {
  const { google, advance } = await setup();
  const api = scripted<string>(
    gaxiosError(503, "backend"),
    gaxiosError(429, "slow", { "Retry-After": "7" }),
    "ok",
  );
  track(google.request(api.fn, { retry: true }));
  await advance(1_000);
  await advance(7_000);
  expect(api.attempts.length).toBe(3);
  expect(logs).toEqual([
    "Warn [google] Google API 503: backend — retry 1 of 3 in 1s",
    "Warn [google] Google API 429: slow — retry 2 of 3 in 7s",
  ]);
});

test("a 503 with Retry-After waits for it too", async () => {
  const { google, advance } = await setup();
  const api = scripted<string>(
    gaxiosError(503, "backend", { "Retry-After": "0" }),
    "ok",
  );
  const result = track(google.request(api.fn, { retry: true }));
  await advance(0);
  expect(api.attempts.length).toBe(2);
  expect(result.value).toBe("ok");
});

test("the health check only says 'reconnect' when reconnecting can help", () => {
  const offline = classifyGoogleError(
    Object.assign(new Error("Unable to connect."), { name: "GaxiosError" }),
  );
  expect(googleAccessIssue(offline)).toBe(
    "Couldn't reach Google to check access (Unable to connect.) — will check again later.",
  );
  const limited = classifyGoogleError(gaxiosError(429, "slow"));
  expect(googleAccessIssue(limited)).toStartWith("Couldn't reach Google");
  const denied = classifyGoogleError(gaxiosError(403, "forbidden"));
  expect(googleAccessIssue(denied)).toBe(
    "Google token check failed (Google API 403: forbidden) — reconnect in Settings.",
  );
});
