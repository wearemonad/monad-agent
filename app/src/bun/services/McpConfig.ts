import * as fs from "node:fs";
import * as path from "node:path";
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
      if (!server.url?.trim().startsWith("http"))
        throw new Error("A valid URL is required.");
      servers[name] = {
        type: "http",
        url: server.url.trim(),
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

  /** Smoke test: http → endpoint responds at all; stdio → command resolves.
   *  Plus missing-env warnings. Real validation happens on the next agent run. */
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
      const found = Bun.which(cfg.command);
      return found
        ? { ok: !envWarn, message: `Command found at ${found}.${envWarn}` }
        : {
            ok: false,
            message: `Command "${cfg.command}" not found on PATH.${envWarn}`,
          };
    }
    try {
      const env = {
        ...(process.env as Record<string, string>),
        ...loadWorkspaceEnv(workspacePath),
        ...appEnv,
      };
      const expand = (s: string) =>
        s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => env[v] ?? "");
      const url = expand(String(cfg.url));
      // Send the configured headers (Authorization etc.) with ${VAR}s expanded —
      // without them, servers that 401 anonymous GETs (e.g. PostHog MCP) look
      // like a bad key even when the saved credential is valid.
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.headers ?? {})) {
        headers[k] = expand(String(v));
      }
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(6000),
      });
      const s = res.status;
      // MCP streamable-HTTP servers commonly reject a plain GET (405/406)
      // even when perfectly healthy — that still proves the server is there.
      if (res.ok || s === 405 || s === 406) {
        return {
          ok: !envWarn,
          message: `Endpoint reachable (HTTP ${s}).${envWarn}`,
        };
      }
      if (s === 401 || s === 403) {
        return {
          ok: false,
          message: `Endpoint rejected the request (HTTP ${s}) — check credentials.${envWarn}`,
        };
      }
      if (s === 404) {
        return {
          ok: false,
          message: `Nothing at this URL (HTTP 404) — check the endpoint path.${envWarn}`,
        };
      }
      return {
        ok: false,
        message: `Endpoint responded with HTTP ${s}.${envWarn}`,
      };
    } catch (e) {
      return {
        ok: false,
        message: `Endpoint unreachable: ${String((e as Error).message)}.${envWarn}`,
      };
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
