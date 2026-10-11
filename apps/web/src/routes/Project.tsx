import {
  CloudOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  RotateCwIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

import { AccountMenu } from "@/components/AccountMenu";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { Notice } from "@/components/Notice";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { RemovedNotice } from "@/components/RemovedNotice";
import { ShareDialog } from "@/components/ShareDialog";
import { WorkspaceSkeleton } from "@/components/WorkspaceSkeleton";
import { Button } from "@/components/ui/button";
import { RosterProvider } from "@/mls/RosterProvider";
import { provisionalIdentity, useStoredIdentity } from "@/presence/identity";
import { PresenceProvider } from "@/presence/PresenceProvider";
import { ProjectProvider } from "@/project/ProjectProvider";
import { useProjectSession } from "@/project/useProjectSession";

/** What the router carries across a rotation, see ProjectSessionView. */
interface RouteState {
  session?: string;
}

export function Project() {
  const { token = "" } = useParams();
  const { hash, state } = useLocation();
  // Keyed so that a different token never reuses the previous project's doc.
  // A rotation moves the same project to new tokens: the page then keeps its
  // first token as the key, so the doc and the session survive the switch.
  const sessionKey = (state as RouteState | null)?.session ?? token;
  return (
    <ProjectSessionView
      key={sessionKey}
      sessionKey={sessionKey}
      token={token}
      linkKey={hash.length > 1 ? hash.slice(1) : null}
    />
  );
}

function ProjectSessionView({
  sessionKey,
  token,
  linkKey,
}: {
  sessionKey: string;
  token: string;
  linkKey: string | null;
}) {
  const stored = useStoredIdentity();
  const [provisional] = useState(() => provisionalIdentity());
  const identity = stored ?? provisional;
  const { state, status, project, ephemeral, mls, following, syncNow } =
    useProjectSession(token, linkKey, { identity });
  const navigate = useNavigate();

  useEffect(() => {
    if (!following) return;
    void navigate(
      {
        pathname: `/p/${encodeURIComponent(following.token)}`,
        hash: following.link,
      },
      { replace: true, state: { session: sessionKey } satisfies RouteState },
    );
  }, [following, navigate, sessionKey]);

  switch (state.phase) {
    case "resolving":
    case "syncing":
      return (
        <WorkspaceSkeleton>
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
            Opening project…
          </p>
          {state.phase === "syncing" && state.slow && (
            <>
              <p className="text-sm">
                This is taking longer than usual. The server may be unreachable;
                we keep trying in the background.
              </p>
              <Button variant="outline" onClick={() => location.reload()}>
                <RotateCwIcon />
                Reload
              </Button>
            </>
          )}
        </WorkspaceSkeleton>
      );
    case "not-found":
      return (
        <Notice
          icon={SearchXIcon}
          title="Project not found"
          actions={<StartPageButton />}
        >
          This link does not belong to any project. Check that it was copied
          completely.
        </Notice>
      );
    case "missing-key":
      return (
        <Notice
          icon={KeyRoundIcon}
          title="This link is incomplete"
          actions={<StartPageButton />}
        >
          Projects are end-to-end encrypted, and the key is the part of the link
          after the #. Ask for the full link, or open it in the browser you used
          before.
        </Notice>
      );
    case "empty":
      return (
        <Notice
          icon={CloudOffIcon}
          title="Nothing here yet"
          actions={
            <Button variant="outline" onClick={() => location.reload()}>
              <RotateCwIcon />
              Reload
            </Button>
          }
        >
          This project has not been uploaded yet. It appears once the person who
          created it opens it while online.
        </Notice>
      );
    case "removed":
      return <RemovedNotice actions={<StartPageButton />} />;
    case "error":
      return (
        <Notice
          icon={TriangleAlertIcon}
          tone="destructive"
          title="Could not open the project"
          actions={
            <>
              <Button onClick={() => location.reload()}>
                <RotateCwIcon />
                Try again
              </Button>
              <StartPageButton label="Start page" />
            </>
          }
        >
          {state.message}
        </Notice>
      );
    case "ready": {
      const { share, assets, crypto, canWrite } = state;
      return (
        <div className="h-svh">
          <ProjectProvider doc={project} assets={assets} readOnly={!canWrite}>
            <RosterProvider mls={mls} signers={crypto.signers}>
              <PresenceProvider ephemeral={ephemeral} identity={identity}>
                <ProjectWorkspace
                  documentTitle
                  onSyncNow={syncNow}
                  status={<ConnectionStatus status={status} />}
                  share={
                    <ShareDialog
                      projectId={share.projectId}
                      token={token}
                      crypto={crypto}
                      permission={share.permission}
                      viewToken={share.viewToken}
                      mls={mls}
                    />
                  }
                  identity={
                    <AccountMenu
                      identity={identity}
                      firstVisit={stored === null}
                    />
                  }
                />
              </PresenceProvider>
            </RosterProvider>
          </ProjectProvider>
        </div>
      );
    }
  }
}

function StartPageButton({ label = "Go to the start page" }) {
  return (
    <Button asChild variant="outline">
      <Link to="/">{label}</Link>
    </Button>
  );
}
