import {
  ChevronDownIcon,
  FolderInputIcon,
  FolderLockIcon,
  FolderSyncIcon,
  FolderXIcon,
  Loader2Icon,
  TriangleAlertIcon,
  UnlinkIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFolderSync, type FolderSyncApi } from "@/folder/context";
import type { Conflict, FolderSyncState } from "@/folder/engine";
import { cn } from "@/lib/utils";

const DESCRIPTIONS: Record<FolderSyncState["status"], string> = {
  "needs-permission": "The browser needs your permission to read the folder",
  syncing: "Syncing with the folder",
  idle: "Changes sync with the folder as they happen",
  missing: "The folder was moved, renamed or deleted",
  error: "Syncing with the folder failed",
  "other-tab": "Another tab of this browser syncs this folder",
  waiting: "Waiting for the project to load from the server",
};

const LABEL =
  "text-[11px] font-semibold tracking-wider text-muted-foreground uppercase select-none";

const TRIGGER =
  "-ml-1.5 flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted";

const conflictKey = (c: Conflict) => `${c.path}\n${c.reason}`;

/**
 * The file tree's heading: the linked folder's name and state, with the
 * folder actions behind it. Without folder support it's just the pane's
 * label. Not a `role="status"` region, since the toolbar's connection
 * indicator is the one status.
 */
export function FolderSyncStatus() {
  const folder = useFolderSync();
  if (!folder) return <span className={LABEL}>Files</span>;
  if (!folder.linkName) return <LinkMenu folder={folder} />;
  return (
    <>
      <FolderMenu folder={folder} name={folder.linkName} />
      <Attention state={folder.state} />
    </>
  );
}

function LinkMenu({ folder }: { folder: FolderSyncApi }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Files menu" className={TRIGGER}>
        <span className={LABEL}>Files</span>
        <ChevronDownIcon
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="font-normal">
          Keep the project in sync with a folder on this computer.
        </DropdownMenuLabel>
        {/* The picker has to open from this click, so nothing may run before
            it. */}
        <DropdownMenuItem onSelect={() => void folder.link()}>
          <FolderInputIcon />
          Link to local folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderMenu({ folder, name }: { folder: FolderSyncApi; name: string }) {
  const status = folder.state?.status ?? "idle";
  const description =
    status === "error" && folder.state?.error
      ? `${DESCRIPTIONS.error}: ${folder.state.error}`
      : DESCRIPTIONS[status];

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label={`Folder ${name}: ${DESCRIPTIONS[status].toLowerCase()}`}
            className={cn(
              TRIGGER,
              "animate-in text-xs font-medium duration-200 fade-in-0",
              status === "other-tab" && "text-muted-foreground",
            )}
          >
            <StatusIcon status={status} />
            <span className="truncate">{name}</span>
            <ChevronDownIcon
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{description}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-foreground">{name}</span>
          <span className="font-normal">{description}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {status === "needs-permission" && (
            <DropdownMenuItem onSelect={() => void folder.reconnect()}>
              <FolderInputIcon />
              Reconnect folder
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void folder.syncNow()}>
            <FolderSyncIcon />
            Sync folder now
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void folder.unlink()}>
          <UnlinkIcon />
          <span className="truncate">Unlink {name}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusIcon({ status }: { status: FolderSyncState["status"] }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "syncing":
    case "waiting":
      return (
        <Loader2Icon aria-hidden className={cn(className, "animate-spin")} />
      );
    case "needs-permission":
      return (
        <FolderLockIcon aria-hidden className={cn(className, "text-warning")} />
      );
    case "missing":
      return (
        <FolderXIcon
          aria-hidden
          className={cn(className, "text-destructive")}
        />
      );
    case "error":
      return (
        <FolderSyncIcon
          aria-hidden
          className={cn(className, "text-destructive")}
        />
      );
    default:
      return (
        <FolderSyncIcon
          aria-hidden
          className={cn(className, "text-muted-foreground")}
        />
      );
  }
}

/**
 * A strip under the heading while the sync is stalled, with the one action
 * that unblocks it. Nothing shows in quiet states.
 */
export function FolderSyncNotice() {
  const folder = useFolderSync();
  const status = folder?.state?.status;
  if (!folder?.linkName) return null;

  let message: string;
  let action: { label: string; run: () => Promise<void> };
  switch (status) {
    case "needs-permission":
      message = `Allow access to keep ${folder.linkName} in sync.`;
      // Straight from the click: the browser only shows its permission prompt
      // to a call made before the first await.
      action = { label: "Reconnect", run: folder.reconnect };
      break;
    case "missing":
      message = `${folder.linkName} was moved, renamed or deleted.`;
      // Retrying can't find a renamed folder, linking it again can.
      action = { label: "Unlink", run: folder.unlink };
      break;
    case "error":
      message = folder.state?.error
        ? `Sync failed: ${folder.state.error}`
        : "Syncing with the folder failed.";
      action = { label: "Try again", run: folder.syncNow };
      break;
    default:
      return null;
  }

  return (
    <div
      className={cn(
        "flex shrink-0 animate-in items-center gap-2 border-b py-1.5 pr-1.5 pl-3 text-xs duration-200 fade-in-0 slide-in-from-top-1",
        status === "needs-permission" ? "bg-warning/10" : "bg-destructive/10",
      )}
    >
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0 bg-background"
        onClick={() => void action.run()}
      >
        {action.label}
      </Button>
    </div>
  );
}

/**
 * Conflicts and warnings of the sync, kept after the cycle that found them so
 * a later quiet cycle doesn't hide which edit lost.
 */
function Attention({ state }: { state: FolderSyncState | null }) {
  const report = state?.report ?? null;
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  // Every conflict ever shown, so a dismissed one that a later cycle reports
  // again doesn't come back.
  const known = useRef(new Set<string>());

  useEffect(() => {
    if (!report) return;
    const fresh = report.conflicts.filter(
      (c) => !known.current.has(conflictKey(c)),
    );
    if (fresh.length === 0) return;
    for (const c of fresh) known.current.add(conflictKey(c));
    setConflicts((prev) => [...prev, ...fresh]);
    toast.warning(
      `${fresh.length} ${fresh.length === 1 ? "conflict" : "conflicts"} while syncing the folder`,
      {
        description:
          fresh
            .slice(0, 3)
            .map((c) => c.path)
            .join(", ") + (fresh.length > 3 ? ", …" : ""),
      },
    );
  }, [report]);

  const warnings = [...new Set(report?.warnings ?? [])];
  const held = report?.heldLocal ?? [];
  const count = conflicts.length + warnings.length + held.length;
  if (count === 0) return null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`${count} ${count === 1 ? "issue" : "issues"} with the folder sync`}
              className="text-warning-foreground animate-in duration-200 fade-in-0 zoom-in-50"
            >
              <TriangleAlertIcon className="text-warning" />
              {count}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Folder sync needs a look</TooltipContent>
      </Tooltip>
      <PopoverContent className="grid max-h-96 gap-3 overflow-auto">
        {conflicts.length > 0 && (
          <Section title="Conflicts">
            <p className="text-xs text-muted-foreground">
              These files changed on both sides. The losing version is still in
              the project&rsquo;s History.
            </p>
            {conflicts.map((c) => (
              <Entry key={conflictKey(c)} path={c.path} note={c.reason} />
            ))}
          </Section>
        )}
        {held.length > 0 && (
          <Section title="Not applied">
            <p className="text-xs text-muted-foreground">
              You can only view this project, so edits made in the folder stay
              there.
            </p>
            {held.map((path) => (
              <Entry key={path} path={path} />
            ))}
          </Section>
        )}
        {warnings.length > 0 && (
          <Section title="Warnings">
            {warnings.map((w) => (
              <p key={w} className="text-xs">
                {w}
              </p>
            ))}
          </Section>
        )}
        {conflicts.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="justify-self-end"
            onClick={() => setConflicts([])}
          >
            Dismiss
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Entry({ path, note }: { path: string; note?: string }) {
  return (
    <div className="grid text-xs">
      <span className="truncate font-mono" title={path}>
        {path}
      </span>
      {note && <span className="text-muted-foreground">{note}</span>}
    </div>
  );
}
