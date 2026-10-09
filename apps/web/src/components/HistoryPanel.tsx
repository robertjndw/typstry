import type { PeerID } from "loro-crdt";
import {
  BookmarkPlusIcon,
  HistoryIcon,
  Loader2Icon,
  TagIcon,
} from "lucide-react";
import { useMemo } from "react";

import { PersonAvatar } from "@/components/PresenceBar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { GroupingOptions } from "@/doc/history";
import type { ProjectDoc } from "@/doc/schema";
import { cn } from "@/lib/utils";
import {
  buildHistoryItems,
  formatRelative,
  type HistoryItem,
  type VersionTarget,
} from "@/project/history-items";
import { useHistory } from "@/project/useHistory";

export interface HistoryPanelProps {
  project: ProjectDoc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grouping: GroupingOptions;
  selected: string | null;
  onSelect: (target: VersionTarget) => void;
  /** Names the current state; omitted for view links, which cannot. */
  onSaveVersion?: () => void;
}

export function HistoryPanel({
  project,
  open,
  onOpenChange,
  grouping,
  selected,
  onSelect,
  onSaveVersion,
}: HistoryPanelProps) {
  const data = useHistory(project, open, grouping);
  const items = useMemo(
    () => (data ? buildHistoryItems(project, data) : null),
    [project, data],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 gap-0 sm:max-w-80">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4" />
            History
          </SheetTitle>
          <SheetDescription>
            Edits grouped into sessions. Select one to view or restore it.
          </SheetDescription>
          {onSaveVersion && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              onClick={onSaveVersion}
            >
              <BookmarkPlusIcon />
              Save version
            </Button>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!items ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
            >
              <Loader2Icon className="size-4 animate-spin" />
              Loading history…
            </div>
          ) : (
            <ul aria-label="Versions" className="divide-y">
              {items.map((item) => (
                <li key={item.target.key}>
                  <HistoryRow
                    item={item}
                    project={project}
                    selected={selected === item.target.key}
                    onSelect={() => onSelect(item.target)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HistoryRow({
  item,
  project,
  selected,
  onSelect,
}: {
  item: HistoryItem;
  project: ProjectDoc;
  selected: boolean;
  onSelect: () => void;
}) {
  const { target, kind } = item;
  const named = kind === "named";
  const when = target.time !== null ? formatRelative(target.time) : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-1 px-4 py-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted",
        named && "border-l-2 border-primary bg-primary/5",
        selected && "bg-muted",
      )}
    >
      <span className="flex items-center gap-2">
        {named && <TagIcon className="size-3.5 shrink-0 text-primary" />}
        <span className={cn("truncate", named && "font-medium")}>
          {named ? target.label : (when ?? "Unknown time")}
        </span>
        <span className="ml-auto flex shrink-0 -space-x-1.5">
          {authorIdentities(project, item.authors)
            .slice(0, 4)
            .map((identity) => (
              <span key={identity.key} title={identity.name}>
                <PersonAvatar identity={identity} />
              </span>
            ))}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {named ? `${when ?? ""} · ${item.detail}` : item.detail}
        {!named && target.time !== null && (
          <span className="sr-only"> ({target.label})</span>
        )}
      </span>
    </button>
  );
}

const UNKNOWN = { name: "Unknown", color: "#71717a" };

/**
 * Every page load is a new Loro peer, so one person shows up under several
 * peer ids. Collapse those that look identical.
 */
function authorIdentities(project: ProjectDoc, peers: PeerID[]) {
  const seen = new Map<string, { key: string; name: string; color: string }>();
  for (const peer of peers) {
    const info = project.getPeer(peer) ?? UNKNOWN;
    const key = `${info.name}\u0000${info.color}`;
    if (!seen.has(key)) seen.set(key, { key, ...info });
  }
  return [...seen.values()];
}
