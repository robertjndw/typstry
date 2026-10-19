import {
  KeyRoundIcon,
  LaptopIcon,
  LifeBuoyIcon,
  SmartphoneIcon,
} from "lucide-react";
import { Link } from "react-router";

import { AddDeviceDialog } from "@/components/AddDeviceDialog";
import { DevicesDialog } from "@/components/DevicesDialog";
import { RecoveryDialog } from "@/components/RecoveryDialog";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export type ServerDialog = "add-device" | "devices" | "recovery";

/** The account menu's entries that need a server, see AccountMenu. */
export function ServerMenuItems({
  onOpen,
}: {
  onOpen: (dialog: ServerDialog) => void;
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Devices</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => onOpen("add-device")}>
        <SmartphoneIcon />
        Add a device…
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onOpen("devices")}>
        <LaptopIcon />
        Your devices…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Recovery</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => onOpen("recovery")}>
        <KeyRoundIcon />
        Show recovery key…
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link to="/recover">
          <LifeBuoyIcon />
          Restore with a key…
        </Link>
      </DropdownMenuItem>
    </>
  );
}

export function ServerDialogs({
  open,
  onClose,
}: {
  open: ServerDialog | null;
  onClose: () => void;
}) {
  // The dialogs only ever report closing; opening goes through onOpen.
  const props = (dialog: ServerDialog) => ({
    open: open === dialog,
    onOpenChange: (next: boolean) => {
      if (!next) onClose();
    },
  });
  return (
    <>
      <AddDeviceDialog {...props("add-device")} />
      <DevicesDialog {...props("devices")} />
      <RecoveryDialog {...props("recovery")} />
    </>
  );
}
