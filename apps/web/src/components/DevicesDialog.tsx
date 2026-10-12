import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { toHex } from "@/crypto/bytes";
import {
  PersonGraph,
  loadWasm,
  deviceFingerprint,
  devicePublicKey,
} from "@/crypto/wasm";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toError } from "@/lib/errors";
import { RECOVERY_LABEL } from "@/mls/recovery";
import { revokeDevice, secured, type RevokeOutcome } from "@/mls/revoke";
import { defaultBackend } from "@/persist/local-doc-store";

interface DeviceRow {
  hex: string;
  pub: Uint8Array;
  name: string;
  fingerprint: string;
  isSelf: boolean;
  revoked: boolean;
  recovery: boolean;
}

async function loadDevices(): Promise<DeviceRow[]> {
  await loadWasm();
  const backend = await defaultBackend();
  const stored = await backend.loadGraph();
  // No graph yet: this browser never created or joined a project, and
  // making one here would turn it into the holder of a person of its own.
  if (!stored) return [];
  const [labels, deviceSeed] = await Promise.all([
    backend.loadLabels(),
    backend.loadDeviceKey(),
  ]);
  const graph = PersonGraph.decode(stored);
  try {
    const own = deviceSeed ? toHex(devicePublicKey(deviceSeed)) : null;
    const rows = graph.devices().map(({ pub, state, recovery }) => {
      const hex = toHex(pub);
      const fingerprint = deviceFingerprint(pub);
      return {
        hex,
        pub,
        fingerprint,
        name:
          labels[hex] ?? (recovery ? RECOVERY_LABEL : `Device ${fingerprint}`),
        recovery,
        isSelf: own === hex,
        revoked: state === "revoked",
      };
    });
    // This device first, revoked ones last.
    const rank = (d: DeviceRow) => (d.isSelf ? 0 : d.revoked ? 2 : 1);
    return rows.sort((a, b) => rank(a) - rank(b));
  } finally {
    graph.free();
  }
}

/** The devices of this person, with revoking for the others. */
export function DevicesDialog({
  open,
  onOpenChange,
  revoke = revokeDevice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Replaceable for tests. */
  revoke?: (pub: Uint8Array) => Promise<RevokeOutcome>;
}) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DeviceRow | null>(null);
  const [working, setWorking] = useState(false);
  const [report, setReport] = useState<{
    name: string;
    outcome: RevokeOutcome;
  } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    loadDevices().then(
      (rows) => live && setDevices(rows),
      (e: unknown) => live && setError(toError(e).message),
    );
    return () => {
      live = false;
    };
  }, [open, reload]);

  async function confirm() {
    const device = pending;
    if (!device) return;
    setPending(null);
    setWorking(true);
    try {
      const outcome = await revoke(device.pub);
      setReport({ name: device.name, outcome });
    } catch (e) {
      console.error(e);
      toast.error(`Could not revoke the device: ${toError(e).message}`);
    } finally {
      setWorking(false);
      setReload((n) => n + 1);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!working) onOpenChange(next);
          if (!next) setReport(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your devices</DialogTitle>
            <DialogDescription>
              Every device here can act as you. Revoke one that is lost or that
              you no longer trust.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              Could not read your devices: {error}
            </p>
          ) : devices === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to list yet. This browser gets an identity when you create
              or open a project.
            </p>
          ) : (
            <ul
              aria-label="Devices"
              className="divide-y overflow-hidden rounded-lg border bg-card"
            >
              {devices.map((device) => (
                <li
                  key={device.hex}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">
                      {device.name}
                      {device.recovery && (
                        <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                          Recovery
                        </span>
                      )}
                      {device.isSelf && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          (this device)
                        </span>
                      )}
                    </span>
                    <span
                      className="font-mono text-xs text-muted-foreground"
                      title="Compare this with the code the device shows"
                    >
                      {device.fingerprint}
                    </span>
                  </span>
                  {device.revoked ? (
                    <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                      Revoked
                    </span>
                  ) : (
                    !device.isSelf && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={working}
                        aria-label={`Revoke ${device.name}`}
                        onClick={() => setPending(device)}
                      >
                        Revoke
                      </Button>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          {working && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
              Removing the device from your projects…
            </p>
          )}
          {report && <RevokeReport report={report} />}
        </DialogContent>
      </Dialog>
      <ConfirmDeleteDialog
        open={pending !== null}
        title={`Revoke ${pending?.name ?? "the device"}?`}
        description="It stops counting as you. In projects you own it is removed and the links are replaced, so it can no longer open them. In projects you can edit, their owner is told to remove it. Projects you can only view are left as they are."
        confirmLabel="Revoke"
        onCancel={() => setPending(null)}
        onConfirm={() => void confirm()}
      />
    </>
  );
}

function RevokeReport({
  report,
}: {
  report: { name: string; outcome: RevokeOutcome };
}) {
  const { personal, projects } = report.outcome;
  const missed = projects.filter((p) => p.result.status === "unreached");
  const cleaned = projects.filter((p) => p.result.status === "cleaned");
  const reset = projects.filter((p) => p.result.status === "links-reset");
  const left = projects.filter((p) => p.result.status === "left-to-owner");
  return (
    <div role="status" className="flex flex-col gap-2 text-sm">
      <p className="font-medium">{report.name} was revoked.</p>
      {!secured(personal) ? (
        <p className="text-destructive">
          Your project list could not be secured
          {personal.status === "unreached" && ` (${personal.reason})`}, so no
          project links were replaced and {report.name} can still read them.
          Revoke it again once this device can reach the list.
        </p>
      ) : projects.length === 0 ? (
        <p className="text-muted-foreground">You have no projects here.</p>
      ) : (
        <p className="text-muted-foreground">
          Removed from {cleaned.length} of {projects.length}{" "}
          {projects.length === 1 ? "project" : "projects"}.
        </p>
      )}
      {personal.status === "links-reset" && (
        <p className="text-muted-foreground">
          The links to your project list were replaced.
        </p>
      )}
      {reset.length > 0 && (
        <>
          <p className="text-muted-foreground">
            Links replaced, since you own {reset.length === 1 ? "it" : "them"}:
          </p>
          <ul className="flex flex-col gap-1">
            {reset.map((p) => (
              <li key={p.projectId} className="font-medium">
                {p.title}
              </li>
            ))}
          </ul>
        </>
      )}
      {left.length > 0 && (
        <>
          <p className="text-muted-foreground">
            Left for the owner to remove, the next time they open{" "}
            {left.length === 1 ? "it" : "them"}:
          </p>
          <ul className="flex flex-col gap-1">
            {left.map((p) => (
              <li key={p.projectId} className="font-medium">
                {p.title}
              </li>
            ))}
          </ul>
        </>
      )}
      {missed.length > 0 && (
        <>
          <p className="text-muted-foreground">
            Still to clean up. Projects you can edit are cleaned up the next
            time you open them here. Projects you can only view need an editor
            to open them:
          </p>
          <ul className="flex flex-col gap-1">
            {missed.map((p) => (
              <li key={p.projectId} className="text-muted-foreground">
                <span className="font-medium text-foreground">{p.title}</span>
                {p.result.status === "unreached" && `: ${p.result.reason}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
