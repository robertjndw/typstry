import type { ProjectAssets } from "@/assets/project-assets";
import {
  DiffIcon,
  EyeIcon,
  HistoryIcon,
  TagIcon,
  TagsIcon,
  XIcon,
} from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { PersonAvatar } from "@/components/PresenceBar";
import type { TagTarget } from "@/components/TagVersionDialog";
import { VersionPreviewDialog } from "@/components/VersionPreviewDialog";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { tagAt, type GroupingOptions } from "@/doc/history";
import { useRoster } from "@/mls/context";
import type { ProjectDoc } from "@/doc/schema";
import {
  deleteVersion,
  undeleteVersion,
  type NamedVersion,
} from "@/doc/versions";
import { readJson, writeJson } from "@/lib/storage";
import { cn } from "@/lib/utils";
import {
  authorIdentities,
  buildHistoryItems,
  formatAbsolute,
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
  /**
   * Tags the current state or a revision. Omitted for view links, which
   * can neither tag nor untag.
   */
  onTag?: (target: TagTarget) => void;
  /** Opens the version straight into its diff. */
  onShowChanges?: (target: VersionTarget) => void;
  /** For compiling previews; null when the project has none. */
  assets: ProjectAssets | null;
  /** The project title, for preview PDF file names. */
  title: string;
}

const TAGGED_ONLY_KEY = "typstry:history-tagged-only";

export function HistoryPanel({
  project,
  open,
  onOpenChange,
  grouping,
  selected,
  onSelect,
  onTag,
  onShowChanges,
  assets,
  title,
}: HistoryPanelProps) {
  const data = useHistory(project, open, grouping);
  const memberOfPeer = useRoster()?.memberOfPeer;
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [taggedOnly, setTaggedOnly] = useState(
    () => readJson(TAGGED_ONLY_KEY) === true,
  );
  // The list refreshes a moment after the doc changes; until then a removed
  // tag would linger.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const items = useMemo(() => {
    if (!data) return null;
    return buildHistoryItems(project, data).map((item) => ({
      ...item,
      tags: item.tags.filter((tag) => !removed.has(tag.id)),
    }));
  }, [project, data, removed]);
  // `data` changes with every refresh, so this follows edits and new tags.
  const latestTag = useMemo(
    () => (data ? tagAt(project) : undefined),
    [project, data],
  );
  const currentTag =
    latestTag && !removed.has(latestTag.id) ? latestTag : undefined;
  const shown = taggedOnly
    ? items?.filter((item) => item.tags.length > 0)
    : items;

  function untag(tag: NamedVersion) {
    try {
      deleteVersion(project, tag);
    } catch (err) {
      console.error(err);
      toast.error("Removing the tag failed. See the console for details.");
      return;
    }
    setRemoved((ids) => new Set(ids).add(tag.id));
    toast.success(`Removed tag "${tag.name}"`, {
      action: {
        label: "Undo",
        onClick: () => {
          undeleteVersion(project, tag);
          setRemoved((ids) => {
            const next = new Set(ids);
            next.delete(tag.id);
            return next;
          });
        },
      },
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Otherwise the preview would pop up again with the panel.
        if (!next) setPreviewing(null);
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="w-80 gap-0 sm:max-w-80">
        <SheetHeader className="border-b">
          {/* Right padding keeps the filter clear of the close button. */}
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle className="flex items-center gap-2">
              <HistoryIcon className="size-4" />
              History
            </SheetTitle>
            {/* No tooltip: the panel focuses this first when it opens. */}
            <Toggle
              size="sm"
              variant="outline"
              pressed={taggedOnly}
              onPressedChange={(pressed) => {
                setTaggedOnly(pressed);
                writeJson(TAGGED_ONLY_KEY, pressed);
              }}
              aria-label="Tagged only"
              title="Show only tagged versions"
              className="ml-auto h-6 gap-1 px-2 text-xs"
            >
              <TagsIcon />
              Tagged
            </Toggle>
          </div>
          <SheetDescription>
            Edits grouped into sessions. Select one to view or restore it, or
            tag it to find it again.
          </SheetDescription>
          {onTag &&
            (currentTag ? (
              <p className="mt-2 flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed px-2.5 text-xs text-muted-foreground">
                <TagIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">
                  Current version is tagged &ldquo;{currentTag.name}&rdquo;
                </span>
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                onClick={() => onTag({ kind: "current" })}
              >
                <TagIcon />
                Tag current version
              </Button>
            ))}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!shown ? (
            <LoadingRows />
          ) : shown.length === 0 ? (
            <EmptyState taggedOnly={taggedOnly} />
          ) : (
            <ul aria-label="Versions" className="divide-y">
              {shown.map((item) => (
                <li key={item.target.key}>
                  <HistoryRow
                    item={item}
                    project={project}
                    selected={selected === item.target.key}
                    onSelect={() => onSelect(item.target)}
                    onTag={
                      // One tag per version.
                      onTag && item.tags.length === 0
                        ? () =>
                            onTag({
                              kind: "revision",
                              frontiers: item.target.frontiers,
                              when:
                                item.target.time !== null
                                  ? formatRelative(item.target.time)
                                  : "an unknown time",
                            })
                        : undefined
                    }
                    onUntag={onTag && untag}
                    onShowChanges={
                      onShowChanges && (() => onShowChanges(item.target))
                    }
                    onPreview={() => setPreviewing(item.target.key)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Inside the sheet's tree on purpose: Radix only treats a dialog as
            nested in it then, and a sibling would close the panel as soon
            as it takes focus. */}
        {shown && (
          <VersionPreviewDialog
            project={project}
            items={shown}
            current={previewing}
            onNavigate={setPreviewing}
            onClose={() => setPreviewing(null)}
            assets={assets}
            title={title}
            authorsOf={(item) =>
              // "Unknown" says nothing in a sentence; leave those out.
              authorIdentities(
                project,
                item.authors.filter(
                  (peer) => memberOfPeer?.(peer) ?? project.getPeer(peer),
                ),
                memberOfPeer,
              ).map((a) => a.name)
            }
            onOpenVersion={(target) => {
              setPreviewing(null);
              onSelect(target);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function EmptyState({ taggedOnly }: { taggedOnly: boolean }) {
  const Icon = taggedOnly ? TagsIcon : HistoryIcon;
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon aria-hidden className="size-6 text-muted-foreground/70" />
      <p className="text-sm font-medium">
        {taggedOnly ? "No tagged versions yet" : "No history yet"}
      </p>
      <p className="text-xs text-muted-foreground">
        {taggedOnly
          ? "Tag a version with the tag icon on its row, or tag the current one above."
          : "Edits show up here as sessions once you start writing."}
      </p>
    </div>
  );
}

function HistoryRow({
  item,
  project,
  selected,
  onSelect,
  onTag,
  onUntag,
  onShowChanges,
  onPreview,
}: {
  item: HistoryItem;
  project: ProjectDoc;
  selected: boolean;
  onSelect: () => void;
  onTag?: () => void;
  onUntag?: (tag: NamedVersion) => void;
  onShowChanges?: () => void;
  onPreview?: () => void;
}) {
  const { target, tags } = item;
  const memberOfPeer = useRoster()?.memberOfPeer;
  const when = target.time !== null ? formatRelative(target.time) : null;
  const exact = target.time !== null ? formatAbsolute(target.time) : undefined;
  const titleId = useId();

  return (
    <div
      className={cn(
        "group/row relative px-4 pt-2.5 pb-2 text-sm hover:bg-muted/60",
        selected &&
          "bg-muted before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-foreground hover:bg-muted",
      )}
    >
      {/* Its ::after covers the whole row, so the row opens the version
          anywhere outside the tag and action buttons, which sit above it.
          Those cannot live inside the button: buttons do not nest. */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={exact}
        className="flex w-full items-center gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
      >
        <span id={titleId} className="shrink-0">
          {when ?? "Unknown time"}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {item.detail}
        </span>
        <span className="ml-auto flex shrink-0 -space-x-1.5">
          {authorIdentities(project, item.authors, memberOfPeer)
            .slice(0, 4)
            .map((identity) => (
              <span key={identity.key} title={identity.name}>
                <PersonAvatar identity={identity} />
              </span>
            ))}
        </span>
      </button>
      <div className="relative z-10 mt-1 flex min-h-6 items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {tags.map((tag) => (
            <TagBadge
              key={tag.id}
              tag={tag}
              onRemove={onUntag && (() => onUntag(tag))}
            />
          ))}
          {onTag && (
            <RowAction
              label="Tag this version"
              describedBy={titleId}
              onClick={onTag}
              className={revealOnHover}
            >
              <TagIcon />
            </RowAction>
          )}
        </div>
        {(onShowChanges || onPreview) && (
          <div
            className={cn("flex shrink-0 items-center gap-0.5", revealOnHover)}
          >
            {onShowChanges && (
              <RowAction
                label="Show changes"
                describedBy={titleId}
                onClick={onShowChanges}
              >
                <DiffIcon />
              </RowAction>
            )}
            {onPreview && (
              <RowAction
                label="Preview"
                describedBy={titleId}
                onClick={onPreview}
              >
                <EyeIcon />
              </RowAction>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Row actions stay out of the way until the row is hovered or focused,
// except on touch screens, which have no hover to reveal them.
const revealOnHover =
  "transition-opacity pointer-fine:opacity-0 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:group-hover/row:opacity-100";

function TagBadge({
  tag,
  onRemove,
}: {
  tag: NamedVersion;
  onRemove?: () => void;
}) {
  return (
    <span
      title={`Tagged ${formatAbsolute(tag.createdAt)}`}
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 rounded-full border bg-secondary pl-1.5 text-[11px] font-medium text-secondary-foreground",
        onRemove ? "pr-0.5" : "pr-2",
      )}
    >
      <TagIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${tag.name}`}
          onClick={onRemove}
          className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

function RowAction({
  label,
  describedBy,
  onClick,
  className,
  children,
}: {
  label: string;
  /**
   * The row's title, so screen readers hear which version a button acts
   * on. A description rather than part of the name, which keeps the names
   * short and the same on every row.
   */
  describedBy: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-describedby={describedBy}
          onClick={onClick}
          className={cn(
            "text-muted-foreground hover:text-foreground",
            className,
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function LoadingRows() {
  return (
    <div role="status" aria-label="Loading history" className="divide-y">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="ml-auto size-6 rounded-full" />
          </div>
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
