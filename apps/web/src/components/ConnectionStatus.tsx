import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SyncStatus } from "@/sync/connection";

const LABELS: Record<SyncStatus, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Offline",
};

const DESCRIPTIONS: Record<SyncStatus, string> = {
  connected: "Edits sync live",
  connecting: "Edits sync once connected",
  disconnected: "Edits sync when back online",
};

/**
 * Sync state in the toolbar. Just a dot while all is well; the label only
 * shows when something needs attention. It stays in the DOM (visually
 * hidden when connected) so the live region announces every change.
 */
export function ConnectionStatus({
  status,
  problem = null,
}: {
  status: SyncStatus;
  /** Why changes are not getting through even though connected, if so. */
  problem?: string | null;
}) {
  const label = problem ? "Not syncing" : LABELS[status];
  const description = problem ?? DESCRIPTIONS[status];
  const failing = problem !== null || status === "disconnected";
  const quiet = status === "connected" && problem === null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users can reach the tooltip too. */}
        <span
          role="status"
          tabIndex={0}
          aria-description={description}
          className={cn(
            "flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            quiet ? "justify-center px-1.5" : "px-2",
            // Amber text on a light background is too faint, so the dot carries
            // the color here.
            !failing &&
              status === "connecting" &&
              "bg-warning/15 text-foreground",
            failing && "bg-destructive/10 text-destructive",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              !failing && status === "connected" && "bg-success",
              !failing && status === "connecting" && "animate-pulse bg-warning",
              failing && "bg-destructive",
            )}
          />
          <span className={cn("font-medium", quiet && "sr-only")}>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {problem ? (
          <>
            {label}: {problem}
          </>
        ) : (
          <>
            {label}: {description.toLowerCase()}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
