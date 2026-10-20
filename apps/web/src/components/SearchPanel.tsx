import {
  ChevronRightIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { EntryIcon } from "@/components/FileTree";
import { ToolbarButton } from "@/components/ToolbarButton";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SIDEBAR_AUTOFOCUS_ATTR } from "@/hooks/use-sidebar-tab";
import { useProject } from "@/project/context";
import { useReveal } from "@/project/reveal-context";
import { replaceMatches, type ReplaceTarget } from "@/search/replace";
import type { FileMatches, SearchMatch } from "@/search/search";
import { setSearchState, useSearchState } from "@/search/search-state";
import { useProjectSearch } from "@/search/useProjectSearch";
import { cn } from "@/lib/utils";

const ROW_ATTR = "data-search-row";

export function SearchPanel() {
  const { project, readOnly, undoManager } = useProject();
  const reveal = useReveal();
  const { replacement, ...query } = useSearchState();
  const { result, searching } = useProjectSearch(project, query);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const found = result && "files" in result ? result : null;
  const files = useMemo(() => found?.files ?? [], [found]);

  function rows(): HTMLElement[] {
    return [
      ...(list.current?.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`) ?? []),
    ];
  }

  function onQueryKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && query.pattern) {
      // Keep the editor's own Escape handling out of it when there is
      // something to clear.
      e.preventDefault();
      e.stopPropagation();
      setSearchState({ pattern: "" });
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      rows()[0]?.focus();
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[Math.min(at + 1, all.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at === 0) input.current?.focus();
      else all[at - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.current?.focus();
    }
  }

  function replace(targets: ReplaceTarget[]) {
    let outcome;
    try {
      outcome = replaceMatches(project, targets, replacement, query, {
        undoManager,
      });
    } catch (err) {
      console.error("replace failed", err);
      toast.error("Replacing failed. See the console for details.");
      return;
    }
    const { replaced, skipped } = outcome;
    const message = `Replaced ${replaced} ${replaced === 1 ? "match" : "matches"}`;
    if (skipped > 0) {
      toast.warning(`${message}, skipped ${skipped} that changed meanwhile`);
    } else if (replaced > 0) {
      toast.success(message);
    }
  }

  const toggle = (
    key: "regex" | "caseSensitive" | "wholeWord",
    label: string,
    face: ReactNode,
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          aria-label={label}
          pressed={query[key]}
          onPressedChange={(pressed) => setSearchState({ [key]: pressed })}
          className="size-6 min-w-6 px-0 font-mono text-[11px]"
        >
          {face}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );

  let summary: ReactNode = null;
  if (result && "error" in result) {
    summary = <span className="text-destructive">{result.error}</span>;
  } else if (found && query.pattern) {
    const { total, truncated } = found;
    const noun = (n: number, word: string) =>
      `${n} ${word}${n === 1 ? "" : "s"}`;
    summary =
      total === 0
        ? "No results"
        : `${noun(total, "result")} in ${noun(files.length, "file")}${truncated ? `, showing first ${total}` : ""}`;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b pl-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase select-none">
          Search
        </span>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-b p-2">
        <div className="relative">
          <Input
            ref={input}
            {...{ [SIDEBAR_AUTOFOCUS_ATTR]: "" }}
            aria-label="Search query"
            placeholder="Search"
            autoComplete="off"
            spellCheck={false}
            value={query.pattern}
            onChange={(e) => setSearchState({ pattern: e.target.value })}
            onKeyDown={onQueryKeyDown}
            className="h-8 pr-[4.75rem] text-sm"
          />
          <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
            {toggle("regex", "Use regular expression", ".*")}
            {toggle("caseSensitive", "Match case", "Aa")}
            {toggle("wholeWord", "Match whole word", <u>ab</u>)}
          </div>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-1">
            <Input
              aria-label="Replacement"
              placeholder="Replace"
              autoComplete="off"
              spellCheck={false}
              value={replacement}
              onChange={(e) => setSearchState({ replacement: e.target.value })}
              className="h-8 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={files.length === 0}
              onClick={() => replace(files)}
            >
              Replace all
            </Button>
          </div>
        )}
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "min-h-4 text-xs text-muted-foreground",
            searching && "opacity-60",
          )}
        >
          {summary}
        </p>
      </div>
      <div
        ref={list}
        onKeyDown={onListKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {files.map((file) => (
          <FileGroup
            key={file.fileId}
            file={file}
            open={!collapsed.has(file.path)}
            onOpenChange={(open) =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (open) next.delete(file.path);
                else next.add(file.path);
                return next;
              })
            }
            readOnly={readOnly}
            onReplaceFile={() =>
              replace([{ fileId: file.fileId, matches: file.matches }])
            }
            onReplaceMatch={(match) =>
              replace([{ fileId: file.fileId, matches: [match] }])
            }
            onOpenMatch={(match) =>
              reveal(file.fileId, {
                kind: "offset",
                from: match.from,
                to: match.to,
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function FileGroup({
  file,
  open,
  onOpenChange,
  readOnly,
  onReplaceFile,
  onReplaceMatch,
  onOpenMatch,
}: {
  file: FileMatches;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly: boolean;
  onReplaceFile: () => void;
  onReplaceMatch: (match: SearchMatch) => void;
  onOpenMatch: (match: SearchMatch) => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="group/file flex items-center pr-1">
        <CollapsibleTrigger
          {...{ [ROW_ATTR]: "" }}
          aria-label={file.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <EntryIcon kind="text" name={name} open={false} />
          <span className="truncate font-medium">{name}</span>
          {slash > 0 && (
            <span className="truncate text-xs text-muted-foreground">
              {file.path.slice(0, slash)}
            </span>
          )}
          <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
            {file.matches.length}
          </span>
        </CollapsibleTrigger>
        {!readOnly && (
          <HoverAction
            icon={ReplaceAllIcon}
            label={`Replace in ${file.path}`}
            onClick={onReplaceFile}
            className="group-focus-within/file:opacity-100 group-hover/file:opacity-100"
          />
        )}
      </div>
      <CollapsibleContent>
        {file.matches.map((match) => (
          <div key={match.from} className="group/match flex items-center pr-1">
            <button
              type="button"
              {...{ [ROW_ATTR]: "" }}
              onClick={() => onOpenMatch(match)}
              className="min-w-0 flex-1 truncate rounded-md py-0.5 pr-1 pl-8 text-left font-mono text-xs outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <PreviewText match={match} />
            </button>
            {!readOnly && (
              <HoverAction
                icon={ReplaceIcon}
                label="Replace this match"
                onClick={() => onReplaceMatch(match)}
                className="group-focus-within/match:opacity-100 group-hover/match:opacity-100"
              />
            )}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function HoverAction({
  icon: Icon,
  label,
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <ToolbarButton
      label={label}
      onClick={onClick}
      // Hidden until hover or focus, but still in the tab order.
      className={cn("size-6 shrink-0 opacity-0", className)}
    >
      <Icon />
    </ToolbarButton>
  );
}

function PreviewText({ match }: { match: SearchMatch }) {
  const { preview, previewFrom, previewTo } = match;
  return (
    <>
      {preview.slice(0, previewFrom).trimStart()}
      <mark className="rounded-sm bg-primary/25 text-foreground">
        {preview.slice(previewFrom, previewTo)}
      </mark>
      {preview.slice(previewTo)}
    </>
  );
}
