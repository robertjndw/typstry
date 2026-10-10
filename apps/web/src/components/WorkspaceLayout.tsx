import { EyeIcon, FolderTreeIcon, PencilLineIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  DEFAULT_SIZES,
  type WorkspaceLayoutState,
  type WorkspaceView,
} from "@/hooks/use-workspace-layout";
import { cn } from "@/lib/utils";

const VIEWS: { view: WorkspaceView; label: string; Icon: typeof EyeIcon }[] = [
  { view: "files", label: "Files", Icon: FolderTreeIcon },
  { view: "editor", label: "Editor", Icon: PencilLineIcon },
  { view: "preview", label: "Preview", Icon: EyeIcon },
];

/**
 * Files, editor and preview: side by side and resizable on desktop, one at
 * a time with a bottom switcher on phones. Each slot is wrapped in a
 * labelled region either way.
 */
export function WorkspaceLayout({
  layout,
  files,
  editor,
  preview,
}: {
  layout: WorkspaceLayoutState;
  files: ReactNode;
  editor: ReactNode;
  preview: ReactNode;
}) {
  const { ids } = layout;

  if (layout.isMobile) {
    const slots = { files, editor, preview };
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {VIEWS.map(({ view, label }) => (
          <section
            key={view}
            id={ids[view]}
            aria-label={label}
            hidden={layout.view !== view}
            className="min-h-0 flex-1"
          >
            {slots[view]}
          </section>
        ))}
        <nav
          aria-label="Workspace views"
          className="grid shrink-0 grid-cols-3 gap-1 border-t bg-background px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
        >
          {VIEWS.map(({ view, label, Icon }) => {
            const active = layout.view === view;
            return (
              <button
                key={view}
                type="button"
                aria-pressed={active}
                aria-controls={ids[view]}
                onClick={() => layout.setView(view)}
                className={cn(
                  "flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-xs font-medium text-muted-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active && "bg-muted text-foreground",
                )}
              >
                <Icon aria-hidden className="size-5" />
                {label}
              </button>
            );
          })}
        </nav>
      </div>
    );
  }

  const filesHidden = layout.isHidden("files");
  const previewHidden = layout.isHidden("preview");
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1"
      {...layout.group}
    >
      <ResizablePanel
        id={ids.files}
        defaultSize={String(DEFAULT_SIZES.files)}
        minSize="160px"
        collapsible
        collapsedSize="0"
        {...layout.panels.files}
      >
        {/* inert keeps Tab from wandering into a panel squeezed to zero. */}
        <section aria-label="Files" className="h-full" inert={filesHidden}>
          {files}
        </section>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id={ids.editor}
        defaultSize={String(DEFAULT_SIZES.editor)}
        minSize="20"
      >
        <section aria-label="Editor" className="h-full">
          {editor}
        </section>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id={ids.preview}
        defaultSize={String(DEFAULT_SIZES.preview)}
        minSize="20"
        collapsible
        collapsedSize="0"
        {...layout.panels.preview}
      >
        <section aria-label="Preview" className="h-full" inert={previewHidden}>
          {preview}
        </section>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
