import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DriveEvent } from "../../shared/ipc";
import {
  GOOGLE_DISCONNECT_DETAIL,
  GOOGLE_TESTING_MODE_HINT,
  GoogleDriveService,
} from "./GoogleDriveService";
import { Keychain } from "./Keychain";

// The Keychain shells out to macOS `security`; stub it so these stay hermetic.
const realDelete = Keychain.delete;
let deleted: string[];
let events: DriveEvent[];
let svc: GoogleDriveService;

beforeEach(() => {
  deleted = [];
  events = [];
  Keychain.delete = (service: string) => {
    deleted.push(service);
  };
  svc = new GoogleDriveService({} as never, (e) => events.push(e));
});

afterEach(() => {
  Keychain.delete = realDelete;
});

/** Shaped like the errors gaxios/google-auth-library actually throw. */
const gaxiosError = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

test("a dead refresh token disconnects the workspace and tells the UI", async () => {
  const err = gaxiosError(400, { error: "invalid_grant" });
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow();
  expect(deleted.length).toBe(1);
  expect(events).toEqual([
    {
      workspaceId: "ws1",
      status: "disconnected",
      detail: "Google access expired — reconnect in Settings.",
    },
  ]);
});

test("invalid_grant is also recognised when it only appears in the message", async () => {
  const err = new Error("invalid_grant: Token has been expired or revoked.");
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow();
  expect(deleted.length).toBe(1);
  expect(events[0]?.status).toBe("disconnected");
});

test("an expired/revoked token adds the Testing-mode hint to the disconnect", async () => {
  // Exactly what Google returns 7 days after consent while the OAuth consent
  // screen is in "Testing" — the usual cause of "it keeps disconnecting".
  const err = gaxiosError(400, {
    error: "invalid_grant",
    error_description: "Token has been expired or revoked.",
  });
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow();
  expect(deleted.length).toBe(1);
  expect(events[0]?.status).toBe("disconnected");
  expect(events[0]?.detail).toBe(
    `${GOOGLE_DISCONNECT_DETAIL} ${GOOGLE_TESTING_MODE_HINT}`,
  );
});

test("a network failure (e.g. waking from sleep) keeps the stored grant", async () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ENOTFOUND" },
  });
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow(
    "fetch failed",
  );
  expect(deleted).toEqual([]);
  expect(events).toEqual([]);
});

test("a network failure as Bun actually reports it keeps the stored grant", async () => {
  // Under Bun, gaxios surfaces connection and DNS failures as a GaxiosError
  // with code "ConnectionRefused" and no response — not Node's TypeError.
  const err = Object.assign(
    new Error("Unable to connect. Is the computer able to access the url?"),
    { name: "GaxiosError", code: "ConnectionRefused" },
  );
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow(
    "Unable to connect",
  );
  expect(deleted).toEqual([]);
  expect(events).toEqual([]);
});

test("a 5xx from Google keeps the stored grant", async () => {
  const err = gaxiosError(503, { error: { message: "Backend Error" } });
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow(
    "Google API 503",
  );
  expect(deleted).toEqual([]);
  expect(events).toEqual([]);
});

test("an ordinary API failure neither disconnects nor emits", async () => {
  const err = gaxiosError(404, { error: { message: "File not found" } });
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow(
    "Google API 404",
  );
  expect(deleted).toEqual([]);
  expect(events).toEqual([]);
});

test("the thrown message keeps the status and body, as the old client did", async () => {
  const err = gaxiosError(403, { error: { message: "Rate limit" } });
  await expect(svc.call("ws1", () => Promise.reject(err))).rejects.toThrow(
    /Google API 403: .*Rate limit/,
  );
});

test("a success passes straight through", async () => {
  await expect(svc.call("ws1", () => Promise.resolve(42))).resolves.toBe(42);
  expect(events).toEqual([]);
});
