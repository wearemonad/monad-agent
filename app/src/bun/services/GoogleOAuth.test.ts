import { afterEach, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { type AuthorizationFlow, GoogleOAuth } from "./GoogleOAuth";

let rt: ManagedRuntime.ManagedRuntime<GoogleOAuth | TestClock.TestClock, never>;
afterEach(() => rt?.dispose());

async function setup() {
  rt = ManagedRuntime.make(
    GoogleOAuth.layer.pipe(Layer.provideMerge(TestClock.layer())),
  );
  const oauth = await rt.runPromise(Effect.service(GoogleOAuth));
  const advance = async (ms: number) => {
    await rt.runPromise(TestClock.adjust(ms));
    await settle();
  };
  return { oauth, advance };
}

const settle = () => Bun.sleep(5);

/** A sign-in attempt whose browser and token endpoint the test drives. */
function fakeFlow() {
  const attempt = {
    consentUrl: "",
    exchanged: [] as string[],
    exchangeSignal: undefined as AbortSignal | undefined,
    finished: [] as string[],
    /** Resolves the pending token exchange (default: at once). */
    release: undefined as (() => void) | undefined,
    holdExchange: false,
  };
  const flow: AuthorizationFlow<string, string> = {
    consentUrl: (redirectUri, state) =>
      `${redirectUri}?state=${encodeURIComponent(state)}`,
    open: (url) => {
      attempt.consentUrl = url;
    },
    exchange: (code, _redirectUri, signal) => {
      attempt.exchanged.push(code);
      attempt.exchangeSignal = signal;
      if (!attempt.holdExchange) return Promise.resolve(`tokens-for-${code}`);
      return new Promise((resolve) => {
        attempt.release = () => resolve(`tokens-for-${code}`);
      });
    },
    finish: (tokens) => {
      attempt.finished.push(tokens);
      return `connected with ${tokens}`;
    },
  };
  /** The browser following Google's redirect back to the loopback server. */
  const redirect = (params: Record<string, string>) => {
    const consent = new URL(attempt.consentUrl);
    const back = new URL(`${consent.origin}${consent.pathname}`);
    for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v);
    return fetch(back).then(
      (res) => res.text(),
      () => "unreachable",
    );
  };
  const state = () => new URL(attempt.consentUrl).searchParams.get("state")!;
  return { flow, attempt, redirect, state };
}

function track<A>(p: Promise<A>) {
  const s: { value?: A; error?: unknown; done: boolean } = { done: false };
  p.then(
    (value) => Object.assign(s, { value, done: true }),
    (error) => Object.assign(s, { error, done: true }),
  );
  return s;
}

test("the browser's redirect completes the sign-in, then the loopback server closes", async () => {
  const { oauth } = await setup();
  const { flow, attempt, redirect, state } = fakeFlow();
  const result = track(oauth.authorize(flow));
  await settle();
  expect(attempt.consentUrl).toStartWith("http://127.0.0.1:");

  const page = await redirect({ code: "abc", state: state() });
  expect(page).toContain("connected");
  await settle();
  expect(result.value).toBe("connected with tokens-for-abc");
  expect(attempt.finished).toEqual(["tokens-for-abc"]);
  expect(await redirect({ code: "again", state: state() })).toBe("unreachable");
});

test("a denied consent or a forged state fails the sign-in, exchanges nothing and closes the server", async () => {
  const { oauth } = await setup();
  for (const [params, message] of [
    [{ error: "access_denied" }, "Google sign-in failed: access_denied"],
    [
      { code: "abc", state: "forged" },
      "Google sign-in failed: invalid response",
    ],
  ] as const) {
    const { flow, attempt, redirect, state } = fakeFlow();
    const result = track(oauth.authorize(flow));
    await settle();
    const realState = state();
    expect(await redirect(params)).toContain("Sign-in failed");
    await settle();
    expect((result.error as Error)?.message).toBe(message);
    expect(attempt.exchanged).toEqual([]);
    expect(await redirect({ code: "late", state: realState })).toBe(
      "unreachable",
    );
  }
});

test("a sign-in left on Google's page times out after 5 minutes and closes the server", async () => {
  const { oauth, advance } = await setup();
  const { flow, redirect, state } = fakeFlow();
  const result = track(oauth.authorize(flow));
  await settle();
  const realState = state();
  await advance(5 * 60_000 - 1);
  expect(result.done).toBe(false);
  await advance(1);
  expect((result.error as Error)?.message).toBe(
    "Google sign-in timed out (5 minutes).",
  );
  expect(await redirect({ code: "late", state: realState })).toBe(
    "unreachable",
  );
});

test("a retried click supersedes the stalled attempt and closes its server", async () => {
  const { oauth } = await setup();
  const first = fakeFlow();
  const firstResult = track(oauth.authorize(first.flow));
  await settle();
  const firstState = first.state();

  const second = fakeFlow();
  const secondResult = track(oauth.authorize(second.flow));
  await settle();
  expect((firstResult.error as Error)?.message).toBe("superseded");
  expect(await first.redirect({ code: "old", state: firstState })).toBe(
    "unreachable",
  );

  await second.redirect({ code: "new", state: second.state() });
  await settle();
  expect(secondResult.value).toBe("connected with tokens-for-new");
  expect(first.attempt.finished).toEqual([]);
});

test("an exchange that completes after its attempt was superseded writes nothing", async () => {
  const { oauth } = await setup();
  const first = fakeFlow();
  first.attempt.holdExchange = true;
  const firstResult = track(oauth.authorize(first.flow));
  await settle();
  await first.redirect({ code: "old", state: first.state() });
  await settle();
  expect(first.attempt.exchanged).toEqual(["old"]);

  track(oauth.authorize(fakeFlow().flow));
  await settle();
  expect(first.attempt.exchangeSignal?.aborted).toBe(true);
  first.attempt.release?.();
  await settle();
  expect((firstResult.error as Error)?.message).toBe("superseded");
  expect(first.attempt.finished).toEqual([]);
});

test("quitting abandons a pending sign-in: server closed, nothing written", async () => {
  const { oauth } = await setup();
  const { flow, attempt, redirect, state } = fakeFlow();
  const result = track(oauth.authorize(flow));
  await settle();
  const realState = state();
  await rt.dispose();
  await settle();
  expect(result.done).toBe(true);
  expect(await redirect({ code: "late", state: realState })).toBe(
    "unreachable",
  );
  expect(attempt.finished).toEqual([]);
});
