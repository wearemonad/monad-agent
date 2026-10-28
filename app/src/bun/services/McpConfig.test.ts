import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpConfig, upgradeLegacyTwenty } from "./McpConfig";

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

  // The http test is a real MCP handshake sent WITH the configured headers,
  // ${VAR}s expanded from appEnv. A plain GET can't tell a good key from a bad
  // one — PostHog answers it with 405 either way.
  test("test() handshakes with configured headers and reports bad keys", async () => {
    const headerWs = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-hdr-"));
    const realFetch = globalThis.fetch;
    try {
      mcp.add(headerWs, {
        name: "posthog",
        kind: "http",
        url: "https://mcp.posthog.com/mcp",
        bearerEnvVar: "POSTHOG_PERSONAL_API_KEY",
      });
      const seen: string[] = [];
      globalThis.fetch = (async (_url: any, init?: any) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth) seen.push(auth);
        if (auth !== "Bearer phx_real_key")
          return new Response("Invalid API key", { status: 401 });
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const msg = JSON.parse(String(init.body));
        if (msg.id === undefined) return new Response(null, { status: 202 });
        const result =
          msg.method === "initialize"
            ? {
                protocolVersion: msg.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "PostHog", version: "1.0.0" },
              }
            : { tools: [{ name: "a", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: msg.id, result });
      }) as typeof fetch;

      const good = await mcp.test(headerWs, "posthog", {
        POSTHOG_PERSONAL_API_KEY: "phx_real_key",
      });
      expect(seen).toContain("Bearer phx_real_key");
      expect(good).toEqual({
        ok: true,
        message: "Connected to PostHog — 1 tool.",
      });

      const bad = await mcp.test(headerWs, "posthog", {
        POSTHOG_PERSONAL_API_KEY: "phx_wrong_key",
      });
      expect(bad.ok).toBe(false);
      expect(bad.message).toContain("rejected the credentials (HTTP 401)");
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(headerWs, { recursive: true, force: true });
    }
  });

  // Bun.which ignores PATH entries merged into process.env after launch, so a
  // GUI-launched app must hand it the merged PATH explicitly.
  test("test() resolves stdio commands against the runtime PATH", async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-bin-"));
    const stdioWs = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-stdio-"));
    const realPath = process.env.PATH;
    try {
      const bin = path.join(binDir, "monad-fake-npx");
      fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
      mcp.add(stdioWs, {
        name: "fake",
        kind: "stdio",
        command: "monad-fake-npx -y x",
      });
      process.env.PATH = `${binDir}:${realPath}`;
      const res = await mcp.test(stdioWs, "fake");
      expect(res).toEqual({ ok: true, message: `Command found at ${bin}.` });
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(stdioWs, { recursive: true, force: true });
    }
  });

  test("http URL may start with a ${VAR} (per-instance servers)", () => {
    const varWs = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-var-"));
    try {
      mcp.add(varWs, {
        name: "twenty",
        kind: "http",
        url: "${TWENTY_BASE_URL}/mcp?mode=direct",
        bearerEnvVar: "TWENTY_API_KEY",
      });
      const [info] = mcp.list(varWs, { TWENTY_API_KEY: "k" });
      expect(info.detail).toBe("${TWENTY_BASE_URL}/mcp?mode=direct");
      expect(info.missingEnv).toEqual(["TWENTY_BASE_URL"]);
      expect(() =>
        mcp.add(varWs, { name: "bad", kind: "http", url: "crm/mcp" }),
      ).toThrow(/valid URL/);
    } finally {
      fs.rmSync(varWs, { recursive: true, force: true });
    }
  });

  test("upgradeLegacyTwenty swaps the npx server for the official endpoint", () => {
    const legacyWs = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mcp-tw-"));
    const file = path.join(legacyWs, ".mcp.json");
    try {
      const posthog = { type: "http", url: "https://mcp.posthog.com/mcp" };
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            twenty: {
              command: "npx",
              args: ["-y", "twenty-crm-mcp-server"],
              env: { TWENTY_API_KEY: "${TWENTY_API_KEY}" },
            },
            posthog,
          },
        }),
      );
      expect(upgradeLegacyTwenty(legacyWs)).toBe(true);
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(doc.mcpServers.twenty).toEqual({
        type: "http",
        url: "${TWENTY_BASE_URL}/mcp?mode=direct",
        headers: { Authorization: "Bearer ${TWENTY_API_KEY}" },
      });
      expect(doc.mcpServers.posthog).toEqual(posthog);
      // Idempotent, and a hand-built twenty entry is left alone.
      expect(upgradeLegacyTwenty(legacyWs)).toBe(false);
      const custom = { command: "node", args: ["my-twenty.js"] };
      fs.writeFileSync(
        file,
        JSON.stringify({ mcpServers: { twenty: custom } }),
      );
      expect(upgradeLegacyTwenty(legacyWs)).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.twenty,
      ).toEqual(custom);
    } finally {
      fs.rmSync(legacyWs, { recursive: true, force: true });
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
