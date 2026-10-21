import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { TOOL_GROUP_ORDER, type ToolOption } from "../../shared/toolCatalog";

type ToolGroupItems = { value: string; items: ToolOption[] };

/** Multi-select combobox for a workspace's always-allowed tools. Renders the
 *  current rules as removable chips and lets the user pick from a grouped,
 *  described catalog instead of typing raw rule strings. Values are ToolOptions;
 *  the parent maps them to/from the workspace's string[] of rules. */
export function ToolPicker({
  options,
  value,
  onChange,
}: {
  /** Everything selectable — builtins, Google, installed connectors, and a
   *  fallback option for any current rule we don't recognize. */
  options: ToolOption[];
  /** Rules currently on the workspace (subset of options' rules). */
  value: string[];
  onChange: (rules: string[]) => void;
}) {
  const anchor = useComboboxAnchor();
  const byRule = new Map(options.map((o) => [o.rule, o]));
  const selected = value
    .map((r) => byRule.get(r))
    .filter((o): o is ToolOption => !!o);

  const groups: ToolGroupItems[] = TOOL_GROUP_ORDER.map((g) => ({
    value: g,
    items: options.filter((o) => o.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <Combobox
      items={groups}
      multiple
      value={selected}
      onValueChange={(next: ToolOption[]) => onChange(next.map((o) => o.rule))}
      itemToStringLabel={(o: ToolOption) => o.label}
      itemToStringValue={(o: ToolOption) => o.rule}
      isItemEqualToValue={(a: ToolOption, b: ToolOption) => a.rule === b.rule}
    >
      {/* React 18 strips `ref` on the plain-function ComboboxChips wrapper, so
          attach the popup anchor to the real DOM node via Base UI's render prop. */}
      <ComboboxChips render={<div ref={anchor} />} className="w-full">
        <ComboboxValue>
          {selected.map((o) => (
            <ComboboxChip
              key={o.rule}
              aria-label={o.label}
              title={o.rule}
              className="px-1.5"
            >
              {o.label}
            </ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput
          placeholder={selected.length ? "Add another…" : "Add a tool…"}
        />
      </ComboboxChips>

      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No matching tools.</ComboboxEmpty>
        <ComboboxList>
          {(group: ToolGroupItems) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel className="text-[0.625rem] font-medium uppercase tracking-wide">
                {group.value}
              </ComboboxLabel>
              <ComboboxCollection>
                {(item: ToolOption) => (
                  <ComboboxItem
                    key={item.rule}
                    value={item}
                    className="items-start py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-xs font-medium text-foreground">
                          {item.label}
                        </span>
                        {item.sensitive && (
                          <span className="text-[0.5625rem] uppercase tracking-wide text-warning">
                            powerful
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[0.6875rem] text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
