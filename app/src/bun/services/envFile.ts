import * as fs from "node:fs";
import * as path from "node:path";

/** Parse `<workspace>/.env` (KEY=VALUE lines; #-comments; optional single/double
 *  quotes). MCP servers in .mcp.json reference these via ${VAR} expansion, and GUI
 *  apps don't inherit shell exports — so Monad injects them into each agent run.
 *
 *  Handles the cases that mangle a naive split-on-newline parser:
 *   - inline comments on unquoted values (`KEY=abc # note` → `abc`, not `abc # note`)
 *   - quoted values that span multiple lines (a pasted PEM / service-account key),
 *     consuming lines until the matching quote; `\n` in double-quoted values is
 *     unescaped so a one-line `"-----BEGIN...\n..."` also works. */
export function loadWorkspaceEnv(
  workspacePath: string,
): Record<string, string> {
  const file = path.join(workspacePath, ".env");
  const env: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return env;
  }

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let rest = trimmed.slice(eq + 1).trimStart();
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
    if (quote) {
      // Consume from after the opening quote across lines until the closing
      // quote. Backslash-escapes are honored only for double quotes.
      let body = rest.slice(1);
      let value: string | null = closeQuoted(body, quote);
      while (value === null && i + 1 < lines.length) {
        i++;
        body += `\n${lines[i]}`;
        value = closeQuoted(body, quote);
      }
      // Unterminated quote → take what we have (minus the opener), best effort.
      env[key] = value ?? body;
    } else {
      // Unquoted: an inline ` #…` comment ends the value.
      const hash = rest.search(/\s+#/);
      if (hash !== -1) rest = rest.slice(0, hash);
      env[key] = rest.trim();
    }
  }
  return env;
}

/** If `body` (text after the opening quote, possibly multi-line) contains the
 *  closing quote, return the unescaped value up to it; otherwise null (caller
 *  keeps consuming lines). For double quotes, `\n`/`\t`/`\"`/`\\` are unescaped
 *  and a backslash before the quote escapes it. */
function closeQuoted(body: string, quote: string): string | null {
  if (quote === "'") {
    const end = body.indexOf("'");
    return end === -1 ? null : body.slice(0, end);
  }
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i++;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
  }
  return null;
}
