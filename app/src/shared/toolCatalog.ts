/** Human-readable catalog of the tools a workspace's agent can run. Powers the
 *  Access tab's tool picker so non-technical users grant capabilities by name
 *  instead of guessing raw rule strings.
 *
 *  A "rule" here is exactly what WorkspaceManager.isAlwaysAllowed matches: an
 *  exact tool name (e.g. "Read"), or a `*`-suffixed prefix (e.g. "mcp__linear__*")
 *  that covers every tool from one connector. Keep these in sync with the
 *  built-in tools AgentService exposes and the "google" in-process MCP server. */

import { ARTIFACTS_ALLOW_RULE } from "./artifacts";
import { EMAIL_ALLOW_RULE } from "./email";
import { MEMORY_ALLOW_RULE } from "./memory";

/** App-internal plumbing rules (artifact panel, email draft card, working
 *  memory) seeded into every workspace's alwaysAllow. Not a user-facing
 *  permission decision: revoking one only adds prompts in chat and silently
 *  breaks background runs, where a tool that can't ask is denied — so
 *  permission UIs hide these rather than offer a toggle. */
export const INTERNAL_ALLOW_RULES = new Set<string>([
  ARTIFACTS_ALLOW_RULE,
  EMAIL_ALLOW_RULE,
  MEMORY_ALLOW_RULE,
]);

export type ToolGroup =
  | "Files & search"
  | "System"
  | "Web"
  | "Automation"
  | "Google"
  | "Connectors";

export type ToolOption = {
  /** The always-allow rule stored on the workspace (exact name or `prefix*`). */
  rule: string;
  label: string;
  description: string;
  group: ToolGroup;
  /** Powerful tools (write/exec) — surfaced with a warning tint in the picker. */
  sensitive?: boolean;
};

/** Built-in Claude Code / in-app tools, available in every workspace regardless
 *  of which connectors are installed. */
export const BUILTIN_TOOL_OPTIONS: ToolOption[] = [
  {
    rule: "Read",
    label: "Read files",
    description: "Open and read files in the workspace.",
    group: "Files & search",
  },
  {
    rule: "Glob",
    label: "Find files",
    description: "List files by name pattern.",
    group: "Files & search",
  },
  {
    rule: "Grep",
    label: "Search file contents",
    description: "Search across files for text.",
    group: "Files & search",
  },
  {
    rule: "Write",
    label: "Write files",
    description: "Create or overwrite files — changes the workspace.",
    group: "Files & search",
    sensitive: true,
  },
  {
    rule: "Edit",
    label: "Edit files",
    description: "Modify existing files — changes the workspace.",
    group: "Files & search",
    sensitive: true,
  },
  {
    rule: "ToolSearch",
    label: "Discover tools",
    description: "Let the agent look up available tools on demand.",
    group: "System",
  },
  {
    rule: "Bash",
    label: "Run shell commands",
    description: "Run terminal commands — powerful; grant with care.",
    group: "System",
    sensitive: true,
  },
  {
    rule: "WebSearch",
    label: "Web search",
    description: "Search the web for current information.",
    group: "Web",
  },
  {
    rule: "WebFetch",
    label: "Fetch web pages",
    description: "Read the contents of a URL.",
    group: "Web",
  },
  {
    rule: "Task",
    label: "Sub-agents",
    description: "Spin up helper agents for multi-step work.",
    group: "Automation",
  },
  {
    rule: "TodoWrite",
    label: "Task list",
    description: "Track a to-do list while working.",
    group: "Automation",
  },
];

/** Gmail + Calendar tools, behind the in-process "google" MCP server. Only
 *  relevant once the workspace has connected a Google account. */
export const GOOGLE_TOOL_OPTIONS: ToolOption[] = [
  {
    rule: "mcp__google__*",
    label: "All Google tools",
    description:
      "Gmail search/read/draft plus Calendar for the connected account.",
    group: "Google",
  },
  {
    rule: "mcp__google__gmail_search",
    label: "Gmail — search",
    description: "Search Gmail messages.",
    group: "Google",
  },
  {
    rule: "mcp__google__gmail_read",
    label: "Gmail — read",
    description: "Read a Gmail message.",
    group: "Google",
  },
  {
    rule: "mcp__google__gmail_create_draft",
    label: "Gmail — draft",
    description: "Create a draft (never sends it).",
    group: "Google",
  },
  {
    rule: "mcp__google__calendar_list_events",
    label: "Calendar — list events",
    description: "List upcoming calendar events.",
    group: "Google",
  },
  {
    rule: "mcp__google__calendar_create_event",
    label: "Calendar — create event",
    description: "Add an event to the calendar.",
    group: "Google",
  },
];

/** "Allow every tool from this connector" option for an installed MCP server. */
export function connectorToolOption(serverName: string): ToolOption {
  return {
    rule: `mcp__${serverName}__*`,
    label: `All ${serverName} tools`,
    description: `Every tool the ${serverName} connector provides.`,
    group: "Connectors",
  };
}

/** Fallback option for a rule already on the workspace that we don't recognize
 *  (a hand-typed custom rule) so it still renders as a labelled chip. */
export function customToolOption(rule: string): ToolOption {
  return {
    rule,
    label: rule,
    description: "Custom rule.",
    group: "Connectors",
  };
}

/** Order groups appear in the picker. */
export const TOOL_GROUP_ORDER: ToolGroup[] = [
  "Files & search",
  "System",
  "Web",
  "Automation",
  "Google",
  "Connectors",
];
