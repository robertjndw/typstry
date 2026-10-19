import { PaletteIcon } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { NameDialog } from "@/components/NameDialog";
import { PersonAvatar } from "@/components/PresenceBar";
import type { ServerDialog } from "@/components/AccountMenuServer";
import { ThemeMenuItems } from "@/components/ThemeToggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LOCAL_ONLY } from "@/mode";
import { defaultBackend } from "@/persist/local-doc-store";
import { setIdentity, type Identity } from "@/presence/identity";

// Pairing, devices and recovery pull in the sync and MLS stack, which the
// static build has no use for; lazy behind the constant keeps it out.
const serverPart = <K extends "ServerMenuItems" | "ServerDialogs">(name: K) =>
  LOCAL_ONLY
    ? null
    : lazy(() =>
        import("@/components/AccountMenuServer").then((m) => ({
          default: m[name],
        })),
      );
const ServerItems = serverPart("ServerMenuItems");
const ServerDialogs = serverPart("ServerDialogs");

export interface AccountMenuProps {
  identity: Identity;
  /** Nothing stored yet: ask right away. Only the project page sets this. */
  firstVisit?: boolean;
  /** Extra items, shown below the built-in ones. */
  children?: ReactNode;
}

/** Own avatar in the header; opens the account menu. */
export function AccountMenu({
  identity,
  firstVisit = false,
  children,
}: AccountMenuProps) {
  const [editing, setEditing] = useState(false);
  const [serverDialog, setServerDialog] = useState<ServerDialog | null>(null);

  function save(next: Identity) {
    setIdentity(next);
    setEditing(false);
    // No other devices to tell without a server.
    if (LOCAL_ONLY) return;
    // Only a real change reaches the graph, which has room for few entries.
    if (
      !firstVisit &&
      next.name === identity.name &&
      next.color === identity.color
    )
      return;
    Promise.all([defaultBackend(), import("@/mls/profile")])
      .then(([backend, { publishProfile }]) => publishProfile(backend, next))
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Could not send the new name to your other devices.");
      });
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`You are ${identity.name}. Open the account menu`}
                className="flex shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <PersonAvatar identity={identity} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>You ({identity.name})</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-64">
          <div className="flex items-center gap-2.5 px-1.5 py-1.5">
            <PersonAvatar identity={identity} />
            <span className="truncate text-sm font-medium">
              {identity.name}
            </span>
          </div>
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <PaletteIcon />
            Name and color…
          </DropdownMenuItem>
          {ServerItems && (
            <Suspense fallback={null}>
              <ServerItems onOpen={setServerDialog} />
            </Suspense>
          )}
          {children}
          <DropdownMenuSeparator />
          <ThemeMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={firstVisit || editing}
        firstVisit={firstVisit}
        initial={identity}
        onClose={save}
      />
      {ServerDialogs && (
        <Suspense fallback={null}>
          <ServerDialogs
            open={serverDialog}
            onClose={() => setServerDialog(null)}
          />
        </Suspense>
      )}
    </>
  );
}
