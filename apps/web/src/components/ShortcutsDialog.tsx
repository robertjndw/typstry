import { ShortcutKeys } from "@/components/ShortcutKeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHORTCUTS } from "@/lib/shortcuts";

const GROUPS: { title: string; items: { label: string; combo: string }[] }[] = [
  {
    title: "Workspace",
    items: [
      { label: "Open a file by name", combo: SHORTCUTS.quickOpen },
      { label: "Sync now", combo: SHORTCUTS.syncNow },
      { label: "Show or hide files", combo: SHORTCUTS.toggleFiles },
      { label: "Show or hide the preview", combo: SHORTCUTS.togglePreview },
    ],
  },
  {
    title: "Editor",
    items: [
      { label: "Undo", combo: "Mod+Z" },
      { label: "Redo", combo: "Mod+Shift+Z" },
      { label: "Find and replace", combo: "Mod+F" },
      { label: "Toggle comment", combo: "Mod+/" },
      // CodeMirror binds this to Ctrl on every platform.
      { label: "Suggest completions", combo: "Ctrl+Space" },
      // Tab indents inside the editor, so leaving it takes Escape first.
      { label: "Move focus out of the editor", combo: "Esc+Tab" },
    ],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Workspace shortcuts also work while you type in the editor.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                {group.title}
              </h3>
              <dl className="divide-y">
                {group.items.map(({ label, combo }) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4 py-1.5"
                  >
                    <dt>{label}</dt>
                    <dd>
                      <ShortcutKeys combo={combo} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
