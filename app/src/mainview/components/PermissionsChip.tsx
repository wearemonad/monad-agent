import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Shield } from "lucide-react";
import type { McpServerInfo, WorkspaceInfo } from "../../shared/ipc";
import {
  BUILTIN_TOOL_OPTIONS,
  GOOGLE_TOOL_OPTIONS,
  INTERNAL_ALLOW_RULES,
  TOOL_GROUP_ORDER,
  connectorToolOption,
  customToolOption,
  type ToolOption,
} from "../../shared/toolCatalog";
import { useStore } from "../store";
import { api } from "../rpc";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/** Composer-bar chip for the active workspace's always-allowed tools. Click
 *  opens a popover listing the tool catalog with a switch per tool — the fast
 *  way to audit and change what the agent may run without asking, with the
 *  full picker (custom rules etc.) a link away in Settings. */
export function PermissionsChip({ active }: { active?: WorkspaceInfo }) {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Outside click / Escape close. Bound while open only. Escape is claimed
  // (preventDefault) or AppKit answers the unhandled key with the alert beep.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Installed connectors decide which mcp__*__* switches to offer — same
  // sourcing as the settings picker, fetched lazily on first open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only when the workspace id changes, not on every workspace object update.
  useEffect(() => {
    if (!open || !active) return;
    void api.mcpList(active.id).then((r) => setServers(r.servers));
  }, [open, active?.id]);

  const rules = active?.alwaysAllow ?? [];
  // App-internal plumbing rules stay out of the list AND the chip's count, so
  // the number always matches the switches shown. setRule still edits the
  // full stored list, leaving the hidden rules untouched. Memoized so the
  // options memo below keys on a stable reference.
  const visibleRules = useMemo(
    () => rules.filter((r) => !INTERNAL_ALLOW_RULES.has(r)),
    [rules],
  );

  const options = useMemo(() => {
    const opts: ToolOption[] = [
      ...BUILTIN_TOOL_OPTIONS,
      ...(active?.drive ? GOOGLE_TOOL_OPTIONS : []),
      ...servers.map((s) => connectorToolOption(s.name)),
    ];
    // Keep any current rule we don't recognize (hand-typed) toggleable too.
    const known = new Set(opts.map((o) => o.rule));
    for (const rule of visibleRules) {
      if (!known.has(rule)) {
        opts.push(customToolOption(rule));
        known.add(rule);
      }
    }
    return opts;
  }, [active?.drive, servers, visibleRules]);

  const groups = TOOL_GROUP_ORDER.map((g) => ({
    label: g,
    items: options.filter((o) => o.group === g),
  })).filter((g) => g.items.length > 0);

  const setRule = (rule: string, on: boolean) => {
    if (!active) return;
    const next = on ? [...rules, rule] : rules.filter((r) => r !== rule);
    void api.setAlwaysAllow(active.id, next);
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="px-1.5 gap-2"
        title="Tools in this list run without asking — click to review"
        onClick={() => (active ? setOpen((o) => !o) : undefined)}
      >
        <Shield size={12} />{" "}
        {active ? `${visibleRules.length} auto-allowed` : "permissions"}
      </Button>

      {open && active && (
        <div className="absolute bottom-full left-0 mb-2 z-30 w-80 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
          <div className="px-3 pt-2.5 pb-1.5">
            <p className="text-xs font-medium text-foreground">
              Runs without asking
            </p>
            <p className="text-[0.6875rem] text-muted-foreground">
              Switched-off tools still work — the agent just asks first.
            </p>
          </div>
          <div className="max-h-72 overflow-y-auto px-1.5 pb-1.5">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-1.5 pt-1.5 pb-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                {group.items.map((opt) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: the Switch inside is the control; Biome can't see through the component.
                  <label
                    key={opt.rule}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-xs text-foreground">
                          {opt.label}
                        </span>
                        {opt.sensitive && (
                          <span className="shrink-0 text-[0.5625rem] uppercase tracking-wide text-warning">
                            powerful
                          </span>
                        )}
                      </span>
                      <span
                        className="block truncate text-[0.6875rem] text-muted-foreground"
                        title={opt.rule}
                      >
                        {opt.description}
                      </span>
                    </span>
                    <Switch
                      size="sm"
                      checked={rules.includes(opt.rule)}
                      onCheckedChange={(on) => setRule(opt.rule, on)}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-2 text-left text-[0.6875rem] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => {
              setOpen(false);
              useStore.getState().openSettingsAt("workspaces");
            }}
          >
            <ExternalLink size={11} /> Manage in Settings
          </button>
        </div>
      )}
    </div>
  );
}
