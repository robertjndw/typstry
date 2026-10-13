import { Link, useLocation, useNavigate } from "react-router";
import { useEffect, useState } from "react";

import { EnterCodeForm } from "@/components/EnterCodeForm";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { ApprovalDialog, PairingStatus } from "@/components/PairingStatus";
import { usePairingFlow } from "@/pairing/usePairingFlow";

/** A hand-edited or truncated link can carry a broken escape. */
function codeFromHash(hash: string): string {
  if (hash.length <= 1) return "";
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
}

/**
 * The page a pairing link opens. The code rides in the fragment, which never
 * reaches the server.
 */
export function Pair() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [linkCode] = useState(() => codeFromHash(hash));
  // The code is spent once used, but keeping it out of the address bar and
  // history means a synced history or someone looking over a shoulder never
  // sees a live one.
  useEffect(() => {
    if (hash) void navigate({ hash: "" }, { replace: true });
  }, [hash, navigate]);
  const flow = usePairingFlow();
  const { holder, disposable, state, session } = flow;
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

  // Opening a link must not pair by itself: anyone can send one, and a
  // device that connects on load would let a stranger's code start an
  // attempt the user never chose. Only a device with projects is asked here;
  // a new one confirms through its form, which waits for a click too.
  const [linkTried, setLinkTried] = useState(false);
  // Kept up while the attempt starts, so the code form does not flash in
  // before the pairing status replaces it.
  const confirmLink =
    mode === "holder" &&
    linkCode !== "" &&
    (!linkTried || flow.busy) &&
    !flow.error;

  return (
    <PageShell outside={<ApprovalDialog session={session} state={state} />}>
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Add a device
        </h1>
        <p className="text-sm text-muted-foreground">
          Pair this browser with another device of yours. It gets your projects,
          including the ones you add later, and edits them as you.
        </p>
      </div>
      {state ? (
        <PairingStatus
          state={state}
          holder={mode === "holder"}
          fingerprint={session?.ownFingerprint}
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
      ) : confirmLink ? (
        <div className="flex flex-col gap-3 rounded-md border p-4">
          <p className="text-sm">
            This link wants to add another device to your account. That device
            would get your projects and edit them as you. Only continue if you
            opened it from a device of your own that is showing this code.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={flow.busy}
              onClick={() => {
                setLinkTried(true);
                void flow.enterCode(linkCode);
              }}
            >
              Connect to the other device
            </Button>
            <Button variant="outline" asChild>
              <Link to="/">Cancel</Link>
            </Button>
          </div>
        </div>
      ) : (
        mode !== null && (
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
