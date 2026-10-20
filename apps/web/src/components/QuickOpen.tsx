import type { TreeID } from "loro-crdt";
import { SearchIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { EntryIcon } from "@/components/FileTree";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { fuzzyFilter } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { useProject } from "@/project/context";

// Plenty for picking by name; rendering thousands of rows would only lag.
const MAX_RESULTS = 50;

/** Jump to any file by typing part of its path. */
export function QuickOpen({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">Open file</DialogTitle>
        <DialogDescription className="sr-only">
          Type part of a file name, then pick a file with the arrow keys and
          Enter.
        </DialogDescription>
        {/* Mounted only while open so every opening starts empty. */}
        {open && <QuickOpenBody onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function QuickOpenBody({ onDone }: { onDone: () => void }) {
  const { index, openFile, openFileId } = useProject();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const files = useMemo(
    () =>
      [...index.byId]
        .filter(([, entry]) => entry.kind !== "dir")
        .map(([id, entry]) => ({ id, path: entry.path, kind: entry.kind })),
    [index],
  );
  const results = useMemo(
    () => fuzzyFilter(files, query).slice(0, MAX_RESULTS),
    [files, query],
  );
  const current = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${current}"]`)
      // jsdom has no scrollIntoView.
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  function choose(id: TreeID) {
    openFile(id);
    onDone();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const count = results.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      if (count) setActive((current + 1) % count);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      if (count) setActive((current - 1 + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[current];
      if (hit) choose(hit.id);
    }
  }

  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className="flex max-h-[min(28rem,70vh)] flex-col">
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon aria-hidden className="size-4 text-muted-foreground" />
        <input
          role="combobox"
          aria-label="File name"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(current) : undefined}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Search files by name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Files"
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {results.map((file, i) => {
          const slash = file.path.lastIndexOf("/");
          const name = file.path.slice(slash + 1);
          return (
            <li
              key={file.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              data-index={i}
              onMouseMove={() => i !== current && setActive(i)}
              // Keep focus in the input so typing can continue.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(file.id)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                i === current && "bg-accent text-accent-foreground",
              )}
            >
              <EntryIcon kind={file.kind} name={name} open={false} />
              <Highlighted
                text={name}
                offset={slash + 1}
                positions={file.positions}
                className="shrink-0 truncate font-medium"
              />
              {slash > 0 && (
                <Highlighted
                  text={file.path.slice(0, slash)}
                  offset={0}
                  positions={file.positions}
                  className="min-w-0 truncate text-xs text-muted-foreground"
                />
              )}
              {file.id === openFileId && (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  open
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {results.length === 0 && (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {files.length === 0
            ? "This project has no files"
            : "No matching files"}
        </p>
      )}
    </div>
  );
}

/** `text` with the matched characters emphasized. */
export function Highlighted({
  text,
  offset,
  positions,
  className,
}: {
  text: string;
  /** Where `text` starts in the string the positions refer to. */
  offset: number;
  positions: number[];
  className?: string;
}) {
  const hits = new Set(positions);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i + offset);
    const last = parts.at(-1);
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i]!, hit });
  }
  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.hit ? (
          <mark
            key={i}
            className="bg-transparent text-foreground underline decoration-primary/60 underline-offset-2"
          >
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
