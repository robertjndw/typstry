import { useState } from "react";

import { NameDialog } from "@/components/NameDialog";
import { PersonAvatar } from "@/components/PresenceBar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { setIdentity, type Identity } from "@/presence/identity";

export interface IdentityControlProps {
  identity: Identity;
  /** Nothing stored yet: ask right away. */
  firstVisit: boolean;
}

/** Own avatar in the toolbar; opens the name dialog. */
export function IdentityControl({
  identity,
  firstVisit,
}: IdentityControlProps) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`You are ${identity.name}. Change name or color`}
            onClick={() => setEditing(true)}
            className="cursor-pointer rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <PersonAvatar identity={identity} />
          </button>
        </TooltipTrigger>
        <TooltipContent>You ({identity.name})</TooltipContent>
      </Tooltip>
      <NameDialog
        open={firstVisit || editing}
        firstVisit={firstVisit}
        initial={identity}
        onClose={(next) => {
          setIdentity(next);
          setEditing(false);
        }}
      />
    </>
  );
}
