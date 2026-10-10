import { ChevronLeftIcon, HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { DownloadButton, PdfDownloadButton } from "@/components/DownloadButton";
import { EditorPane, type RevealRequest } from "@/components/EditorPane";
import { FileTree } from "@/components/FileTree";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PresenceBar } from "@/components/PresenceBar";
import { PreviewPane } from "@/components/PreviewPane";
import { ProjectTitle } from "@/components/ProjectTitle";
import { SaveVersionDialog } from "@/components/SaveVersionDialog";
import { VersionView } from "@/components/VersionView";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useProject } from "@/project/context";
import type { VersionTarget } from "@/project/history-items";
import { groupingFromLocation } from "@/project/useHistory";
import type { ProjectDiagnostic } from "@/typst/diagnostics";
import { useProjectCompiler } from "@/project/useProjectCompiler";
import { useProjectTinymist } from "@/project/useProjectTinymist";

/** The full project UI for whatever ProjectProvider is above it. */
export function ProjectWorkspace({
  badge,
  documentTitle = false,
}: {
  badge?: ReactNode;
  /** Mirror the project title into the browser tab (one per page). */
  documentTitle?: boolean;
}) {
  const { title, project, index, openFile, assets, readOnly } = useProject();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<VersionTarget | null>(null);
  const [grouping] = useState(groupingFromLocation);

  useEffect(() => {
    if (!documentTitle) return;
    const previous = document.title;
    document.title = `${title || "Untitled"} · typstry`;
    return () => {
      document.title = previous;
    };
  }, [documentTitle, title]);

  const compiler = useProjectCompiler();
  const tinymist = useProjectTinymist();
  const [reveal, setReveal] = useState<RevealRequest | null>(null);

  // A version brings its own compiler. The live one would keep compiling
  // every remote edit for a preview nobody sees.
  const viewingVersion = viewing !== null;
  useEffect(() => {
    if (!viewingVersion) return;
    compiler?.pause();
    tinymist?.pause();
    return () => {
      compiler?.resume();
      tinymist?.resume();
    };
  }, [viewingVersion, compiler, tinymist]);

  const onDiagnosticClick = useCallback(
    (diagnostic: ProjectDiagnostic) => {
      const fileId = diagnostic.path
        ? index.byPath.get(diagnostic.path)
        : undefined;
      if (!fileId) return;
      openFile(fileId);
      setReveal((prev) => ({ fileId, diagnostic, seq: (prev?.seq ?? 0) + 1 }));
    },
    [index, openFile],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
        <Link
          to="/"
          title="All projects"
          aria-label="All projects"
          className="-ml-1 flex items-center gap-0.5 rounded px-1 font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronLeftIcon className="size-4 text-muted-foreground" />
          typstry
        </Link>
        <ProjectTitle />
        <div className="ml-auto flex items-center gap-3">
          <PresenceBar />
          <DownloadButton project={project} assets={assets} name={[title]} />
          <Button
            variant={historyOpen || viewing ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setHistoryOpen(true)}
          >
            <HistoryIcon />
            History
          </Button>
          {badge}
        </div>
      </header>
      <HistoryPanel
        project={project}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        grouping={grouping}
        selected={viewing?.key ?? null}
        onSelect={(target) => {
          setViewing(target);
          setHistoryOpen(false);
        }}
        // The panel stays open underneath, so the new version shows up in
        // the list right after saving.
        onSaveVersion={readOnly ? undefined : () => setSaving(true)}
      />
      {!readOnly && (
        <SaveVersionDialog
          project={project}
          open={saving}
          onOpenChange={setSaving}
        />
      )}
      {viewing ? (
        <div className="min-h-0 flex-1">
          <VersionView
            key={viewing.key}
            project={project}
            target={viewing}
            assets={assets}
            canRestore={!readOnly}
            onClose={() => setViewing(null)}
          />
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
        >
          <ResizablePanel id="files" defaultSize="20" minSize="160px">
            <section aria-label="Files" className="h-full">
              <FileTree />
            </section>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="editor" defaultSize="40" minSize="20">
            <section aria-label="Editor" className="h-full">
              <EditorPane
                compiler={compiler}
                tinymist={tinymist}
                reveal={reveal}
              />
            </section>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="preview" defaultSize="40" minSize="20">
            <section aria-label="Preview" className="h-full">
              <PreviewPane
                client={compiler}
                onDiagnosticClick={onDiagnosticClick}
                actions={
                  <PdfDownloadButton compiler={compiler} name={[title]} />
                }
              />
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
