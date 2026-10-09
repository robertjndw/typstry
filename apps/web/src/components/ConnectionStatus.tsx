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

export function ConnectionStatus({ status }: { status: SyncStatus }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users can reach the tooltip too. */}
        <span
          role="status"
          tabIndex={0}
          aria-description={DESCRIPTIONS[status]}
          className="flex cursor-default items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              status === "connected" && "bg-emerald-500",
              status === "connecting" && "animate-pulse bg-amber-500",
              status === "disconnected" && "bg-red-500",
            )}
          />
          {LABELS[status]}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{DESCRIPTIONS[status]}</TooltipContent>
    </Tooltip>
  );
}
