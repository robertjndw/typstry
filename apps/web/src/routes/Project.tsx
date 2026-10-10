import { Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";

import { ConnectionStatus } from "@/components/ConnectionStatus";
import { IdentityControl } from "@/components/IdentityControl";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { ShareDialog } from "@/components/ShareDialog";
import { Button } from "@/components/ui/button";
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
  const { state, status, project, ephemeral } = useProjectSession(
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
        <Centered>
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground" role="status">
            Opening project…
          </p>
          {state.phase === "syncing" && state.slow && (
            <>
              <p className="max-w-sm text-center text-sm">
                This is taking longer than usual. The server may be unreachable;
                we keep trying in the background.
              </p>
              <Button variant="outline" onClick={() => location.reload()}>
                Reload
              </Button>
            </>
          )}
        </Centered>
      );
    case "not-found":
      return (
        <Centered>
          <h1 className="text-xl font-semibold">Project not found</h1>
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            This link does not belong to any project. Check that it was copied
            completely.
          </p>
          <Button asChild variant="outline">
            <Link to="/">Go to the start page</Link>
          </Button>
        </Centered>
      );
    case "missing-key":
      return (
        <Centered>
          <h1 className="text-xl font-semibold">This link is incomplete</h1>
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            Projects are end-to-end encrypted, and the key is the part of the
            link after the #. Ask for the full link, or open it in the browser
            you used before.
          </p>
          <Button asChild variant="outline">
            <Link to="/">Go to the start page</Link>
          </Button>
        </Centered>
      );
    case "empty":
      return (
        <Centered>
          <h1 className="text-xl font-semibold">Nothing here yet</h1>
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            This project has not been uploaded yet. It appears once the person
            who created it opens it while online.
          </p>
          <Button variant="outline" onClick={() => location.reload()}>
            Reload
          </Button>
        </Centered>
      );
    case "error":
      return (
        <Centered>
          <h1 className="text-xl font-semibold">Could not open the project</h1>
          <p className="text-sm text-muted-foreground">{state.message}</p>
          <div className="flex gap-2">
            <Button onClick={() => location.reload()}>Try again</Button>
            <Button asChild variant="outline">
              <Link to="/">Start page</Link>
            </Button>
          </div>
        </Centered>
      );
    case "ready": {
      const { share, assets, key } = state;
      return (
        <div className="h-svh">
          <ProjectProvider
            doc={project}
            assets={assets}
            readOnly={share.permission === "read"}
          >
            <PresenceProvider ephemeral={ephemeral} identity={identity}>
              <ProjectWorkspace
                documentTitle
                badge={
                  <span className="flex items-center gap-3">
                    <ConnectionStatus status={status} />
                    <ShareDialog
                      projectId={share.projectId}
                      token={token}
                      projectKey={key}
                      permission={share.permission}
                      viewToken={share.viewToken}
                    />
                    <IdentityControl
                      identity={identity}
                      firstVisit={stored === null}
                    />
                  </span>
                }
              />
            </PresenceProvider>
          </ProjectProvider>
        </div>
      );
    }
  }
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6">
      {children}
    </main>
  );
}
