import { HardDriveIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type { StorageHealth } from "./local-doc-store";
import { useStorageHealth } from "./useStorageHealth";

const MESSAGES: Record<Exclude<StorageHealth, "ok">, string> = {
  memory:
    "This browser does not let typstry save projects, so changes not yet synced are lost when the tab closes.",
  full: "This browser is out of storage space, so new changes are not saved on this device. They still sync while online.",
  failing:
    "Saving on this device stopped working, maybe because typstry was updated in another tab. Reload the page; changes still sync while online.",
};

/**
 * A slim bar that says when changes are not being saved in this browser.
 * Renders nothing while saving works.
 */
export function StorageNotice({ className }: { className?: string }) {
  const health = useStorageHealth();
  if (health === "ok") return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2 bg-destructive/10 px-3 py-1.5 text-xs text-destructive",
        className,
      )}
    >
      <HardDriveIcon aria-hidden className="size-3.5 shrink-0" />
      <span>{MESSAGES[health]}</span>
    </div>
  );
}
