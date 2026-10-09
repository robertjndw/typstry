import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ProjectDoc } from "@/doc/schema";
import {
  MAX_VERSION_NAME_CHARS,
  normalizeVersionName,
  saveVersion,
} from "@/doc/versions";

export interface SaveVersionDialogProps {
  project: ProjectDoc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SaveVersionDialog({
  project,
  open,
  onOpenChange,
}: SaveVersionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <SaveVersionForm project={project} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

function SaveVersionForm({
  project,
  onDone,
}: {
  project: ProjectDoc;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const valid = normalizeVersionName(name) !== null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const saved = saveVersion(project, name);
    toast.success(`Saved version "${saved.name}"`);
    onDone();
  }

  return (
    <DialogContent>
      <form onSubmit={onSubmit} className="grid gap-4">
        <DialogHeader>
          <DialogTitle>Save version</DialogTitle>
          <DialogDescription>
            Name the current state so you can find it in the history and restore
            it later.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Version name"
          placeholder="e.g. Submitted draft"
          value={name}
          maxLength={MAX_VERSION_NAME_CHARS}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <DialogFooter>
          <Button type="submit" disabled={!valid}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
