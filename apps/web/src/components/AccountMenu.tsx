import {
  KeyRoundIcon,
  LaptopIcon,
  LifeBuoyIcon,
  PaletteIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { AddDeviceDialog } from "@/components/AddDeviceDialog";
import { DevicesDialog } from "@/components/DevicesDialog";
import { NameDialog } from "@/components/NameDialog";
import { PersonAvatar } from "@/components/PresenceBar";
import { RecoveryDialog } from "@/components/RecoveryDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { publishProfile } from "@/mls/profile";
import { defaultBackend } from "@/persist/local-doc-store";
import { setIdentity, type Identity } from "@/presence/identity";

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
  const [addingDevice, setAddingDevice] = useState(false);
  const [listingDevices, setListingDevices] = useState(false);
  const [recovering, setRecovering] = useState(false);

  function save(next: Identity) {
    setIdentity(next);
    setEditing(false);
    // Only a real change reaches the graph, which has room for few entries.
    if (
      !firstVisit &&
      next.name === identity.name &&
      next.color === identity.color
    )
      return;
    defaultBackend()
      .then((backend) => publishProfile(backend, next))
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
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <PaletteIcon />
            Name and color…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddingDevice(true)}>
            <SmartphoneIcon />
            Add a device…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setListingDevices(true)}>
            <LaptopIcon />
            Your devices…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRecovering(true)}>
            <KeyRoundIcon />
            Recovery key…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="/recover">
              <LifeBuoyIcon />
              Recover with a recovery key
            </a>
          </DropdownMenuItem>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={firstVisit || editing}
        firstVisit={firstVisit}
        initial={identity}
        onClose={save}
      />
      <AddDeviceDialog open={addingDevice} onOpenChange={setAddingDevice} />
      <DevicesDialog open={listingDevices} onOpenChange={setListingDevices} />
      <RecoveryDialog open={recovering} onOpenChange={setRecovering} />
    </>
  );
}
