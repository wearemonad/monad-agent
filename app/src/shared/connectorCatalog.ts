/** Curated MCP connector catalog — the in-app storefront for the MCP ecosystem.
 *
 *  Community: PR new entries here. Keep them honest: only servers you have run.
 *  `server` is passed straight to the existing mcpAdd flow, so entries follow
 *  the same rules as manual connectors: secrets are never inlined — they are
 *  referenced as ${VARS} and entered via the credential rows (Keychain) or the
 *  workspace .env. Hosted (http) servers that use OAuth sign in on first use.
 */

export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  /** Where to create the API key / read the docs. */
  docsUrl: string;
  /** Note shown under the entry (e.g. "OAuth on first use", "edit the path"). */
  note?: string;
  server: {
    name: string;
    kind: "stdio" | "http";
    command?: string;
    url?: string;
    envLines?: string;
    bearerEnvVar?: string;
  };
};

/** Twenty's built-in MCP server (every instance serves it at /mcp). The URL
 *  is per instance, so it is a ${VAR} like the API key — it shows up as a
 *  credential row. `mode=direct` lists each operation as its own tool
 *  (find_many_companies, update_one_opportunity, …) instead of routing
 *  everything through one `execute_tool`, so permission prompts and
 *  always-allow rules stay per operation. Claude defers the large tool list
 *  via tool search. https://docs.twenty.com/developers/extend/mcp */
export const TWENTY_MCP_URL = "${TWENTY_BASE_URL}/mcp?mode=direct";

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects, cycles — read and create.",
    docsUrl: "https://linear.app/docs/mcp",
    note: "Hosted by Linear; OAuth sign-in on first use.",
    server: { name: "linear", kind: "http", url: "https://mcp.linear.app/sse" },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Pages and databases in your Notion workspace.",
    docsUrl: "https://developers.notion.com/docs/mcp",
    note: "Hosted by Notion; OAuth sign-in on first use.",
    server: { name: "notion", kind: "http", url: "https://mcp.notion.com/mcp" },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Customers, invoices, payments — the money side of the brain.",
    docsUrl: "https://docs.stripe.com/mcp",
    note: "Hosted by Stripe; OAuth sign-in on first use.",
    server: { name: "stripe", kind: "http", url: "https://mcp.stripe.com" },
  },
  {
    id: "twenty",
    name: "Twenty",
    description: "CRM — people, companies, notes, and pipeline.",
    docsUrl: "https://docs.twenty.com/developers/extend/mcp",
    note: "Twenty's official MCP server. Set TWENTY_BASE_URL to your instance (e.g. https://acme.twenty.com) and TWENTY_API_KEY to a key from Settings → Developers → API.",
    server: {
      name: "twenty",
      kind: "http",
      url: TWENTY_MCP_URL,
      bearerEnvVar: "TWENTY_API_KEY",
    },
  },
  {
    id: "posthog",
    name: "PostHog (US)",
    description: "Product analytics — insights, trends, funnels, flags.",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    note: 'US Cloud. Needs a personal API key created with the "MCP Server" scope preset (Settings → Personal API keys).',
    server: {
      name: "posthog",
      kind: "http",
      url: "https://mcp.posthog.com/mcp",
      bearerEnvVar: "POSTHOG_PERSONAL_API_KEY",
    },
  },
  {
    id: "posthog-eu",
    name: "PostHog (EU)",
    description: "Product analytics — insights, trends, funnels, flags.",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    note: 'EU Cloud (eu.posthog.com accounts). Needs a personal API key created with the "MCP Server" scope preset (Settings → Personal API keys).',
    server: {
      // Not "posthog": server names are the config key (mcpAdd rejects
      // duplicates), and sharing it with the US entry would block adding EU
      // wherever US is installed.
      name: "posthog-eu",
      kind: "http",
      url: "https://mcp.eu.posthog.com/mcp",
      bearerEnvVar: "POSTHOG_PERSONAL_API_KEY",
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repos, issues, and pull requests.",
    docsUrl: "https://github.com/github/github-mcp-server",
    note: "Hosted by GitHub; needs a personal access token.",
    server: {
      name: "github",
      kind: "http",
      url: "https://api.githubcopilot.com/mcp/",
      bearerEnvVar: "GITHUB_PAT",
    },
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read channels and post messages via a bot token.",
    docsUrl: "https://api.slack.com/apps",
    note: "Local server; create a Slack app to get the bot token + team id.",
    server: {
      name: "slack",
      kind: "stdio",
      command: "npx -y @modelcontextprotocol/server-slack",
      envLines:
        "SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}\nSLACK_TEAM_ID=${SLACK_TEAM_ID}",
    },
  },
  {
    id: "filesystem",
    name: "Local folder",
    description: "Give the agent read/write access to one extra local folder.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    note: "After adding, set FILES_FOLDER to the absolute folder path (it shows as a credential row).",
    server: {
      name: "files",
      kind: "stdio",
      command: "npx -y @modelcontextprotocol/server-filesystem ${FILES_FOLDER}",
    },
  },
];
