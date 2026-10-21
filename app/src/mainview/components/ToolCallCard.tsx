import { useState } from "react";
import { Brain, ChevronRight, Wrench, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatItem } from "../../shared/ipc";

/** One chevron for every disclosure in the transcript, rotated rather than
 *  swapped — the same treatment as the sidebar's section headers. */
function DisclosureChevron({
  open,
  className,
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <ChevronRight
      size={11}
      aria-hidden
      className={cn(
        "shrink-0 transition-[rotate] duration-150 ease-out motion-reduce:transition-none",
        open && "rotate-90",
        className,
      )}
    />
  );
}

/** The chat items that fold into one activity accordion between messages. */
export type ActivityItem = Extract<ChatItem, { type: "tool" | "thinking" }>;

/** Quiet, inline tool-call row — faded and small, expandable for details. */
export function ToolCallCard({
  item,
}: {
  item: Extract<ChatItem, { type: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1.5 max-w-full px-1 py-0.5 text-left text-muted-foreground hover:text-foreground transition-colors group"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="shrink-0 text-muted-foreground">
          {item.isError ? (
            <XCircle size={12} className="text-destructive/70" />
          ) : (
            <Wrench size={12} />
          )}
        </span>
        <span className="font-mono truncate opacity-75">
          {item.inputSummary}
        </span>
        {/* Revealed on hover while closed; stays visible once open, so the
            expanded state never depends on the pointer being there. */}
        <span
          className={cn(
            "shrink-0 text-muted-foreground transition-opacity duration-150 group-focus-visible:opacity-100",
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <DisclosureChevron open={open} />
        </span>
      </button>
      {open && item.output != null && (
        <pre className="ml-6 mt-0.5 mb-1 text-[0.6875rem] text-muted-foreground whitespace-pre-wrap max-h-56 overflow-y-auto">
          {item.output || "(no output)"}
        </pre>
      )}
    </div>
  );
}

/** Reasoning text — only shown inside an expanded activity accordion. */
function ThinkingBlock({ text }: { text: string }) {
  return (
    <div className="flex gap-1.5 px-1 py-0.5 text-[0.6875rem] text-muted-foreground/80">
      <Brain size={12} className="shrink-0 mt-0.5 opacity-60" />
      <p className="italic whitespace-pre-wrap max-h-40 overflow-y-auto">
        {text}
      </p>
    </div>
  );
}

/** T3-style activity accordion: a run of consecutive tool calls + reasoning
 *  collapses to a single "N tool calls" toggle row, so long agent runs don't
 *  flood the transcript. While a tool is running, the collapsed row shows the
 *  live call (the orb below the transcript is the only loading indicator);
 *  a failed step leaves a red dot as a trace. */
export function ActivityGroup({ entries }: { entries: ActivityItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const tools = entries.filter((e) => e.type === "tool");
  const pending = tools.find((t) => t.pending);
  const hasError = tools.some((t) => t.isError);
  const noun = tools.length === entries.length ? "tool call" : "step";
  const label =
    tools.length === 0
      ? "Reasoning"
      : `${entries.length} ${noun}${entries.length === 1 ? "" : "s"}`;

  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex items-center gap-1.5 max-w-full px-1 py-0.5 text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <DisclosureChevron open={expanded} />
        <span className="shrink-0">{expanded ? "Hide" : label}</span>
        {!expanded && hasError && (
          <XCircle size={11} className="text-destructive/70 shrink-0" />
        )}
        {!expanded && pending && (
          <span className="font-mono truncate opacity-75">
            {pending.inputSummary}
          </span>
        )}
      </button>
      {expanded &&
        entries.map((e, i) =>
          e.type === "tool" ? (
            <ToolCallCard key={e.toolUseId} item={e} />
          ) : (
            // Thinking blocks have no id, and this list is append-only during a
            // run — never reordered or spliced. Keying on the text instead would
            // remount the block on every streamed token.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only list, see above
            <ThinkingBlock key={`think-${i}`} text={e.text} />
          ),
        )}
    </div>
  );
}
