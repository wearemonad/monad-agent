import { Cpu, KeyRound } from "lucide-react";
import type { ComponentType } from "react";
import {
  isOpenAIProvider,
  type OllamaStatus,
  type ProviderId,
  type RunOptions,
  type SessionSummary,
  type SettingsView,
} from "../../shared/ipc";
import { ClaudeIcon, OpenAIIcon } from "./icons";

/** What a provider icon must accept — lucide icons and our own brand icons
 *  both satisfy this. */
export type ProviderIcon = ComponentType<{
  size?: number | string;
  className?: string;
}>;

/** Static description of a provider — everything the UI needs before any
 *  runtime status (installed binary, key, running server) is known. */
/** Which company's models a provider serves — the Providers screen groups
 *  by it, and a thread can only continue on its own vendor's runtime. */
export type ProviderVendor = "anthropic" | "openai" | "local";

export type ProviderMeta = {
  id: ProviderId;
  vendor: ProviderVendor;
  /** Short name used in rails, chips and model sub-labels. */
  label: string;
  /** Full name — rail tooltips and anywhere the vendor isn't already shown. */
  title: string;
  /** Name inside its vendor group on the Providers screen. */
  rowTitle: string;
  blurb: string;
  icon: ProviderIcon;
  experimental?: boolean;
};

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "subscription-cli",
    vendor: "anthropic",
    label: "Claude Code",
    title: "Claude subscription (Claude Code)",
    rowTitle: "Subscription",
    blurb:
      "Drives your locally installed, logged-in Claude Code CLI — runs bill to your Claude plan. Not officially sanctioned by Anthropic; may stop working.",
    icon: ClaudeIcon,
  },
  {
    id: "api-key",
    vendor: "anthropic",
    label: "Anthropic API",
    title: "Anthropic API key",
    rowTitle: "API key",
    blurb:
      "Pay-per-token and fully sanctioned. The key is stored in your macOS Keychain.",
    icon: KeyRound,
  },
  {
    id: "openai-subscription",
    vendor: "openai",
    label: "Codex",
    title: "ChatGPT subscription (Codex)",
    rowTitle: "Subscription",
    blurb:
      "Drives your locally installed, ChatGPT-signed-in Codex CLI — runs bill to your ChatGPT plan. Codex works with its own shell and file tools inside a workspace sandbox; Monad's Google, memory and artifact tools are Claude-only for now.",
    icon: OpenAIIcon,
  },
  {
    id: "openai-api-key",
    vendor: "openai",
    label: "OpenAI API",
    title: "OpenAI API key",
    rowTitle: "API key",
    blurb:
      "Pay-per-token through the Codex harness, billed to your OpenAI account. The key is stored in your macOS Keychain. Same tools as the subscription: Codex's own, in a workspace sandbox.",
    icon: KeyRound,
  },
  {
    id: "local-ollama",
    vendor: "local",
    label: "Ollama",
    title: "Local models (Ollama)",
    rowTitle: "Ollama",
    blurb:
      "Free and fully private — nothing leaves this Mac. Open models are weaker at tool-heavy work than Claude; best for ingest and summaries.",
    icon: Cpu,
    experimental: true,
  },
];

/** Vendor sections of the Providers screen, in display order. */
export const PROVIDER_VENDORS: {
  id: ProviderVendor;
  title: string;
  icon: ProviderIcon;
  blurb: string;
}[] = [
  {
    id: "anthropic",
    title: "Anthropic",
    icon: ClaudeIcon,
    blurb:
      "Claude models on the Claude Code runtime — every Monad feature works here: skills, Google, memory and artifact tools, per-tool permissions.",
  },
  {
    id: "openai",
    title: "OpenAI",
    icon: OpenAIIcon,
    blurb:
      "GPT models on OpenAI's Codex harness, for chat threads. Background work (ingest, scheduled jobs, meeting prep) stays on your default provider, and a thread keeps the vendor it started with.",
  },
  {
    id: "local",
    title: "Local",
    icon: Cpu,
    blurb: "Open models running on this Mac.",
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** How ready is a provider right now — the traffic light in Settings and the
 *  reason a model row may be unusable. */
export type ProviderHealth = { state: "ok" | "warn" | "error"; detail: string };

export function providerHealth(
  id: ProviderId,
  settings: SettingsView | null,
  ollama: OllamaStatus | null,
): ProviderHealth {
  if (!settings) return { state: "warn", detail: "Checking…" };
  if (id === "subscription-cli") {
    const path = settings.claudeBinaryPath || settings.resolvedClaudePath;
    return path
      ? { state: "ok", detail: `Claude CLI · ${path}` }
      : { state: "error", detail: "Claude Code CLI not found on this Mac." };
  }
  if (id === "api-key") {
    return settings.hasApiKey
      ? { state: "ok", detail: "API key stored in the macOS Keychain." }
      : { state: "error", detail: "No API key yet — add one below." };
  }
  if (id === "openai-subscription") {
    const path = settings.codexBinaryPath || settings.resolvedCodexPath;
    return path
      ? { state: "ok", detail: `Codex CLI · ${path}` }
      : { state: "error", detail: "Codex CLI not found on this Mac." };
  }
  if (id === "openai-api-key") {
    return settings.hasOpenAIApiKey
      ? { state: "ok", detail: "API key stored in the macOS Keychain." }
      : { state: "error", detail: "No API key yet — add one below." };
  }
  if (!ollama) return { state: "warn", detail: "Checking for Ollama…" };
  if (!ollama.installed)
    return { state: "error", detail: "Ollama isn't installed." };
  if (!ollama.running)
    return { state: "warn", detail: "Ollama is installed but not running." };
  if (!settings.localModel)
    return { state: "warn", detail: "Running — no default model chosen yet." };
  return {
    state: "ok",
    detail: `Running · ${ollama.models.length} model${ollama.models.length === 1 ? "" : "s"} · default ${settings.localModel}`,
  };
}

/** One selectable entry in the composer's model picker. */
export type ModelChoice = {
  provider: ProviderId;
  /** Model id passed to the run; "" means "the provider's own default". */
  value: string;
  label: string;
  hint: string;
  /** Context-window size in tokens, when known (the Claude tiers). */
  contextWindow?: number;
  /** Local model that likely won't fit this Mac's memory. */
  warn?: boolean;
  /** Reasoning / context / speed controls (cloud models only). */
  controls?: ModelControls;
};

/** One choice in a model-control menu (reasoning level, context, speed). */
export type ControlOption = { value: string; label: string; hint?: string };

/** The controls a model offers in the composer's second dropdown — what
 *  the model actually supports, with its own default for each. */
export type ModelControls = {
  reasoning: { options: ControlOption[]; default: string };
  /** Claude only: 200k / 1M. */
  context?: { options: ControlOption[]; default: string };
  /** Claude "Fast Mode" (On/Off) or OpenAI "Service Tier" (Standard/Fast). */
  speed?: { title: string; options: ControlOption[]; default: string };
};

const CLAUDE_REASONING: ControlOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  {
    value: "ultracode",
    label: "Ultracode",
    hint: "xhigh effort plus multi-agent workflow orchestration",
  },
  { value: "ultrathink", label: "Ultrathink" },
];

const CLAUDE_CONTEXT: ModelControls["context"] = {
  options: [
    { value: "200k", label: "200k" },
    { value: "1m", label: "1M" },
  ],
  default: "1m",
};

// Pinned to full model ids (not the CLI's opus/sonnet aliases) so the label
// always names the model that actually runs. Both current Claude tiers have a
// 1M context window. No "use the CLI's configured default" row: the app
// always picks explicitly, falling back to DEFAULT_MODEL when a stored choice
// stops resolving (see ModelPicker). Effort defaults follow the API: Opus 5.5
// defaults to medium, Sonnet 5.5 to high; only Opus offers fast mode. Update
// when the lineup moves.
const CLAUDE_MODELS: Omit<ModelChoice, "provider">[] = [
  {
    value: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    hint: "Deep work",
    contextWindow: 1_000_000,
    controls: {
      reasoning: { options: CLAUDE_REASONING, default: "medium" },
      context: CLAUDE_CONTEXT,
      speed: {
        title: "Fast Mode",
        options: [
          { value: "fast", label: "On" },
          { value: "standard", label: "Off" },
        ],
        default: "standard",
      },
    },
  },
  {
    value: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    hint: "Balanced",
    contextWindow: 1_000_000,
    controls: {
      reasoning: { options: CLAUDE_REASONING, default: "high" },
      context: CLAUDE_CONTEXT,
    },
  },
];

/** The fallback pick: Sonnet on the default (Claude-runtime) provider. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** Codex reasoning levels; `ultra` only on the larger tiers. */
function openaiControls(def: string, ultra: boolean): ModelControls {
  return {
    reasoning: {
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
        ...(ultra ? [{ value: "ultra", label: "Ultra" }] : []),
      ],
      default: def,
    },
    speed: {
      title: "Service Tier",
      options: [
        { value: "standard", label: "Standard" },
        { value: "fast", label: "Fast", hint: "2x speed, increased usage" },
      ],
      default: "standard",
    },
  };
}

// OpenAI models, by what each OpenAI provider can serve (levels and defaults
// per Codex's own model catalog). A ChatGPT plan signed into Codex has
// rejected the GPT-6 Sol/Luna tiers, so it lists the GPT-5.6 ones; the API
// gets GPT-6. Terra (balanced) exists as GPT-5.6 only. All current Codex
// models have a 272K window.
const OPENAI_SUBSCRIPTION_MODELS: Omit<ModelChoice, "provider">[] = [
  {
    value: "gpt-6-astra",
    label: "GPT-6-Astra",
    hint: "Frontier",
    contextWindow: 272_000,
    controls: openaiControls("medium", true),
  },
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    hint: "Workhorse",
    contextWindow: 272_000,
    controls: openaiControls("low", true),
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    hint: "Balanced",
    contextWindow: 272_000,
    controls: openaiControls("medium", true),
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    hint: "Fast & light",
    contextWindow: 272_000,
    controls: openaiControls("medium", false),
  },
];

const OPENAI_API_MODELS: Omit<ModelChoice, "provider">[] = [
  {
    value: "gpt-6-astra",
    label: "GPT-6-Astra",
    hint: "Frontier",
    contextWindow: 272_000,
    controls: openaiControls("medium", true),
  },
  {
    value: "gpt-6-sol",
    label: "GPT-6-Sol",
    hint: "Workhorse",
    contextWindow: 272_000,
    controls: openaiControls("medium", true),
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    hint: "Balanced",
    contextWindow: 272_000,
    controls: openaiControls("medium", true),
  },
  {
    value: "gpt-6-luna",
    label: "GPT-6-Luna",
    hint: "Fast & light",
    contextWindow: 272_000,
    controls: openaiControls("medium", false),
  },
];

/** The fixed model list a cloud provider serves (Ollama's is dynamic). */
function staticModels(provider: ProviderId): Omit<ModelChoice, "provider">[] {
  if (provider === "openai-subscription") return OPENAI_SUBSCRIPTION_MODELS;
  if (provider === "openai-api-key") return OPENAI_API_MODELS;
  if (provider === "local-ollama") return [];
  return CLAUDE_MODELS;
}

/** Known context-window size for a pick, or null (Ollama library, unknown
 *  ids). The run's own SDK-reported window stays authoritative as a fallback. */
export function contextWindowFor(
  provider: ProviderId | null,
  model: string,
  options?: RunOptions,
): number | null {
  if (!provider) return null;
  const m = staticModels(provider).find((c) => c.value === model);
  if (m?.controls?.context && options?.context === "200k") return 200_000;
  return m?.contextWindow ?? null;
}

/** The controls the picked model offers, or null (Ollama, unknown ids). */
export function controlsFor(
  provider: ProviderId | null,
  model: string,
): ModelControls | null {
  if (!provider) return null;
  return (
    staticModels(provider).find((m) => m.value === model)?.controls ?? null
  );
}

/** The user's stored choices merged over the model's defaults, dropping
 *  anything this model doesn't offer (a level picked on another model).
 *  Null when the model has no controls. */
export function resolveRunOptions(
  controls: ModelControls | null,
  stored: RunOptions | undefined,
): RunOptions | null {
  if (!controls) return null;
  const pick = (
    group: { options: ControlOption[]; default: string } | undefined,
    value: string | undefined,
  ) =>
    group
      ? group.options.some((o) => o.value === value)
        ? value
        : group.default
      : undefined;
  return {
    effort: pick(controls.reasoning, stored?.effort),
    ...(controls.context
      ? {
          context: pick(
            controls.context,
            stored?.context,
          ) as RunOptions["context"],
        }
      : {}),
    ...(controls.speed
      ? { speed: pick(controls.speed, stored?.speed) as RunOptions["speed"] }
      : {}),
  };
}

/** Composer trigger label: "Medium · 1M", "High · Fast". */
export function runOptionsLabel(
  controls: ModelControls,
  options: RunOptions,
): string {
  const label = (
    group: { options: ControlOption[] } | undefined,
    value: string | undefined,
  ) => group?.options.find((o) => o.value === value)?.label;
  return [
    label(controls.reasoning, options.effort),
    controls.context ? label(controls.context, options.context) : undefined,
    options.speed === "fast" ? "Fast" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** True when the reported model id is just the picked model — showing it
 *  next to the picker would repeat the same thing. Dated ids
 *  (claude-sonnet-5-5-20260901) count as their undated pick. */
export function isPickedModel(picked: string, reported: string): boolean {
  if (!picked || !reported) return false;
  return reported === picked || reported.startsWith(`${picked}-`);
}

/** Every model the user can pick right now, across all enabled providers.
 *  Ollama contributes its installed library; each cloud provider its fixed
 *  list (the two Claude providers share one — same models, different billing
 *  and endpoint). */
export function modelChoices(
  settings: SettingsView | null,
  ollama: OllamaStatus | null,
): ModelChoice[] {
  if (!settings) return [];
  const choices: ModelChoice[] = [];
  for (const provider of settings.enabledProviders) {
    if (provider === "local-ollama") {
      choices.push({
        provider,
        value: "",
        label: settings.localModel || "No model chosen",
        hint: settings.localModel
          ? "default — set in Settings"
          : "download one in Settings",
      });
      for (const m of ollama?.models ?? []) {
        if (m.id === settings.localModel) continue;
        choices.push({
          provider,
          value: m.id,
          label: m.id,
          hint: `${m.sizeGb} GB · ${m.fitHint}`,
          warn: m.fit === "too-big",
        });
      }
    } else {
      for (const m of staticModels(provider)) choices.push({ provider, ...m });
    }
  }
  return choices;
}

/** Stable key for a pick — favorites and the selected-row check both use it. */
export function choiceKey(provider: ProviderId, value: string): string {
  return `${provider}::${value}`;
}

/** The agent runtime behind a provider. A thread is bound to the runtime that
 *  created it: Claude sessions (Anthropic or Ollama models) can't continue on
 *  Codex, and Codex threads (OpenAI models) can't continue on Claude. */
export type ThreadRuntime = "claude" | "codex";

export function providerRuntime(id: ProviderId): ThreadRuntime {
  return isOpenAIProvider(id) ? "codex" : "claude";
}

/** The runtime the open thread is bound to, plus the model an OpenAI thread
 *  last ran with. Null for a new chat — or a thread the sidebar hasn't listed
 *  yet (just created), where restricting on a guess would be worse than not
 *  restricting at all. */
export function threadBinding(
  resumeSessionId: string | null,
  sessions: SessionSummary[],
):
  | (Pick<SessionSummary, "provider" | "model"> & { runtime: ThreadRuntime })
  | null {
  if (!resumeSessionId) return null;
  const s = sessions.find((x) => x.sessionId === resumeSessionId);
  if (!s) return null;
  return s.runtime === "codex"
    ? { runtime: "codex", provider: s.provider, model: s.model }
    : { runtime: "claude" };
}
