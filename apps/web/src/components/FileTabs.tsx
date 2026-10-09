import { XIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { EntryIcon } from "@/components/FileTree";
import { basename, dirname } from "@/doc/names";
import { cn } from "@/lib/utils";
import { useProject } from "@/project/context";

/** One tab per open file; the active one is what the editor shows. */
export function FileTabs() {
  const { index, tabs, openFileId, openFile, closeFile } = useProject();
  const strip = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const list = tabs.flatMap((id) => {
      const entry = index.byId.get(id);
      if (!entry) return [];
      return [
        { id, path: entry.path, kind: entry.kind, name: basename(entry.path) },
      ];
    });
    // Two open "intro.typ"s are only told apart by their folder.
    const counts = new Map<string, number>();
    for (const e of list) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    return list.map((e) => ({
      ...e,
      folder: counts.get(e.name)! > 1 ? dirname(e.path) || "/" : null,
    }));
  }, [tabs, index]);

  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [openFileId]);

  if (entries.length === 0) return null;

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Open files"
      className="flex h-9 shrink-0 [scrollbar-width:none] overflow-x-auto overflow-y-hidden border-b bg-muted/30"
    >
      {entries.map((tab) => {
        const active = tab.id === openFileId;
        return (
          <div
            key={tab.id}
            role="presentation"
            className={cn(
              "group relative flex max-w-56 shrink-0 items-center border-r text-xs",
              active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              closeFile(tab.id);
            }}
          >
            {active && (
              <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
            )}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.path}
              className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-3 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => openFile(tab.id)}
            >
              <EntryIcon
                kind={tab.kind}
                name={tab.name}
                open={false}
                className="size-3.5 text-current"
              />
              <span className="truncate">{tab.name}</span>
              {tab.folder !== null && (
                <span className="truncate text-muted-foreground">
                  {tab.folder}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.path}`}
              title="Close"
              className={cn(
                "mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-muted focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
                !active && "opacity-0 group-hover:opacity-100",
              )}
              onClick={() => closeFile(tab.id)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
