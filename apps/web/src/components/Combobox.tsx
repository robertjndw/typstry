import { CheckIcon, ChevronsUpDownIcon, Loader2Icon } from "lucide-react";
import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Shown muted after the label, like a file count. */
  hint?: string;
  /** Shown as a small tag, like "default". */
  badge?: string;
  /** Options with the same group are listed under that heading. */
  group?: string;
}

/** Rendering thousands of rows makes the popover sluggish; filtering finds the rest. */
const MAX_SHOWN = 200;

export interface ComboboxProps {
  id?: string;
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  /** Shown on the trigger when nothing matches `value`, or while loading. */
  placeholder: string;
  searchPlaceholder: string;
  disabled?: boolean;
  loading?: boolean;
  "aria-describedby"?: string;
  /** Rendered in the trigger in place of the selected option's label. */
  renderValue?: (option: ComboboxOption) => ReactNode;
}

/** A button that opens a filterable list, for lists too long for a select. */
export function Combobox({
  id,
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder,
  disabled,
  loading,
  renderValue,
  ...aria
}: ComboboxProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? options.filter((o) => o.label.toLowerCase().includes(q))
      : options;
  }, [options, query]);
  const shown = matches.slice(0, MAX_SHOWN);

  function openChange(next: boolean) {
    setOpen(next);
    if (next) {
      setQuery("");
      setActive(Math.max(0, options.indexOf(selected!)));
    }
  }

  function pick(option: ComboboxOption) {
    onChange(option.value);
    setOpen(false);
  }

  function move(to: number) {
    const next = Math.min(Math.max(to, 0), shown.length - 1);
    setActive(next);
    list.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(shown.length - 1);
    else if (e.key === "Enter" && shown[active]) pick(shown[active]);
    else return;
    e.preventDefault();
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-describedby={aria["aria-describedby"]}
          className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              (!selected || loading) && "text-muted-foreground",
            )}
          >
            {loading || !selected
              ? placeholder
              : renderValue
                ? renderValue(selected)
                : selected.label}
          </span>
          {loading ? (
            <Loader2Icon
              aria-hidden
              className="size-4 shrink-0 animate-spin text-muted-foreground"
            />
          ) : (
            <ChevronsUpDownIcon
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[max(var(--radix-popover-trigger-width),min(24rem,calc(100vw-2rem)))] p-0"
        onOpenAutoFocus={(e) => {
          // Focus the filter rather than the first focusable row.
          e.preventDefault();
          const content = e.currentTarget as HTMLElement;
          content.querySelector<HTMLInputElement>("input")?.focus();
          content
            .querySelector('[aria-selected="true"]')
            ?.scrollIntoView({ block: "nearest" });
        }}
      >
        <input
          role="searchbox"
          aria-label={searchPlaceholder}
          aria-controls={listId}
          aria-activedescendant={
            shown[active] ? `${listId}-${active}` : undefined
          }
          value={query}
          placeholder={searchPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div
          ref={list}
          id={listId}
          role="listbox"
          className="max-h-64 overflow-y-auto p-1"
        >
          {shown.length === 0 && (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">
              Nothing matches “{query.trim()}”
            </p>
          )}
          {shown.map((option, i) => (
            <div key={option.value}>
              {option.group && option.group !== shown[i - 1]?.group && (
                <div
                  role="presentation"
                  className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                >
                  {option.group}
                </div>
              )}
              <div
                id={`${listId}-${i}`}
                role="option"
                data-index={i}
                aria-selected={option.value === value}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(option)}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  i === active && "bg-muted",
                )}
              >
                <CheckIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0",
                    option.value !== value && "invisible",
                  )}
                />
                <span className="min-w-0 truncate">{option.label}</span>
                {option.badge && (
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[0.7rem] text-muted-foreground">
                    {option.badge}
                  </span>
                )}
                {option.hint && (
                  <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                )}
              </div>
            </div>
          ))}
          {matches.length > shown.length && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {matches.length - shown.length} more, type to narrow down
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
