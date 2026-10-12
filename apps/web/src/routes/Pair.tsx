import { Link, useLocation, useNavigate } from "react-router";
import { useEffect, useRef, useState } from "react";

import { EnterCodeForm } from "@/components/EnterCodeForm";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
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
  const { holder, disposable, state, session } = flow;
  const started = useRef(false);
  // For a browser that only became a person by opening a link before it was
  // paired: whether it joins the other device's person (true) or adds the
  // other device to its own (false). Null until asked.
  const [joinOther, setJoinOther] = useState<boolean | null>(null);
  const mode =
    holder === null
      ? null
      : !holder
        ? "new"
        : disposable && joinOther === null
          ? "ask"
          : joinOther
            ? "switch"
            : "holder";

  // A device with projects has nothing to ask, so it connects right away.
  // A new one confirms its name first.
  useEffect(() => {
    if (mode === "holder" && linkCode && !started.current) {
      started.current = true;
      void flow.enterCode(linkCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, linkCode]);

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
          holder={mode === "holder"}
          onRestart={() => {
            // Ask again rather than repeat a switch: after one, this browser
            // is no longer a person of its own.
            setJoinOther(null);
            flow.reset();
          }}
        />
      ) : mode === "ask" ? (
        <div className="flex flex-col gap-3 rounded-md border p-4">
          <p className="text-sm">
            This browser became a person of its own when it opened a project,
            and has no other devices yet. Does the device showing the code
            already belong to you?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setJoinOther(true)}>Yes, join it</Button>
            <Button variant="outline" onClick={() => setJoinOther(false)}>
              No, add it to this browser
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Joining moves the projects in this browser over to you the next time
            you open them.
          </p>
        </div>
      ) : (
        mode !== null &&
        !(mode === "holder" && linkCode && !flow.error) && (
          <EnterCodeForm
            initialCode={linkCode}
            deviceName={flow.deviceName}
            onDeviceName={flow.setDeviceName}
            askName={mode !== "holder"}
            busy={flow.busy}
            onSubmit={(code) => void flow.enterCode(code, mode === "switch")}
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
