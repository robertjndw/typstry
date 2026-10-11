import { Link, useLocation, useNavigate } from "react-router";
import { useEffect, useRef, useState } from "react";

import { EnterCodeForm } from "@/components/EnterCodeForm";
import { PageShell } from "@/components/PageShell";
import { ApprovalDialog, PairingStatus } from "@/components/PairingStatus";
import { usePairingFlow } from "@/pairing/usePairingFlow";

/**
 * The page a pairing link opens. The code rides in the fragment, which never
 * reaches the server.
 */
export function Pair() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [linkCode] = useState(() =>
    hash.length > 1 ? decodeURIComponent(hash.slice(1)) : "",
  );
  // The code is spent once used, but keeping it out of the address bar and
  // history means a synced history or someone looking over a shoulder never
  // sees a live one.
  useEffect(() => {
    if (hash) void navigate({ hash: "" }, { replace: true });
  }, [hash, navigate]);
  const flow = usePairingFlow();
  const { holder, state, session } = flow;
  const started = useRef(false);

  // A device with projects has nothing to ask, so it connects right away.
  // A new one confirms its name first.
  useEffect(() => {
    if (holder === true && linkCode && !started.current) {
      started.current = true;
      void flow.enterCode(linkCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holder, linkCode]);

  return (
    <PageShell outside={<ApprovalDialog session={session} state={state} />}>
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Add a device
        </h1>
        <p className="text-sm text-muted-foreground">
          Pair this browser with another device of yours. It gets your projects
          and edits them as you.
        </p>
      </div>
      {state ? (
        <PairingStatus
          state={state}
          holder={holder === true}
          onRestart={flow.reset}
        />
      ) : (
        holder !== null &&
        !(holder && linkCode && !flow.error) && (
          <EnterCodeForm
            initialCode={linkCode}
            deviceName={flow.deviceName}
            onDeviceName={flow.setDeviceName}
            askName={!holder}
            busy={flow.busy}
            onSubmit={(code) => void flow.enterCode(code)}
          />
        )
      )}
      <p className="text-sm text-muted-foreground">
        Lost all your devices?{" "}
        <Link to="/recover" className="underline underline-offset-2">
          Recover with a recovery key
        </Link>
      </p>
      {flow.error && (
        <p role="alert" className="text-sm text-destructive">
          {flow.error}
        </p>
      )}
    </PageShell>
  );
}
