import { LoroDoc } from "loro-crdt";
import {
  ArrowLeftIcon,
  DiffIcon,
  FileMinusIcon,
  FilePenIcon,
  FilePlusIcon,
  HistoryIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DownloadButton, PdfDownloadButton } from "@/components/DownloadButton";
import { EditorPane } from "@/components/EditorPane";
import { FileTree } from "@/components/FileTree";
import { PreviewPane } from "@/components/PreviewPane";
import { WorkspaceLayout } from "@/components/WorkspaceLayout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  compareVersions,
  fileText,
  restoreVersion,
  versionAt,
  type FileChange,
} from "@/doc/restore";
import type { ProjectAssets } from "@/assets/project-assets";
import { ProjectDoc } from "@/doc/schema";
import { DiffView } from "@/editor/DiffView";
import { useWorkspaceLayout } from "@/hooks/use-workspace-layout";
import { cn } from "@/lib/utils";
import { PresenceContext } from "@/presence/context";
import type { VersionTarget } from "@/project/history-items";
import { useProject } from "@/project/context";
import { ProjectProvider } from "@/project/ProjectProvider";
import { useProjectCompiler } from "@/project/useProjectCompiler";

export interface VersionViewProps {
  /** The live project. It is only read, except by "Restore". */
  project: ProjectDoc;
  target: VersionTarget;
  assets: ProjectAssets | null;
  canRestore: boolean;
  onClose: () => void;
  /** Open on the diff of the first changed file instead of the main file. */
  showChangesOnOpen?: boolean;
}

/**
 * Read-only view of an old version: its files, contents and preview, all
 * from a fork, so the live doc keeps syncing untouched underneath.
 */
export function VersionView(props: VersionViewProps) {
  const { project, target } = props;
  const forks = useMemo(() => {
    try {
      return {
        version: versionAt(project, target.frontiers),
        previous: target.previous
          ? versionAt(project, target.previous)
          : new ProjectDoc(new LoroDoc()),
      };
    } catch (err) {
      // Frontiers from a malformed named version that this doc never saw.
      console.error("cannot open version", err);
      return null;
    }
  }, [project, target]);

  if (!forks) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
        <p>This version cannot be opened.</p>
        <Button variant="outline" onClick={props.onClose}>
          Back to the project
        </Button>
      </div>
    );
  }

  return (
    <ProjectProvider
      doc={forks.version}
      readOnly
      assets={props.assets ?? undefined}
    >
      {/* No presence: browsing an old version must not show up as a cursor
          in someone's live file. */}
      <PresenceContext.Provider value={null}>
        <VersionBody {...props} previous={forks.previous} />
      </PresenceContext.Provider>
    </ProjectProvider>
  );
}

function VersionBody({
  project,
  target,
  assets,
  canRestore,
  onClose,
  previous,
  showChangesOnOpen = false,
}: VersionViewProps & { previous: ProjectDoc }) {
  const { project: version, openFileId, openFile, index, title } = useProject();
  const compiler = useProjectCompiler();
  const [showChanges, setShowChanges] = useState(showChangesOnOpen);
  const [confirming, setConfirming] = useState(false);
  const layout = useWorkspaceLayout("version");
  const changes = useMemo(
    () => compareVersions(previous, version),
    [previous, version],
  );

  // The main file opens by default, but it may not have changed at all,
  // which would make the diff look empty.
  const pickedChange = useRef(!showChangesOnOpen);
  useEffect(() => {
    if (pickedChange.current) return;
    pickedChange.current = true;
    const diffable = changes.filter(
      (c) => c.kind === "text" && c.changes[0] !== "deleted",
    );
    if (diffable.some((c) => c.id === openFileId)) return;
    if (diffable[0]) openFile(diffable[0].id);
  }, [changes, openFileId, openFile]);

  const openKind = openFileId ? index.byId.get(openFileId)?.kind : undefined;
  const diff =
    showChanges && openFileId && openKind === "text"
      ? {
          original: fileText(previous, openFileId) ?? "",
          text: fileText(version, openFileId) ?? "",
          path: index.byId.get(openFileId)?.path ?? "",
        }
      : null;

  function restore() {
    try {
      restoreVersion(project, version, target.label);
      toast.success(`Restored "${target.label}"`);
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("Restoring failed. See the console for details.");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-2 text-sm">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeftIcon />
          <span className="max-md:sr-only">Back to live</span>
        </Button>
        <HistoryIcon aria-hidden className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 truncate">
          Viewing <span className="font-medium">{target.label}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <DownloadButton
            project={version}
            assets={assets}
            name={[title, target.label]}
            mtime={target.time ?? undefined}
            variant="outline"
          />
          <Button
            variant={showChanges ? "secondary" : "outline"}
            size="sm"
            aria-pressed={showChanges}
            onClick={() => setShowChanges((v) => !v)}
          >
            <DiffIcon />
            <span className="max-md:sr-only">Show changes</span>
          </Button>
          {canRestore && (
            <Button size="sm" onClick={() => setConfirming(true)}>
              <RotateCcwIcon />
              <span className="max-md:sr-only">Restore this version</span>
            </Button>
          )}
        </div>
      </div>
      <WorkspaceLayout
        layout={layout}
        files={
          <div className="flex h-full min-h-0 flex-col">
            <ChangeList
              changes={changes}
              selected={openFileId}
              onOpen={(id) => {
                openFile(id);
                setShowChanges(true);
              }}
            />
            <div className="min-h-0 flex-1">
              <FileTree />
            </div>
          </div>
        }
        editor={
          diff ? <DiffView {...diff} /> : <EditorPane compiler={compiler} />
        }
        preview={
          <PreviewPane
            client={compiler}
            actions={
              <PdfDownloadButton
                compiler={compiler}
                name={[title, target.label]}
              />
            }
          />
        }
      />

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this version?</DialogTitle>
            <DialogDescription>
              The project goes back to "{target.label}" for everyone. Nothing is
              lost: the current state stays in the history and can be restored
              too.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={restore}>Restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const CHANGE_ICONS = {
  added: FilePlusIcon,
  deleted: FileMinusIcon,
  modified: FilePenIcon,
  renamed: FilePenIcon,
} as const;

function ChangeList({
  changes,
  selected,
  onOpen,
}: {
  changes: FileChange[];
  selected: string | null;
  onOpen: (id: FileChange["id"]) => void;
}) {
  return (
    <section
      aria-label="Changes in this version"
      className="max-h-[40%] shrink-0 overflow-y-auto border-b"
    >
      <h2 className="px-3 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Changes
      </h2>
      {changes.length === 0 ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          No file changes
        </p>
      ) : (
        <ul className="pb-1">
          {changes.map((change) => {
            const Icon = CHANGE_ICONS[change.changes[0]!];
            const deleted = change.changes[0] === "deleted";
            return (
              <li key={change.id}>
                <button
                  type="button"
                  disabled={deleted || change.kind === "dir"}
                  onClick={() => onOpen(change.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1 text-left text-xs enabled:hover:bg-muted",
                    selected === change.id && "bg-muted",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-3.5 shrink-0",
                      change.changes[0] === "added" && "text-success",
                      deleted && "text-destructive",
                    )}
                  />
                  <span
                    className={cn(
                      "truncate font-mono",
                      deleted && "line-through",
                    )}
                    title={
                      change.oldPath && change.oldPath !== change.path
                        ? `${change.oldPath} → ${change.path}`
                        : change.path
                    }
                  >
                    {change.path}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {change.changes.join(", ")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
