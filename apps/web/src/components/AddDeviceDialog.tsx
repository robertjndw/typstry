import { CheckIcon, CopyIcon, SmartphoneIcon } from "lucide-react";
import { useEffect } from "react";

import { EnterCodeForm } from "@/components/EnterCodeForm";
import { ApprovalDialog, PairingStatus } from "@/components/PairingStatus";
import { QrCode } from "@/components/QrCode";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { usePairingFlow } from "@/pairing/usePairingFlow";

/**
 * Pairs this browser with another device of the same person. Mounted only
 * while open, so closing it abandons the pairing.
 */
export function AddDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return open ? <AddDevice onOpenChange={onOpenChange} /> : null;
}

function AddDevice({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const flow = usePairingFlow();
  const { holder, session, state, code, reset, showCode } = flow;
  const { copied, copy } = useCopyToClipboard(
    "Copying failed. Select the link and copy it manually.",
  );
  const link = code ? `${window.location.origin}/pair#${code}` : null;

  // A device with projects has nothing to ask first, so it shows the code
  // right away. A new one wants a name, so it waits for the button.
  useEffect(() => {
    if (holder === true && !session && !flow.busy && !flow.error)
      void showCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holder, session]);

  const showing = session !== null && code !== null;
  const waiting = state?.status === "waitingForPeer";

  return (
    <>
      <Dialog
        open={
          state?.status !== "awaitingApproval" && state?.status !== "approving"
        }
        onOpenChange={onOpenChange}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a device</DialogTitle>
            <DialogDescription>
              {holder === false
                ? "Pair this browser with a device that already has your projects. Show a code here, or enter the one shown there."
                : "Show this code on the new device, or open the link there. The device you add becomes you: it gets your projects, and the ones you add later."}
            </DialogDescription>
          </DialogHeader>

          {showing && waiting && link && (
            <div className="flex flex-col items-center gap-3">
              <p className="font-mono text-3xl font-semibold tracking-tight select-all">
                {code}
              </p>
              <QrCode text={link} label="QR code of the pairing link" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy(link)}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                Copy link
              </Button>
              <Input
                readOnly
                aria-label="Pairing link"
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                className="h-8 font-mono text-xs"
              />
            </div>
          )}

          {state && !(showing && waiting) && (
            <PairingStatus
              state={state}
              holder={holder === true}
              fingerprint={session?.ownFingerprint}
              onRestart={reset}
            />
          )}

          {!state && holder === false && (
            <Button
              disabled={flow.busy || !flow.nameOk}
              onClick={() => void showCode()}
            >
              <SmartphoneIcon />
              Show a code
            </Button>
          )}

          {flow.error && (
            <p role="alert" className="text-sm text-destructive">
              {flow.error}
            </p>
          )}

          {holder !== null && (!state || (showing && waiting)) && (
            <div className="flex flex-col gap-2 border-t pt-4">
              <h3 className="text-sm font-medium">Enter a code</h3>
              <EnterCodeForm
                deviceName={flow.deviceName}
                onDeviceName={flow.setDeviceName}
                askName={holder === false}
                busy={flow.busy}
                onSubmit={(input) => void flow.enterCode(input)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ApprovalDialog session={session} state={state} />
    </>
  );
}
