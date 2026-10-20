import { ImageIcon, SearchIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { Highlighted } from "@/components/QuickOpen";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SIDEBAR_AUTOFOCUS_ATTR } from "@/hooks/use-sidebar-tab";
import { useEditorCursor } from "@/editor/cursor-store";
import { fuzzyFilter } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import {
  activeItemIndex,
  type ProjectOutlineItem,
} from "@/outline/project-outline";
import { useOutline } from "@/outline/useOutline";
import { useReveal } from "@/project/reveal-context";

const INDENT_REM = 0.75;

function displayTitle(item: ProjectOutlineItem): string {
  if (item.title) return item.title;
  return item.kind === "figure" ? "Figure" : "Untitled";
}

/** Headings and figures of the document, to jump around it. */
export function OutlinePanel() {
  const { items, hasRoot } = useOutline();
  const reveal = useReveal();
  const cursor = useEditorCursor();
  const [query, setQuery] = useState("");
  const rowsRef = useRef<HTMLDivElement>(null);

  const activeIndex = cursor
    ? activeItemIndex(items, cursor.fileId, cursor.head)
    : -1;

  const rows = useMemo(() => {
    const all = items.map((item, index) => ({
      item,
      index,
      path: displayTitle(item),
      positions: [] as number[],
    }));
    if (!query.trim()) return all;
    // The ranking is for picking by name; an outline reads in document order.
    return fuzzyFilter(all, query).sort((a, b) => a.index - b.index);
  }, [items, query]);
  const filtering = query.trim() !== "";

  const [focused, setFocused] = useState(0);
  const focusIndex = Math.min(focused, Math.max(rows.length - 1, 0));

  useEffect(() => {
    rowsRef.current
      ?.querySelector(`[data-active="true"]`)
      // jsdom has no scrollIntoView.
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function focusRow(i: number) {
    const next = Math.max(0, Math.min(i, rows.length - 1));
    setFocused(next);
    rowsRef.current
      ?.querySelector<HTMLElement>(`[data-row="${next}"]`)
      ?.focus();
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLElement>, i: number) {
    if (e.key === "ArrowDown") focusRow(i + 1);
    else if (e.key === "ArrowUp") focusRow(i - 1);
    else if (e.key === "Home") focusRow(0);
    else if (e.key === "End") focusRow(rows.length - 1);
    else return;
    e.preventDefault();
  }

  function jump(item: ProjectOutlineItem) {
    reveal(item.fileId, { kind: "offset", from: item.from, to: item.from });
  }

  let body;
  if (!hasRoot) {
    body = (
      <Notice>Add a main .typ file, or open one, to see its outline.</Notice>
    );
  } else if (items.length === 0) {
    body = <Notice>Add a heading with = to see it here.</Notice>;
  } else if (rows.length === 0) {
    body = <Notice>No matching entries</Notice>;
  } else {
    body = (
      <div
        ref={rowsRef}
        role="tree"
        aria-label="Outline"
        className="flex flex-col gap-px p-1"
      >
        {rows.map(({ item, index, path: title, positions }, i) => (
          <div
            key={index}
            role="treeitem"
            aria-selected={index === activeIndex}
            aria-level={filtering ? 1 : item.depth + 1}
            data-row={i}
            data-active={index === activeIndex}
            tabIndex={i === focusIndex ? 0 : -1}
            title={item.path}
            onFocus={() => setFocused(i)}
            onClick={() => jump(item)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                jump(item);
              } else onRowKeyDown(e, i);
            }}
            style={{
              paddingLeft: `${(filtering ? 0 : item.depth) * INDENT_REM + 0.5}rem`,
            }}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
              index === activeIndex && "bg-accent text-accent-foreground",
              item.kind === "heading" && item.depth === 0 && "font-medium",
            )}
          >
            {item.kind === "figure" && (
              <ImageIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <Highlighted
              text={title}
              offset={0}
              positions={positions}
              className={cn(
                "min-w-0 truncate",
                item.kind === "figure" && "text-muted-foreground",
              )}
            />
            {item.label && (
              <span className="ml-auto max-w-[40%] shrink-0 truncate rounded border px-1 text-[10px] font-medium text-muted-foreground">
                {item.label}
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b pl-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase select-none">
          Outline
        </span>
      </div>
      {items.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3">
          <SearchIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <input
            {...{ [SIDEBAR_AUTOFOCUS_ATTR]: "" }}
            aria-label="Filter outline"
            autoComplete="off"
            spellCheck={false}
            placeholder="Filter"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFocused(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && rows.length) {
                e.preventDefault();
                focusRow(0);
              } else if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">{body}</ScrollArea>
    </div>
  );
}

function Notice({ children }: { children: string }) {
  return (
    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}
