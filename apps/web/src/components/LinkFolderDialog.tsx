import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FirstLinkMode, FirstLinkPreview } from "@/folder/engine";

export interface LinkFolderDialogProps {
  /** Null while closed. */
  preview: FirstLinkPreview | null;
  folderName: string;
  onChoose: (mode: FirstLinkMode) => void;
  onCancel: () => void;
}

/**
 * Asked before linking a folder whose files differ from the project's, since
 * one side's version of each of them is about to be replaced.
 */
export function LinkFolderDialog({
  preview,
  folderName,
  onChoose,
  onCancel,
}: LinkFolderDialogProps) {
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => !open && onCancel()}
    >
      {preview && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link &ldquo;{folderName}&rdquo;?</DialogTitle>
            <DialogDescription>
              The folder and the project disagree about{" "}
              {preview.differing.length === 1
                ? "one file"
                : `${preview.differing.length} files`}
              . Pick the side that wins for those. The version that loses stays
              in the project&rsquo;s History.
            </DialogDescription>
          </DialogHeader>
          <ul className="grid gap-1 text-sm">
            <li className="flex justify-between gap-4">
              <span className="text-muted-foreground">Only in the folder</span>
              <span className="tabular-nums">{preview.onlyFolder}</span>
            </li>
            <li className="flex justify-between gap-4">
              <span className="text-muted-foreground">Only in the project</span>
              <span className="tabular-nums">{preview.onlyProject}</span>
            </li>
            <li className="flex justify-between gap-4">
              <span className="text-muted-foreground">Different</span>
              <span className="tabular-nums">{preview.differing.length}</span>
            </li>
          </ul>
          <details className="group text-sm">
            <summary className="cursor-pointer rounded-md text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
              Show the different files
            </summary>
            <ul className="mt-2 max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
              {preview.differing.map((path) => (
                <li key={path} className="truncate" title={path}>
                  {path}
                </li>
              ))}
            </ul>
          </details>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onChoose("project-wins")}
            >
              Use project versions
            </Button>
            <Button
              type="button"
              autoFocus
              onClick={() => onChoose("folder-wins")}
            >
              Use folder versions
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
