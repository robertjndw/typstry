import {
  CloudOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  RotateCwIcon,
  SearchXIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";

import { ConnectionStatus } from "@/components/ConnectionStatus";
import { IdentityControl } from "@/components/IdentityControl";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { ShareDialog } from "@/components/ShareDialog";
import { WorkspaceSkeleton } from "@/components/WorkspaceSkeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { randomIdentity, useStoredIdentity } from "@/presence/identity";
import { PresenceProvider } from "@/presence/PresenceProvider";
import { ProjectProvider } from "@/project/ProjectProvider";
import { useProjectSession } from "@/project/useProjectSession";

export function Project() {
  const { token = "" } = useParams();
  const { hash } = useLocation();
  // Keyed so that a different token never reuses the previous project's doc.
  return (
    <ProjectSessionView
      key={token}
      token={token}
      linkKey={hash.length > 1 ? hash.slice(1) : null}
    />
  );
}

function ProjectSessionView({
  token,
  linkKey,
}: {
  token: string;
  linkKey: string | null;
}) {
  const { state, status, project, ephemeral, syncNow } = useProjectSession(
    token,
    linkKey,
  );
  const stored = useStoredIdentity();
  const [provisional] = useState(() => randomIdentity());
  const identity = stored ?? provisional;

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
      const { share, assets, key, canWrite } = state;
      return (
        <div className="h-svh">
          <ProjectProvider doc={project} assets={assets} readOnly={!canWrite}>
            <PresenceProvider ephemeral={ephemeral} identity={identity}>
              <ProjectWorkspace
                documentTitle
                onSyncNow={syncNow}
                status={<ConnectionStatus status={status} />}
                share={
                  <ShareDialog
                    projectId={share.projectId}
                    token={token}
                    projectKey={key}
                    permission={share.permission}
                    viewToken={share.viewToken}
                  />
                }
                identity={
                  <IdentityControl
                    identity={identity}
                    firstVisit={stored === null}
                  />
                }
              />
            </PresenceProvider>
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

/** Full-page message for the states where there is no workspace to show. */
function Notice({
  icon: Icon,
  tone = "muted",
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  tone?: "muted" | "destructive";
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div
          aria-hidden
          className={cn(
            "flex size-12 items-center justify-center rounded-full",
            tone === "destructive"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-6" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm break-words text-muted-foreground">
            {children}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">{actions}</div>
      </div>
    </main>
  );
}
