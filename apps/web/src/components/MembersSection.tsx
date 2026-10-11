import { RefreshCwIcon, UserMinusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { PersonAvatar } from "@/components/PresenceBar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { peopleOf, type RosterPerson } from "@/mls/members";
import type { MlsSession } from "@/mls/session";
import { useMlsSnapshot } from "@/mls/useMlsSnapshot";

const NOT_OWNER = "Only the owner can remove members.";

type Pending =
  { kind: "remove"; person: RosterPerson } | { kind: "reset" } | null;

/**
 * Who is in the project's group, and for editors the two things that change
 * who can get in: removing a member and resetting the links, which only the
 * owner may do. Both replace the links, so they are confirmed first.
 */
export function MembersSection({ mls }: { mls: MlsSession | null }) {
  const { phase, members, canCommit, stalled } = useMlsSnapshot(mls);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const people = useMemo(() => peopleOf(members), [members]);
  // Only the owner removes members and resets links; editors just edit.
  const isOwner = canCommit && members.find((m) => m.isSelf)?.role === "owner";

  // Nothing to show for a project whose group cannot be reached; the links
  // above still work.
  if (!mls || phase === "unavailable" || phase === "failed") return null;

  async function confirm() {
    const action = pending;
    if (!action || !mls) return;
    setBusy(true);
    try {
      if (action.kind === "remove") {
        const { person } = action;
        // A device without a verified person is removed on its own.
        if (person.key) await mls.removePerson(person.key);
        else await mls.removeMembers([person.devices[0]!.signer]);
        toast.success(`${nameOf(person)} was removed`);
      } else {
        await mls.resetLinks();
        toast.success("The links were reset");
      }
    } catch (error) {
      console.error(error);
      toast.error(
        (error as { kind?: unknown } | null)?.kind === "NotOwner"
          ? NOT_OWNER
          : error instanceof Error
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
          {people.length > 0 && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {people.length}
            </span>
          )}
        </h3>
        {isOwner && (
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
          {people.map((person) => (
            <li
              key={person.key ?? person.devices[0]!.signer}
              className="flex items-center gap-2.5 rounded-md px-1 py-1"
            >
              <PersonAvatar identity={person.profile ?? person.devices[0]!} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {nameOf(person)}
                  {person.isSelf && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      you
                    </span>
                  )}
                </span>
                <PersonDetails person={person} />
              </span>
              <RoleBadge role={person.role} />
              {isOwner && !person.isSelf && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Remove ${nameOf(person)}`}
                      onClick={() => setPending({ kind: "remove", person })}
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
      {canCommit && !isOwner && members.length > 0 && (
        <p className="text-xs text-muted-foreground">{NOT_OWNER}</p>
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
            ? `Remove ${nameOf(pending.person)}?`
            : "Reset the links?"
        }
        description={
          pending?.kind === "remove"
            ? "None of their devices will receive anything added to the project from now on. The edit and view links change, and everyone who remains gets the new ones automatically. Links you shared before stop working."
            : "The edit and view links change, and everyone in the member list gets the new ones automatically. Links you shared before stop working, so send the new ones to anyone who is not listed."
        }
        confirmLabel={pending?.kind === "remove" ? "Remove" : "Reset links"}
        onCancel={() => !busy && setPending(null)}
        onConfirm={() => void confirm()}
      />
    </section>
  );
}

function nameOf(person: RosterPerson): string {
  return (person.profile ?? person.devices[0]!).name;
}

/** Device count, the safety number and warnings for a bad or revoked device. */
function PersonDetails({ person }: { person: RosterPerson }) {
  const count = person.devices.length;
  if (count < 2 && !person.fingerprint && !person.unverified && !person.revoked)
    return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {count > 1 && <span>{count} devices</span>}
      {person.fingerprint && (
        <span
          className="font-mono"
          title="Safety number: compare it with the person to be sure it is them"
        >
          {person.fingerprint}
        </span>
      )}
      {person.revoked && (
        <span className="text-amber-600 dark:text-amber-500">
          Revoked device
        </span>
      )}
      {person.unverified && (
        <span className="text-amber-600 dark:text-amber-500">
          Unverified device
        </span>
      )}
    </span>
  );
}

function RoleBadge({ role }: { role: RosterPerson["role"] }) {
  return (
    <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
      {role === "owner" ? "Owner" : role === "editor" ? "Editor" : "Viewer"}
    </span>
  );
}
