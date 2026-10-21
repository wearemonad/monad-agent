import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpConfig } from "./McpConfig";

const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-test-"));
const mcp = new McpConfig();

afterAll(() => fs.rmSync(wsDir, { recursive: true, force: true }));

describe("McpConfig", () => {
  test("add http connector with bearer env var", () => {
    mcp.add(wsDir, {
      name: "linear",
      kind: "http",
      url: "https://mcp.linear.app/sse",
      bearerEnvVar: "LINEAR_KEY",
    });
    const doc = JSON.parse(
      fs.readFileSync(path.join(wsDir, ".mcp.json"), "utf8"),
    );
    expect(doc.mcpServers.linear.url).toBe("https://mcp.linear.app/sse");
    expect(doc.mcpServers.linear.headers.Authorization).toBe(
      "Bearer ${LINEAR_KEY}",
    );
  });

  test("add stdio connector with env lines", () => {
    mcp.add(wsDir, {
      name: "slack",
      kind: "stdio",
      command: "npx -y @modelcontextprotocol/server-slack",
      envLines: "SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}",
    });
    const doc = JSON.parse(
      fs.readFileSync(path.join(wsDir, ".mcp.json"), "utf8"),
    );
    expect(doc.mcpServers.slack.command).toBe("npx");
    expect(doc.mcpServers.slack.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-slack",
    ]);
    expect(doc.mcpServers.slack.env.SLACK_BOT_TOKEN).toBe("${SLACK_BOT_TOKEN}");
  });

  test("list reports unresolved ${VARS} as missing, appEnv resolves them", () => {
    const missing = mcp.list(wsDir).find((s) => s.name === "linear");
    expect(missing?.missingEnv).toEqual(["LINEAR_KEY"]);

    const resolved = mcp
      .list(wsDir, { LINEAR_KEY: "lin_live_real" })
      .find((s) => s.name === "linear");
    expect(resolved?.missingEnv).toEqual([]);
    expect(resolved?.envVars[0]).toEqual({ name: "LINEAR_KEY", source: "app" });
  });

  test("placeholder-looking values still count as missing", () => {
    const srv = mcp
      .list(wsDir, { LINEAR_KEY: "your-linear-key" })
      .find((s) => s.name === "linear");
    expect(srv?.missingEnv).toEqual(["LINEAR_KEY"]);
  });

  test("duplicate names are rejected; bad names are rejected", () => {
    expect(() =>
      mcp.add(wsDir, { name: "linear", kind: "http", url: "https://x.dev" }),
    ).toThrow(/exists/);
    expect(() =>
      mcp.add(wsDir, { name: "bad name!", kind: "http", url: "https://x.dev" }),
    ).toThrow(/alphanumeric/);
  });

  test("remove deletes the server", () => {
    mcp.remove(wsDir, "slack");
    expect(mcp.list(wsDir).some((s) => s.name === "slack")).toBe(false);
  });

  // runtime#7: a malformed .mcp.json must NOT read as "no connectors" —
  // that made the next write silently delete every configured connector.
  test("a corrupt .mcp.json throws on read and refuses writes", () => {
    const corruptWs = fs.mkdtempSync(
      path.join(os.tmpdir(), "monad-mcp-corrupt-"),
    );
    try {
      fs.writeFileSync(
        path.join(corruptWs, ".mcp.json"),
        '{"mcpServers": {broken',
      );
      expect(() => mcp.list(corruptWs)).toThrow(/not valid JSON/);
      expect(() =>
        mcp.add(corruptWs, { name: "x", kind: "http", url: "https://x.dev" }),
      ).toThrow(/not valid JSON/);
      // the broken file is still exactly as the user left it
      expect(fs.readFileSync(path.join(corruptWs, ".mcp.json"), "utf8")).toBe(
        '{"mcpServers": {broken',
      );
    } finally {
      fs.rmSync(corruptWs, { recursive: true, force: true });
    }
  });

  // A server that 401s anonymous GETs (PostHog MCP) must be probed WITH its
  // configured headers, ${VAR}s expanded from appEnv — otherwise a valid saved
  // key still reports "check credentials".
  test("test() sends configured headers with env expanded", async () => {
    const headerWs = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-hdr-"));
    const realFetch = globalThis.fetch;
    try {
      mcp.add(headerWs, {
        name: "posthog",
        kind: "http",
        url: "https://mcp.posthog.com/mcp",
        bearerEnvVar: "POSTHOG_PERSONAL_API_KEY",
      });
      const seen: { auth?: string } = {};
      globalThis.fetch = (async (_url: any, init?: any) => {
        seen.auth = init?.headers?.Authorization;
        // PostHog: 401 without auth, 405 (method not allowed) with it.
        return new Response(null, { status: seen.auth ? 405 : 401 });
      }) as typeof fetch;
      const res = await mcp.test(headerWs, "posthog", {
        POSTHOG_PERSONAL_API_KEY: "phx_real_key",
      });
      expect(seen.auth).toBe("Bearer phx_real_key");
      expect(res.ok).toBe(true);
      expect(res.message).toContain("reachable");
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(headerWs, { recursive: true, force: true });
    }
  });

  test("a missing .mcp.json still reads as no connectors", () => {
    const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-empty-"));
    try {
      expect(mcp.list(emptyWs)).toEqual([]);
    } finally {
      fs.rmSync(emptyWs, { recursive: true, force: true });
    }
  });
});
