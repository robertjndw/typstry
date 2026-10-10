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
export function ConnectionStatus({ status }: { status: SyncStatus }) {
  const quiet = status === "connected";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users can reach the tooltip too. */}
        <span
          role="status"
          tabIndex={0}
          aria-description={DESCRIPTIONS[status]}
          className={cn(
            "flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            quiet ? "justify-center px-1.5" : "px-2",
            // Amber text on a light background is too faint, so the dot carries
            // the color here.
            status === "connecting" && "bg-warning/15 text-foreground",
            status === "disconnected" && "bg-destructive/10 text-destructive",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              status === "connected" && "bg-success",
              status === "connecting" && "animate-pulse bg-warning",
              status === "disconnected" && "bg-destructive",
            )}
          />
          <span className={cn("font-medium", quiet && "sr-only")}>
            {LABELS[status]}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {LABELS[status]}: {DESCRIPTIONS[status].toLowerCase()}
      </TooltipContent>
    </Tooltip>
  );
}
