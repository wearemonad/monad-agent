import { Fragment } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunOptions } from "../../shared/ipc";
import { useStore } from "../store";
import {
  choiceKey,
  controlsFor,
  resolveRunOptions,
  runOptionsLabel,
  type ControlOption,
} from "../lib/models";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The composer's second dropdown: reasoning level, context window and speed
 *  for the picked model — only the sections that model offers, each with its
 *  own default. Picks are remembered per model. Hidden for models without
 *  controls (Ollama). */
export function RunOptionsPicker() {
  const model = useStore((s) => s.model);
  const modelProvider = useStore((s) => s.modelProvider);
  const authMode = useStore((s) => s.settings?.authMode ?? null);
  const stored = useStore((s) => s.runOptions);
  const setRunOptions = useStore((s) => s.setRunOptions);

  const provider = modelProvider ?? authMode;
  const controls = controlsFor(provider, model);
  if (!provider || !controls) return null;
  const key = choiceKey(provider, model);
  const current = resolveRunOptions(controls, stored[key]);
  if (!current) return null;

  const sections: {
    title: string;
    field: keyof RunOptions;
    options: ControlOption[];
    default: string;
  }[] = [
    { title: "Reasoning", field: "effort", ...controls.reasoning },
    ...(controls.context
      ? [
          {
            title: "Context Window",
            field: "context" as const,
            ...controls.context,
          },
        ]
      : []),
    ...(controls.speed ? [{ field: "speed" as const, ...controls.speed }] : []),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5 gap-1.5 text-muted-foreground"
            title="Reasoning, context and speed for this model"
          />
        }
      >
        <span className="truncate">{runOptionsLabel(controls, current)}</span>
        <ChevronDown size={12} className="shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 p-1.5"
      >
        {sections.map((section, i) => (
          <Fragment key={section.field}>
            {i > 0 && <DropdownMenuSeparator className="my-1.5" />}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-2 pt-1.5 pb-1">
                {section.title}
              </DropdownMenuLabel>
              {section.options.map((option) => {
                const selected = current[section.field] === option.value;
                return (
                  <DropdownMenuItem
                    key={option.value}
                    className={cn(
                      "flex-col items-start gap-0.5 px-2 py-1.5",
                      selected && "bg-muted",
                    )}
                    onClick={() =>
                      setRunOptions(key, { [section.field]: option.value })
                    }
                  >
                    <span className="flex items-center gap-1.5 text-[0.8125rem]">
                      {option.label}
                      {option.value === section.default && (
                        <span className="rounded border border-border px-1 py-px text-[0.625rem] text-muted-foreground">
                          Default
                        </span>
                      )}
                    </span>
                    {option.hint && (
                      <span className="text-[0.6875rem] leading-snug text-muted-foreground">
                        {option.hint}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
