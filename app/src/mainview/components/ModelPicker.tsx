import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProviderId } from "../../shared/ipc";
import { useStore } from "../store";
import {
  choiceKey,
  DEFAULT_MODEL,
  modelChoices,
  providerMeta,
  providerRuntime,
  threadBinding,
  type ModelChoice,
} from "../lib/models";
import { Button } from "@/components/ui/button";
import { fmtTokens } from "../util";

const FAVORITES_KEY = "monad-favorite-models";

function loadFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Model + provider picker for the composer: a provider rail, a search box, and
 *  starred models pinned to the top. Selecting a model also selects the
 *  provider that serves it — the run goes to that provider's endpoint. */
export function ModelPicker() {
  const model = useStore((s) => s.model);
  const modelProvider = useStore((s) => s.modelProvider);
  const setModel = useStore((s) => s.setModel);
  const settings = useStore((s) => s.settings);
  const ollama = useStore((s) => s.ollama);
  const resumeSessionId = useStore((s) => s.resumeSessionId);
  const sessions = useStore((s) => s.sessions);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState<ProviderId | "favorites" | null>(null);
  const [cursor, setCursor] = useState(0);
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const choices = useMemo(
    () => modelChoices(settings, ollama),
    [settings, ollama],
  );
  const providers = settings?.enabledProviders ?? [];
  // An existing thread is bound to the runtime that created it (Claude or
  // Codex) — the other runtime's models stay listed but can't be picked.
  const binding = useMemo(
    () => threadBinding(resumeSessionId, sessions),
    [resumeSessionId, sessions],
  );
  const allowed = (c: ModelChoice) =>
    !binding || providerRuntime(c.provider) === binding.runtime;
  // A pick whose provider was switched off (or a local tag that's gone) would
  // fail at run time — fall back to the default before it can be sent.
  const selected =
    choices.find(
      (c) =>
        c.provider === (modelProvider ?? settings?.authMode) &&
        c.value === model,
    ) ?? null;

  // No valid pick (fresh install, the old "" = CLI-default sentinel, a
  // retired model id, a provider switched off, a local tag that's gone):
  // fall back to Sonnet on
  // the default provider, or failing that the first choice on offer — never
  // send a value that would fail at run time. An existing valid pick is left
  // alone, so the last model used carries over between threads.
  // Opening a thread bound to the other runtime switches the pick too — an
  // OpenAI thread back to the model it last ran with, a Claude one to the
  // default — so the next message can't be sent to the wrong runtime.
  useEffect(() => {
    if (!settings || choices.length === 0) return;
    const fits = (c: ModelChoice) =>
      !binding || providerRuntime(c.provider) === binding.runtime;
    if (selected && fits(selected)) return;
    const usable = choices.filter(fits);
    const fallback =
      (binding?.runtime === "codex"
        ? (usable.find(
            (c) => c.provider === binding.provider && c.value === binding.model,
          ) ?? usable.find((c) => c.provider === binding.provider))
        : undefined) ??
      usable.find(
        (c) => c.value === DEFAULT_MODEL && c.provider === settings.authMode,
      ) ??
      usable.find((c) => c.value === DEFAULT_MODEL) ??
      usable[0];
    // Nothing usable (e.g. the thread's provider was switched off): leave the
    // pick alone — sending explains what to do.
    if (fallback) setModel(fallback.value, fallback.provider);
  }, [settings, choices, selected, binding, setModel]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return choices.filter((c) => {
      if (
        rail === "favorites" &&
        !favorites.includes(choiceKey(c.provider, c.value))
      )
        return false;
      if (rail && rail !== "favorites" && c.provider !== rail) return false;
      if (!q) return true;
      return (
        c.label.toLowerCase().includes(q) ||
        providerMeta(c.provider).label.toLowerCase().includes(q)
      );
    });
  }, [choices, query, rail, favorites]);

  // Pickable models first (so the ⌘1…⌘5 shortcuts always land on one), then
  // starred ones float up — each group keeps its own order.
  const ordered = useMemo(() => {
    const starred = (c: ModelChoice) =>
      favorites.includes(choiceKey(c.provider, c.value));
    const usable = (c: ModelChoice) =>
      !binding || providerRuntime(c.provider) === binding.runtime;
    return [...visible].sort(
      (a, b) =>
        Number(usable(b)) - Number(usable(a)) ||
        Number(starred(b)) - Number(starred(a)),
    );
  }, [visible, favorites, binding]);
  const blockedCount = ordered.filter((c) => !allowed(c)).length;

  // query and rail are the trigger, not values the body reads — changing
  // either resets the cursor to the top of the freshly filtered list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps, see above
  useEffect(() => setCursor(0), [query, rail]);

  // Outside click / Escape close. Bound while open only.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery("");
  }, [open]);

  const toggleFavorite = (c: ModelChoice) => {
    const key = choiceKey(c.provider, c.value);
    const next = favorites.includes(key)
      ? favorites.filter((f) => f !== key)
      : [...favorites, key];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    setFavorites(next);
  };

  const choose = (c: ModelChoice) => {
    if (!allowed(c)) return;
    setModel(c.value, c.provider);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((i) => Math.min(i + 1, ordered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (ordered[cursor]) choose(ordered[cursor]);
      return;
    }
    // ⌘1…⌘5 jump straight to the first five rows, as the shortcut chips promise.
    if (e.metaKey && /^[1-5]$/.test(e.key)) {
      const hit = ordered[Number(e.key) - 1];
      if (hit && allowed(hit)) {
        e.preventDefault();
        choose(hit);
      }
    }
  };

  const TriggerIcon = providerMeta(
    selected?.provider ?? settings?.authMode ?? "subscription-cli",
  ).icon;

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="px-1.5 gap-2"
        title="Choose the model (and the provider that serves it)"
        onClick={() => setOpen((o) => !o)}
      >
        <TriggerIcon size={12} className="shrink-0 text-brand" />
        <span className="truncate">{selected?.label ?? "…"}</span>
        <ChevronDown size={12} className="text-muted-foreground shrink-0" />
      </Button>

      {open && (
        // Not a control: the popup shell, catching arrow/Enter/Escape by
        // delegation for the real controls inside it, which carry their own roles.
        // biome-ignore lint/a11y/noStaticElementInteractions: keyboard delegation shell, see above
        <div
          className="absolute bottom-full left-0 mb-2 z-30 flex w-104 max-w-[80vw] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
          onKeyDown={onKeyDown}
        >
          <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border py-2">
            <RailButton
              active={rail === "favorites"}
              title="Starred models"
              onClick={() =>
                setRail((r) => (r === "favorites" ? null : "favorites"))
              }
            >
              <Star
                size={15}
                className={
                  rail === "favorites" ? "fill-warning text-warning" : ""
                }
              />
            </RailButton>
            {providers.map((id) => {
              const meta = providerMeta(id);
              const Icon = meta.icon;
              return (
                <RailButton
                  key={id}
                  active={rail === id}
                  title={meta.title}
                  onClick={() => setRail((r) => (r === id ? null : id))}
                >
                  <Icon size={15} />
                </RailButton>
              );
            })}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search size={13} className="shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-foreground placeholder:text-muted-foreground focus:outline-none"
                placeholder="Search models…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {binding && blockedCount > 0 && (
              <p className="border-b border-border px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
                This thread runs on{" "}
                {binding.runtime === "codex" ? "OpenAI" : "Claude"} — start a
                new chat to use{" "}
                {binding.runtime === "codex" ? "other" : "OpenAI"} models.
              </p>
            )}
            <div className="max-h-72 overflow-y-auto py-1">
              {ordered.length === 0 && (
                <p className="px-3 py-4 text-center text-[0.6875rem] text-muted-foreground">
                  No models match.
                </p>
              )}
              {ordered.map((c, i) => {
                const key = choiceKey(c.provider, c.value);
                const meta = providerMeta(c.provider);
                const Icon = meta.icon;
                const isSelected = selected
                  ? choiceKey(selected.provider, selected.value) === key
                  : false;
                const usable = allowed(c);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-disabled={!usable}
                    title={
                      usable
                        ? undefined
                        : `This thread runs on ${binding?.runtime === "codex" ? "OpenAI" : "Claude"} — start a new chat to use this model`
                    }
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                      i === cursor && usable && "bg-muted",
                      !usable && "cursor-not-allowed opacity-40",
                    )}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(c)}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[0.8125rem]",
                          isSelected ? "text-brand" : "text-foreground",
                        )}
                      >
                        {c.label}
                      </span>
                      <span className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                        <Icon size={10} className="shrink-0" />
                        <span className="truncate">{meta.label}</span>
                        <span
                          className={cn(
                            "truncate",
                            c.warn
                              ? "text-warning"
                              : "text-muted-foreground/70",
                          )}
                        >
                          · {c.hint}
                        </span>
                        {c.contextWindow && (
                          <span className="shrink-0 text-muted-foreground/70">
                            · {fmtTokens(c.contextWindow)} context
                          </span>
                        )}
                      </span>
                    </span>
                    {i < 5 && usable && (
                      <kbd className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
                        ⌘{i + 1}
                      </kbd>
                    )}
                    {/* A real <button> here would nest inside the row's own
                        button, which is invalid HTML; tabIndex -1 keeps it off
                        the tab ring on purpose. Restructuring the row so the
                        star is a sibling is the actual fix. */}
                    {/* biome-ignore lint/a11y/useSemanticElements: would nest a button in a button, see above */}
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: deliberately not tab-reachable, see above */}
                    <span
                      role="button"
                      tabIndex={-1}
                      title={favorites.includes(key) ? "Unstar" : "Star"}
                      className="shrink-0 p-0.5 text-muted-foreground hover:text-warning"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(c);
                      }}
                    >
                      <Star
                        size={13}
                        className={
                          favorites.includes(key)
                            ? "fill-warning text-warning"
                            : ""
                        }
                      />
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="border-t border-border px-3 py-2 text-left text-[0.6875rem] text-muted-foreground hover:text-foreground"
              onClick={() => {
                setOpen(false);
                useStore.getState().openSettingsAt("providers");
              }}
            >
              Manage providers & models…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RailButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
