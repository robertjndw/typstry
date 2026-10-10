import type { OpId } from "loro-crdt";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { tagAt } from "@/doc/history";
import type { ProjectDoc } from "@/doc/schema";
import {
  MAX_VERSION_NAME_CHARS,
  normalizeVersionName,
  saveVersion,
} from "@/doc/versions";

/** What to tag: the current state, or a revision from the history. */
export type TagTarget =
  { kind: "current" } | { kind: "revision"; frontiers: OpId[]; when: string };

export interface TagVersionDialogProps {
  project: ProjectDoc;
  /** Null while closed. */
  target: TagTarget | null;
  onClose: () => void;
}

export function TagVersionDialog({
  project,
  target,
  onClose,
}: TagVersionDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {target && <TagForm project={project} target={target} onDone={onClose} />}
    </Dialog>
  );
}

function TagForm({
  project,
  target,
  onDone,
}: {
  project: ProjectDoc;
  target: TagTarget;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const valid = normalizeVersionName(name) !== null;
  const current = target.kind === "current";
  const frontiers = current ? undefined : target.frontiers;
  // Read once on open; the panel and menu already hide the tag actions for
  // tagged versions, this covers the rest (e.g. a collaborator's tag).
  const [existing] = useState(() => tagAt(project, frontiers));

  if (existing) {
    return (
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Already tagged</DialogTitle>
          <DialogDescription>
            {current ? "The current version" : "This version"} is tagged &ldquo;
            {existing.name}&rdquo;. A version can only have one tag; remove that
            one in the history to tag it differently.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">OK</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    // A collaborator may have tagged it while this dialog was open.
    const raced = tagAt(project, frontiers);
    if (raced) {
      toast.error(`Already tagged "${raced.name}" in the meantime`);
      onDone();
      return;
    }
    const tagged = saveVersion(project, name, { frontiers });
    toast.success(`Tagged "${tagged.name}"`);
    onDone();
  }

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={onSubmit} className="grid gap-4">
        <DialogHeader>
          <DialogTitle>
            {current ? "Tag current version" : "Tag this version"}
          </DialogTitle>
          <DialogDescription>
            {current
              ? "Name the project as it is now, so you can find it in the history and restore it later."
              : `Name the version from ${target.when}, so you can find it in the history and restore it later.`}
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Tag name"
          placeholder="e.g. Submitted draft"
          value={name}
          maxLength={MAX_VERSION_NAME_CHARS}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={!valid}>
            Tag
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
