import {
  ChevronLeftIcon,
  HistoryIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { PdfDownloadButton } from "@/components/DownloadButton";
import { EditorPane, type RevealRequest } from "@/components/EditorPane";
import { FileTree } from "@/components/FileTree";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PresenceBar } from "@/components/PresenceBar";
import { PreviewPane } from "@/components/PreviewPane";
import { ProjectTitle } from "@/components/ProjectTitle";
import { QuickOpen } from "@/components/QuickOpen";
import {
  TagVersionDialog,
  type TagTarget,
} from "@/components/TagVersionDialog";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { ToolbarButton } from "@/components/ToolbarButton";
import { VersionView } from "@/components/VersionView";
import { WorkspaceLayout } from "@/components/WorkspaceLayout";
import { WorkspaceMenu } from "@/components/WorkspaceMenu";
import { Separator } from "@/components/ui/separator";
import { useShortcuts } from "@/hooks/use-shortcut";
import { useWorkspaceLayout } from "@/hooks/use-workspace-layout";
import { cn } from "@/lib/utils";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useProject } from "@/project/context";
import type { VersionTarget } from "@/project/history-items";
import type { SyncNowResult } from "@/sync/connection";
import { groupingFromLocation } from "@/project/useHistory";
import type { ProjectDiagnostic } from "@/typst/diagnostics";
import { useProjectCompiler } from "@/project/useProjectCompiler";
import { useProjectTinymist } from "@/project/useProjectTinymist";

export interface ProjectWorkspaceProps {
  /** Sync state indicator; stays visible on phones too. */
  status?: ReactNode;
  /** The prominent share action. */
  share?: ReactNode;
  /** Own avatar, rightmost. */
  identity?: ReactNode;
  /** Anything else for the toolbar, e.g. the dev split's switches. */
  badge?: ReactNode;
  /** Mirror the project title into the browser tab (one per page). */
  documentTitle?: boolean;
  /** Pushes pending edits now; absent without a server connection. */
  onSyncNow?: () => Promise<SyncNowResult>;
}

/** The full project UI for whatever ProjectProvider is above it. */
export function ProjectWorkspace({
  status,
  share,
  identity,
  badge,
  documentTitle = false,
  onSyncNow,
}: ProjectWorkspaceProps) {
  const { title, project, index, openFile, assets, readOnly } = useProject();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tagging, setTagging] = useState<TagTarget | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [viewing, setViewing] = useState<{
    target: VersionTarget;
    changes: boolean;
  } | null>(null);
  const [grouping] = useState(groupingFromLocation);
  const layout = useWorkspaceLayout("workspace");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!documentTitle) return;
    const previous = document.title;
    document.title = `${title || "Untitled"} · typstry`;
    return () => {
      document.title = previous;
    };
  }, [documentTitle, title]);

  const compiler = useProjectCompiler();
  const tinymist = useProjectTinymist(compiler);
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

  const tag = readOnly ? undefined : setTagging;
  const syncing = useRef(false);
  const syncNow = onSyncNow
    ? () => {
        if (syncing.current) return;
        syncing.current = true;
        void syncWithFeedback(onSyncNow, readOnly).finally(() => {
          syncing.current = false;
        });
      }
    : undefined;

  // The layout shortcuts would act on panels hidden behind an old version,
  // so they only swallow the key then.
  useShortcuts(
    {
      // Swallowed even without a connection, so the browser's "Save page"
      // dialog never shows up in the middle of writing.
      [SHORTCUTS.syncNow]: () => syncNow?.(),
      [SHORTCUTS.quickOpen]: () => !viewing && setQuickOpen((open) => !open),
      [SHORTCUTS.toggleFiles]: () => !viewing && layout.toggle("files"),
      [SHORTCUTS.togglePreview]: () => !viewing && layout.toggle("preview"),
    },
    { scope: root },
  );

  const mobile = layout.isMobile;
  const filesShown = !layout.isHidden("files");
  const previewShown = !layout.isHidden("preview");

  return (
    <div
      ref={root}
      data-shortcut-scope=""
      className="flex h-full min-h-0 flex-col"
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-1 border-b px-2",
          mobile ? "h-12" : "h-11",
        )}
      >
        <Link
          to="/"
          title="All projects"
          aria-label="All projects"
          className="flex h-7 shrink-0 items-center gap-0.5 rounded-md pr-1.5 pl-0.5 text-sm font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronLeftIcon className="size-4 text-muted-foreground" />
          {!mobile && "typstry"}
        </Link>
        {!mobile && (
          <span aria-hidden className="text-sm text-muted-foreground/60">
            /
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center">
          <ProjectTitle className="max-w-80" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!mobile && (
            <>
              <PresenceBar />
              {status}
              <Separator orientation="vertical" className="mx-1 h-5" />
              <ToolbarButton
                label="Files panel"
                tooltip={filesShown ? "Hide files" : "Show files"}
                shortcut={SHORTCUTS.toggleFiles}
                aria-pressed={filesShown}
                aria-controls={layout.ids.files}
                disabled={!!viewing}
                onClick={() => layout.toggle("files")}
              >
                <PanelLeftIcon />
              </ToolbarButton>
              <ToolbarButton
                label="Preview panel"
                tooltip={previewShown ? "Hide preview" : "Show preview"}
                shortcut={SHORTCUTS.togglePreview}
                aria-pressed={previewShown}
                aria-controls={layout.ids.preview}
                disabled={!!viewing}
                onClick={() => layout.toggle("preview")}
              >
                <PanelRightIcon />
              </ToolbarButton>
              <ToolbarButton
                label="History"
                tooltip="Version history"
                variant={historyOpen || viewing ? "secondary" : "ghost"}
                onClick={() => setHistoryOpen(true)}
              >
                <HistoryIcon />
              </ToolbarButton>
            </>
          )}
          {mobile && status}
          <WorkspaceMenu
            layout={layout}
            panelsDisabled={!!viewing}
            onHistory={() => setHistoryOpen(true)}
            onTagVersion={tag && (() => tag({ kind: "current" }))}
            onQuickOpen={() => setQuickOpen(true)}
            onShortcuts={() => setShortcutsOpen(true)}
            onSyncNow={syncNow}
          />
          {badge}
          {share && <div className="ml-1 flex items-center">{share}</div>}
          {identity && <div className="ml-1 flex items-center">{identity}</div>}
        </div>
      </header>
      <HistoryPanel
        project={project}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        grouping={grouping}
        selected={viewing?.target.key ?? null}
        onSelect={(target) => {
          setViewing({ target, changes: false });
          setHistoryOpen(false);
        }}
        onShowChanges={(target) => {
          setViewing({ target, changes: true });
          setHistoryOpen(false);
        }}
        assets={assets}
        title={title}
        // The panel stays open underneath, so the new tag shows up in the
        // list right after tagging.
        onTag={tag}
      />
      {!readOnly && (
        <TagVersionDialog
          project={project}
          target={tagging}
          onClose={() => setTagging(null)}
        />
      )}
      <QuickOpen open={quickOpen} onOpenChange={setQuickOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {viewing ? (
        <div className="min-h-0 flex-1">
          <VersionView
            // Remounted when "Show changes" is picked for the version
            // already open, so it switches to the diff.
            key={`${viewing.target.key}:${viewing.changes}`}
            project={project}
            target={viewing.target}
            assets={assets}
            canRestore={!readOnly}
            onClose={() => setViewing(null)}
            showChangesOnOpen={viewing.changes}
          />
        </div>
      ) : (
        <WorkspaceLayout
          layout={layout}
          files={<FileTree />}
          editor={
            <EditorPane
              compiler={compiler}
              tinymist={tinymist}
              reveal={reveal}
            />
          }
          preview={
            <PreviewPane
              client={compiler}
              onDiagnosticClick={onDiagnosticClick}
              actions={<PdfDownloadButton compiler={compiler} name={[title]} />}
            />
          }
        />
      )}
    </div>
  );
}

const SYNC_TOAST = "sync-now";

async function syncWithFeedback(
  run: () => Promise<SyncNowResult>,
  readOnly: boolean,
) {
  // One toast id, so repeated presses update a single toast instead of
  // stacking them.
  toast.loading("Syncing…", { id: SYNC_TOAST });
  let result: SyncNowResult;
  try {
    result = await run();
  } catch (err) {
    // The local save can throw, e.g. when storage is full.
    console.error(err);
    toast.error("Syncing failed. See the console for details.", {
      id: SYNC_TOAST,
    });
    return;
  }
  if (result === "synced") {
    toast.success(readOnly ? "Up to date" : "All changes synced", {
      id: SYNC_TOAST,
    });
  } else {
    toast.warning(
      readOnly
        ? "The server is unreachable. Updates arrive once it is back."
        : "The server is unreachable. Your changes are saved on this device and sync once it is back.",
      { id: SYNC_TOAST },
    );
  }
}
