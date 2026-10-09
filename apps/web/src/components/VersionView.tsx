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
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DownloadButton, PdfDownloadButton } from "@/components/DownloadButton";
import { EditorPane } from "@/components/EditorPane";
import { FileTree } from "@/components/FileTree";
import { PreviewPane } from "@/components/PreviewPane";
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
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
}: VersionViewProps & { previous: ProjectDoc }) {
  const { project: version, openFileId, openFile, index, title } = useProject();
  const compiler = useProjectCompiler();
  const [showChanges, setShowChanges] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const changes = useMemo(
    () => compareVersions(previous, version),
    [previous, version],
  );

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
      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-amber-50 px-3 text-sm dark:bg-amber-950/40">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeftIcon />
          Back to live
        </Button>
        <HistoryIcon className="size-4 text-muted-foreground" />
        <span className="truncate">
          Viewing <span className="font-medium">{target.label}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
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
            Show changes
          </Button>
          {canRestore && (
            <Button size="sm" onClick={() => setConfirming(true)}>
              <RotateCcwIcon />
              Restore this version
            </Button>
          )}
        </div>
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="version-files" defaultSize="20" minSize="160px">
          <div className="flex h-full min-h-0 flex-col">
            <ChangeList
              changes={changes}
              selected={openFileId}
              onOpen={(id) => {
                openFile(id);
                setShowChanges(true);
              }}
            />
            <section aria-label="Files" className="min-h-0 flex-1">
              <FileTree />
            </section>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="version-editor" defaultSize="40" minSize="20">
          <section aria-label="Editor" className="h-full">
            {diff ? <DiffView {...diff} /> : <EditorPane compiler={compiler} />}
          </section>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="version-preview" defaultSize="40" minSize="20">
          <section aria-label="Preview" className="h-full">
            <PreviewPane
              client={compiler}
              actions={
                <PdfDownloadButton
                  compiler={compiler}
                  name={[title, target.label]}
                />
              }
            />
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>

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
                      change.changes[0] === "added" && "text-emerald-600",
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
