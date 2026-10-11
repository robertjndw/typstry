import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PairSession,
  type PairFailure,
  type PairState,
} from "@/pairing/session";
import { RELOAD_MESSAGE } from "@/sync/protocol";

const FAILURES: Record<PairFailure, string> = {
  wrongCode:
    "The codes did not match. Check the words and start over with a new code.",
  roleConflict:
    "These two devices cannot be paired: either both already have projects of their own, or neither does. Pair the device that has your projects with one that does not.",
  expired:
    "The code has expired or was already used. Start over with a new code.",
  peerLeft: "The other device left before the pairing was finished.",
  stalled:
    "The other device stopped taking part before the pairing was finished. Start over with a new code.",
  rateLimited: "Too many attempts. Wait a moment and start over.",
  network: "The connection to the server was lost. Start over.",
  outdated: RELOAD_MESSAGE,
  refused:
    "This browser already belongs to a different person, or was removed from its own, so it cannot be added as a device.",
  protocol: "Something went wrong while pairing. Start over with a new code.",
};

/**
 * Where a pairing stands, apart from the code itself and the holder's
 * approval, which have their own dialog.
 */
export function PairingStatus({
  state,
  holder,
  onRestart,
}: {
  state: PairState;
  holder: boolean;
  onRestart: () => void;
}) {
  switch (state.status) {
    case "waitingForPeer":
      return (
        <Progress>
          {holder
            ? "Waiting for the other device to enter the code…"
            : "Connecting to the other device…"}
        </Progress>
      );
    case "verifying":
    case "awaitingApproval":
    case "approving":
      return (
        <Progress>
          {holder || state.status === "verifying"
            ? "Checking the code…"
            : "Waiting for the other device…"}
        </Progress>
      );
    case "rejected":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          {holder
            ? "The device was turned away."
            : "The other device did not approve this one."}
        </p>
      );
    case "failed":
      return (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-medium">Pairing failed. </strong>
              {FAILURES[state.reason]}
            </span>
          </p>
          <Button variant="outline" size="sm" onClick={onRestart}>
            Start over
          </Button>
        </div>
      );
    case "done":
      return (
        <div role="status" className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckIcon aria-hidden className="size-4" />
            {holder ? "Device added" : "This device is now yours"}
          </p>
          {!holder &&
            (state.projects.length > 0 ? (
              <ul
                aria-label="Projects received"
                className="divide-y overflow-hidden rounded-lg border bg-card"
              >
                {state.projects.map((p) => (
                  <li key={p.link}>
                    <Link
                      to={p.link}
                      className="block truncate px-3 py-2.5 text-sm font-medium hover:bg-muted/60"
                    >
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No projects came along.
              </p>
            ))}
        </div>
      );
  }
}

function Progress({ children }: { children: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2Icon aria-hidden className="size-4 animate-spin" />
      {children}
    </p>
  );
}

/** Holder only: the other device is in, and the user decides. */
export function ApprovalDialog({
  session,
  state,
}: {
  session: PairSession | null;
  state: PairState | null;
}) {
  const device =
    state?.status === "awaitingApproval" || state?.status === "approving"
      ? state.deviceName
      : null;
  const approving = state?.status === "approving";
  return (
    <Dialog
      open={device !== null}
      onOpenChange={(open) => !open && session?.reject()}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{device} wants to join as you</DialogTitle>
          <DialogDescription>
            It will see your projects and can edit them like you do. Only
            approve a device you just set up yourself.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={approving}
            onClick={() => session?.reject()}
          >
            Reject
          </Button>
          <Button disabled={approving} onClick={() => void session?.approve()}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
