import {
  HardDriveIcon,
  Loader2Icon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";

import { AccountMenu } from "@/components/AccountMenu";
import { Notice, StartPageButton } from "@/components/Notice";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { WorkspaceSkeleton } from "@/components/WorkspaceSkeleton";
import { FolderSyncProvider } from "@/folder/FolderSyncProvider";
import { provisionalIdentity, useStoredIdentity } from "@/presence/identity";
import { ProjectProvider } from "@/project/ProjectProvider";
import { useStandaloneSession } from "@/project/useStandaloneSession";

/**
 * The editor for the static build: the project lives in this browser alone,
 * so there is no connection, roster, presence or sharing to show.
 */
export function StandaloneProject() {
  const { token = "" } = useParams();
  // Keyed so that a different project never reuses the previous one's doc.
  return <StandaloneView key={token} projectId={token} />;
}

function StandaloneView({ projectId }: { projectId: string }) {
  const stored = useStoredIdentity();
  const [provisional] = useState(() => provisionalIdentity());
  const identity = stored ?? provisional;
  const { state, project, saveLocally } = useStandaloneSession(projectId);

  switch (state.phase) {
    case "loading":
      return (
        <WorkspaceSkeleton>
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
            Opening project…
          </p>
        </WorkspaceSkeleton>
      );
    case "not-found":
      return (
        <Notice
          icon={SearchXIcon}
          title="Project not found"
          actions={<StartPageButton />}
        >
          This browser has no project with this link. Projects here are not
          stored on a server, so they only open in the browser that created
          them.
        </Notice>
      );
    case "error":
      return (
        <Notice
          icon={TriangleAlertIcon}
          tone="destructive"
          title="Could not open the project"
          actions={<StartPageButton label="Start page" />}
        >
          {state.message}
        </Notice>
      );
    case "ready":
      return (
        <div className="h-svh">
          <ProjectProvider
            doc={project}
            assets={state.assets}
            readOnly={false}
            projectId={projectId}
            synced
          >
            <FolderSyncProvider
              spaceId={projectId}
              project={project}
              assets={state.assets}
              canWrite
              synced
              saveLocally={saveLocally}
            >
              <ProjectWorkspace
                documentTitle
                badge={
                  <span
                    title="Projects are stored in this browser only. Export a zip or link a folder to keep a copy."
                    className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
                  >
                    <HardDriveIcon aria-hidden className="size-3.5" />
                    Saved in this browser
                  </span>
                }
                identity={<AccountMenu identity={identity} />}
              />
            </FolderSyncProvider>
          </ProjectProvider>
        </div>
      );
  }
}
