import { RefreshCwIcon, UserMinusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { PersonAvatar } from "@/components/PresenceBar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RosterMember } from "@/mls/members";
import type { MlsSession } from "@/mls/session";
import { useMlsSnapshot } from "@/mls/useMlsSnapshot";

type Pending =
  { kind: "remove"; member: RosterMember } | { kind: "reset" } | null;

/**
 * Who is in the project's group, and for editors the two things that change
 * who can get in: removing a member and resetting the links. Both replace the
 * links, so they are confirmed first.
 */
export function MembersSection({ mls }: { mls: MlsSession | null }) {
  const { phase, members, canCommit, stalled } = useMlsSnapshot(mls);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  // Nothing to show for a project whose group cannot be reached; the links
  // above still work.
  if (!mls || phase === "unavailable" || phase === "failed") return null;

  async function confirm() {
    const action = pending;
    if (!action || !mls) return;
    setBusy(true);
    try {
      if (action.kind === "remove") {
        await mls.removeMembers([action.member.signer]);
        toast.success(`${action.member.name} was removed`);
      } else {
        await mls.resetLinks();
        toast.success("The links were reset");
      }
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error
          ? `Could not change the members: ${error.message}`
          : "Could not change the members.",
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="members-heading" className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id="members-heading" className="text-sm font-medium">
          Members
          {members.length > 0 && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {members.length}
            </span>
          )}
        </h3>
        {canCommit && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setPending({ kind: "reset" })}
          >
            <RefreshCwIcon />
            Reset links
          </Button>
        )}
      </div>
      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Joining the member list…
        </p>
      ) : (
        <ul className="grid gap-1" aria-label="Members">
          {members.map((member) => (
            <li
              key={member.signer}
              className="flex items-center gap-2.5 rounded-md px-1 py-1"
            >
              <PersonAvatar identity={member} />
              <span className="min-w-0 flex-1 truncate text-sm">
                {member.name}
                {member.isSelf && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    you
                  </span>
                )}
              </span>
              <RoleBadge role={member.role} />
              {canCommit && !member.isSelf && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Remove ${member.name}`}
                      onClick={() => setPending({ kind: "remove", member })}
                    >
                      <UserMinusIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {stalled && (
        <p role="status" className="text-xs text-muted-foreground">
          The member list is out of step and is being repaired. Editing keeps
          working meanwhile.
        </p>
      )}
      {/* Inside the section on purpose: Radix treats a dialog rendered here
          as nested in the share dialog, and a sibling would close it as soon
          as it takes focus. */}
      <ConfirmDeleteDialog
        open={pending !== null}
        title={
          pending?.kind === "remove"
            ? `Remove ${pending.member.name}?`
            : "Reset the links?"
        }
        description={
          pending?.kind === "remove"
            ? "They will not receive anything added to the project from now on. The edit and view links change, and everyone who remains gets the new ones automatically. Links you shared before stop working."
            : "The edit and view links change, and everyone in the member list gets the new ones automatically. Links you shared before stop working, so send the new ones to anyone who is not listed."
        }
        confirmLabel={pending?.kind === "remove" ? "Remove" : "Reset links"}
        onCancel={() => !busy && setPending(null)}
        onConfirm={() => void confirm()}
      />
    </section>
  );
}

function RoleBadge({ role }: { role: RosterMember["role"] }) {
  return (
    <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
      {role === "editor" ? "Editor" : "Viewer"}
    </span>
  );
}
