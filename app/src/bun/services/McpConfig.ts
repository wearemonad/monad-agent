import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TWENTY_MCP_URL } from "../../shared/connectorCatalog";
import type { McpServerInfo } from "../../shared/ipc";
import { loadWorkspaceEnv } from "./envFile";

/** Read/write a workspace's .mcp.json — the same file Claude Code reads, so
 *  connectors added here work in the terminal too. */
export class McpConfig {
  /** `appEnv` = per-workspace values entered in Settings (Keychain-backed);
   *  they sit on top of the developer .env file. */
  list(
    workspacePath: string,
    appEnv: Record<string, string> = {},
  ): McpServerInfo[] {
    const servers = this.read(workspacePath);
    const fileEnv = loadWorkspaceEnv(workspacePath);
    const isPlaceholder = (v?: string) =>
      !v || /your-|example\.com|phx_your/.test(v);
    return Object.entries(servers).map(([name, cfg]: [string, any]) => {
      const raw = JSON.stringify(cfg);
      const referenced = [
        ...new Set(
          [...raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]),
        ),
      ];
      const envVars = referenced.map((v) => ({
        name: v,
        source: !isPlaceholder(appEnv[v])
          ? ("app" as const)
          : !isPlaceholder(fileEnv[v] ?? (process.env[v] as string | undefined))
            ? ("env-file" as const)
            : ("missing" as const),
      }));
      const missingEnv = envVars
        .filter((e) => e.source === "missing")
        .map((e) => e.name);
      const kind = cfg.command ? "stdio" : "http";
      const detail = cfg.command
        ? [cfg.command, ...(cfg.args ?? [])].join(" ")
        : (cfg.url ?? "");
      return { name, kind, detail, missingEnv, envVars } as McpServerInfo;
    });
  }

  add(
    workspacePath: string,
    server: {
      name: string;
      kind: "stdio" | "http";
      command?: string;
      args?: string;
      url?: string;
      envLines?: string;
      bearerEnvVar?: string;
    },
  ): void {
    const name = server.name.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(
        "Server name must be alphanumeric (dashes/underscores allowed).",
      );
    }
    const servers = this.read(workspacePath);
    if (servers[name])
      throw new Error(`A connector named "${name}" already exists.`);

    if (server.kind === "stdio") {
      if (!server.command?.trim())
        throw new Error("Command is required for a stdio connector.");
      const [command, ...args] = server.command.trim().split(/\s+/);
      const env: Record<string, string> = {};
      for (const line of (server.envLines ?? "").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      servers[name] = {
        command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
    } else {
      // A leading ${VAR} is allowed for per-instance servers (Twenty's
      // ${TWENTY_BASE_URL}/mcp) — it's expanded at run time like headers.
      const url = server.url?.trim() ?? "";
      if (!/^(https?:\/\/|\$\{[A-Za-z_][A-Za-z0-9_]*\})/.test(url))
        throw new Error("A valid URL is required.");
      servers[name] = {
        type: "http",
        url,
        ...(server.bearerEnvVar?.trim()
          ? {
              headers: {
                Authorization: `Bearer \${${server.bearerEnvVar.trim()}}`,
              },
            }
          : {}),
      };
    }
    this.write(workspacePath, servers);
  }

  remove(workspacePath: string, name: string): void {
    const servers = this.read(workspacePath);
    delete servers[name];
    this.write(workspacePath, servers);
  }

  /** Smoke test: http → a real MCP handshake (initialize + tools/list) with the
   *  configured headers, so a bad key fails here instead of on the next agent
   *  run; stdio → command resolves. Plus missing-env warnings. */
  async test(
    workspacePath: string,
    name: string,
    appEnv: Record<string, string> = {},
  ): Promise<{ ok: boolean; message: string }> {
    const servers = this.read(workspacePath);
    const cfg: any = servers[name];
    if (!cfg) return { ok: false, message: "Unknown connector." };
    const info = this.list(workspacePath, appEnv).find((s) => s.name === name);
    const envWarn = info?.missingEnv.length
      ? ` Missing credentials: ${info.missingEnv.join(", ")} (set them below).`
      : "";

    if (cfg.command) {
      // Pass PATH explicitly: Bun.which (like Bun.spawn) reads the PATH the
      // process was launched with, not the login-shell PATH fixProcessPath()
      // merged into process.env later — a GUI launch would never find npx.
      const found = Bun.which(cfg.command, { PATH: process.env.PATH ?? "" });
      return found
        ? { ok: !envWarn, message: `Command found at ${found}.${envWarn}` }
        : {
            ok: false,
            message: `Command "${cfg.command}" not found on PATH.${envWarn}`,
          };
    }
    const env = {
      ...(process.env as Record<string, string>),
      ...loadWorkspaceEnv(workspacePath),
      ...appEnv,
    };
    const expand = (s: string) =>
      s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => env[v] ?? "");
    // Send the configured headers (Authorization etc.) with ${VAR}s expanded.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers ?? {})) {
      headers[k] = expand(String(v));
    }
    let url: URL;
    try {
      url = new URL(expand(String(cfg.url)));
    } catch {
      // An unset ${TWENTY_BASE_URL}-style prefix is the usual cause.
      return { ok: false, message: envWarn.trim() || "Invalid URL." };
    }
    // A plain GET proves nothing: MCP servers answer it with 405 whether or
    // not the key is valid. Only a handshake exercises the credentials.
    const transport =
      cfg.type === "sse"
        ? new SSEClientTransport(url, { requestInit: { headers } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    const client = new Client({ name: "monad", version: "1.0.0" });
    const timeout = 8000;
    try {
      await client.connect(transport, { timeout });
      const server = client.getServerVersion();
      const label = server?.name ? ` to ${server.name}` : "";
      let tools = "";
      if (client.getServerCapabilities()?.tools) {
        const { tools: list } = await client.listTools(undefined, { timeout });
        tools = ` — ${list.length} tool${list.length === 1 ? "" : "s"}`;
      }
      return { ok: !envWarn, message: `Connected${label}${tools}.${envWarn}` };
    } catch (e) {
      const status = httpStatus(e);
      if (status === 401 || status === 403) {
        return {
          ok: false,
          message: `Server rejected the credentials (HTTP ${status}).${envWarn}`,
        };
      }
      if (status === 404) {
        return {
          ok: false,
          message: `Nothing at this URL (HTTP 404) — check the endpoint path.${envWarn}`,
        };
      }
      if (status && status > 0) {
        return {
          ok: false,
          message: `Server responded with HTTP ${status}.${envWarn}`,
        };
      }
      return {
        ok: false,
        message: `Connection failed: ${String((e as Error).message)}.${envWarn}`,
      };
    } finally {
      await client.close().catch(() => {});
    }
  }

  private file(workspacePath: string): string {
    return path.join(workspacePath, ".mcp.json");
  }

  private read(workspacePath: string): Record<string, unknown> {
    // ENOENT = no connectors yet; anything else must NOT collapse to {} —
    // treating a malformed file as empty makes the next write() silently
    // delete every connector the user configured.
    const raw = this.readRaw(workspacePath);
    if (raw === null) return {};
    try {
      return JSON.parse(raw).mcpServers ?? {};
    } catch {
      throw new Error(
        ".mcp.json is not valid JSON — fix or remove the file before managing connectors.",
      );
    }
  }

  private write(workspacePath: string, servers: Record<string, unknown>): void {
    const raw = this.readRaw(workspacePath);
    let doc: any = {};
    if (raw !== null) {
      try {
        doc = JSON.parse(raw);
      } catch {
        // Refuse to overwrite a file we can't parse — the user's hand-edited
        // config (comments? trailing comma?) would be destroyed wholesale.
        throw new Error(
          ".mcp.json is not valid JSON — refusing to overwrite it. Fix or remove the file first.",
        );
      }
    }
    doc.mcpServers = servers;
    fs.writeFileSync(
      this.file(workspacePath),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
  }

  /** File contents, or null when it doesn't exist. Other read errors throw. */
  private readRaw(workspacePath: string): string | null {
    try {
      return fs.readFileSync(this.file(workspacePath), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

/** HTTP status behind an MCP transport error. The streamable transport puts it
 *  on `code`; without an auth provider a 401 surfaces as UnauthorizedError. */
function httpStatus(e: unknown): number | undefined {
  if (e instanceof StreamableHTTPError) return e.code;
  const err = e as { name?: string; code?: unknown };
  if (err?.name === "UnauthorizedError") return 401;
  return typeof err?.code === "number" ? err.code : undefined;
}

/** The `twenty` entry earlier workspaces were scaffolded with: the community
 *  twenty-crm-mcp-server over npx (needs Node on PATH, lags Twenty's API). */
function isLegacyTwenty(cfg: unknown): boolean {
  const c = cfg as { command?: unknown; args?: unknown };
  return (
    c?.command === "npx" &&
    Array.isArray(c.args) &&
    c.args.includes("twenty-crm-mcp-server")
  );
}

/** Rewrite a legacy `twenty` connector in a workspace's .mcp.json to Twenty's
 *  official MCP server, keeping the same ${TWENTY_API_KEY}/${TWENTY_BASE_URL}
 *  credentials so nothing has to be re-entered. Leaves the file untouched when
 *  there's no legacy entry or it isn't valid JSON. Returns whether it wrote. */
export function upgradeLegacyTwenty(workspacePath: string): boolean {
  const file = path.join(workspacePath, ".mcp.json");
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (!isLegacyTwenty(doc?.mcpServers?.twenty)) return false;
  doc.mcpServers.twenty = {
    type: "http",
    url: TWENTY_MCP_URL,
    headers: { Authorization: "Bearer ${TWENTY_API_KEY}" },
  };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}
