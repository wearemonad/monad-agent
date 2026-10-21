import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DriveEvent } from "../../shared/ipc";
import { GoogleDriveService } from "./GoogleDriveService";
import { Keychain } from "./Keychain";

// The real Google SDK clients and OAuth2Client, talking to a local fake
// Google — so retries hidden inside the SDK (gaxios) are counted too.

type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
let replies: Reply[];
let requests: string[];
let server: ReturnType<typeof Bun.serve>;
let svc: GoogleDriveService;
let events: DriveEvent[];
let deleted: string[];
let stored: [string, string][];
/** The consent URL the service asked the browser to open. */
let opened: string[];
/** What the token endpoint answers; null = a fresh access token. */
let tokenReply: Reply | null;
let tokenRequests: number;
/** Per-path replies, checked before the `replies` queue. */
let route: ((path: string) => Reply | undefined) | null;

const realGet = Keychain.get;
const realDelete = Keychain.delete;
const realSet = Keychain.set;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        tokenRequests++;
        if (tokenReply) {
          return Response.json(tokenReply.body, { status: tokenReply.status });
        }
        return Response.json({
          access_token: "access",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      requests.push(`${req.method} ${url.pathname}`);
      const routed = route?.(url.pathname);
      if (routed) return Response.json(routed.body, { status: routed.status });
      const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
      return Response.json(reply.body, {
        status: reply.status,
        headers: reply.headers,
      });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  replies = [];
  requests = [];
  tokenReply = null;
  tokenRequests = 0;
  route = null;
  events = [];
  deleted = [];
  stored = [];
  opened = [];
  Keychain.get = () => "refresh-token";
  Keychain.set = (service: string, value: string) => {
    stored.push([service, value]);
  };
  Keychain.delete = (service: string) => {
    deleted.push(service);
  };
  const base = `http://127.0.0.1:${server.port}`;
  svc = new GoogleDriveService(
    {
      googleClientId: "client-id",
      getGoogleClientSecret: () => "client-secret",
    } as never,
    (e) => events.push(e),
    {
      endpoints: { api: `${base}/`, token: `${base}/token` },
      openBrowser: (url) => opened.push(url),
    },
  );
});

afterEach(() => {
  Keychain.get = realGet;
  Keychain.delete = realDelete;
  Keychain.set = realSet;
});

const unavailable: Reply = {
  status: 503,
  body: { error: { code: 503, message: "Backend Error" } },
  headers: { "Retry-After": "0" },
};

test("deleting a draft that gets a 503 makes exactly one request", async () => {
  replies = [unavailable];
  await expect(svc.deleteGmailDraft("ws1", "d1")).rejects.toThrow(
    "Google API 503",
  );
  expect(requests).toEqual(["DELETE /gmail/v1/users/me/drafts/d1"]);
});

test("sending a draft that gets a 503 makes exactly one request", async () => {
  replies = [unavailable];
  await expect(svc.sendGmailDraft("ws1", "d1")).rejects.toThrow(
    "Google API 503",
  );
  expect(requests).toEqual(["POST /gmail/v1/users/me/drafts/send"]);
});

test("a read against a Google that keeps answering 503 makes four requests in total", async () => {
  replies = [unavailable];
  await expect(svc.listGmailLabels("ws1")).rejects.toMatchObject({
    _tag: "GoogleTransient",
    status: 503,
  });
  expect(requests.length).toBe(4);
});

test("a read recovers when Google does", async () => {
  replies = [
    unavailable,
    { status: 200, body: { labels: [{ name: "Clients", type: "user" }] } },
  ];
  await expect(svc.listGmailLabels("ws1")).resolves.toEqual(["Clients"]);
  expect(requests.length).toBe(2);
});

test("a revoked grant disconnects the workspace once, without retrying", async () => {
  tokenReply = {
    status: 400,
    body: {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    },
  };
  await expect(svc.listGmailLabels("ws1")).rejects.toMatchObject({
    _tag: "GoogleGrantRevoked",
  });
  expect(tokenRequests).toBe(1);
  expect(requests).toEqual([]);
  expect(deleted.length).toBe(1);
  expect(events.map((e) => e.status)).toEqual(["disconnected"]);
});

test("two Gmail pulls at once write a labeled email once", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gmail-"));
  const body = Buffer.from("Hello").toString("base64url");
  route = (p) => {
    if (p.endsWith("/labels"))
      return { status: 200, body: { labels: [{ id: "L1", name: "Monad" }] } };
    if (p.endsWith("/messages"))
      return { status: 200, body: { messages: [{ id: "m1" }] } };
    if (p.endsWith("/messages/m1"))
      return {
        status: 200,
        body: {
          id: "m1",
          internalDate: "1790000000000",
          payload: {
            mimeType: "text/plain",
            headers: [{ name: "Subject", value: "Quarterly numbers" }],
            body: { data: body },
          },
        },
      };
  };
  const [a, b] = await Promise.all([
    svc.syncGmailLabel("ws1", ws),
    svc.syncGmailLabel("ws1", ws),
  ]);
  expect([...a, ...b].length).toBe(1);
  expect(fs.readdirSync(path.join(ws, "inbox")).length).toBe(1);
  expect(requests.filter((r) => r.endsWith("/messages/m1")).length).toBe(1);
});

/** Google's consent page sending the browser back to the loopback server. */
async function consent(params: Record<string, string> = {}) {
  while (!opened.length) await Bun.sleep(1);
  const url = new URL(opened[0]!);
  const back = new URL(url.searchParams.get("redirect_uri")!);
  back.searchParams.set("state", url.searchParams.get("state")!);
  back.searchParams.set("code", "the-code");
  for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v);
  await fetch(back);
}

const idToken = (email: string) =>
  `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
const ALL_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

test("connecting stores the refresh token and returns the account's email", async () => {
  tokenReply = {
    status: 200,
    body: {
      access_token: "access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      scope: ALL_SCOPES,
      id_token: idToken("ada@example.com"),
    },
  };
  const connected = svc.connect("ws1");
  await consent();
  await expect(connected).resolves.toBe("ada@example.com");
  expect(stored).toEqual([["monad-drive-ws1", "new-refresh"]]);
});

test("an incomplete consent is rejected and stores nothing", async () => {
  tokenReply = {
    status: 200,
    body: {
      access_token: "access",
      refresh_token: "new-refresh",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    },
  };
  const connected = svc.connect("ws1");
  await consent();
  await expect(connected).rejects.toThrow(
    "Google didn't grant: Gmail (read), Gmail (drafts), Calendar events.",
  );
  expect(stored).toEqual([]);
});
