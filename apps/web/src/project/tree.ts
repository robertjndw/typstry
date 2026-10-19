import type { TreeID } from "loro-crdt";
import { toast } from "sonner";

import type { ProjectAssets } from "@/assets/project-assets";
import { uploadFiles, type UploadedFile } from "@/assets/upload";
import { FsError } from "@/doc/fs-ops";
import { basename } from "@/doc/names";
import type { PathIndex } from "@/doc/paths";
import { NODE, type FileKind, type ProjectDoc } from "@/doc/schema";
import { assertImportable, ImportError, writeSource } from "@/import/import";
import { warnSkipped } from "@/import/skipped";
import type { PendingImport } from "@/import/sources";

export interface TreeEntry {
  id: TreeID;
  parent: TreeID | null;
  /** Name as displayed, which differs from `name` after a clash. */
  displayName: string;
  /** Name stored in the doc. */
  name: string;
  path: string;
  kind: FileKind;
  renamed: boolean;
  children: TreeEntry[];
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if ((a.kind === "dir") !== (b.kind === "dir"))
    return a.kind === "dir" ? -1 : 1;
  return (
    collator.compare(a.displayName, b.displayName) ||
    (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0)
  );
}

/**
 * Nested view of the path index, dirs first, then by name. Only nodes that
 * made it into the index (live and well formed) are included.
 */
export function buildTree(project: ProjectDoc, index: PathIndex): TreeEntry[] {
  const entries = new Map<TreeID, TreeEntry>();
  for (const [id, { path, kind, renamed }] of index.byId) {
    const node = project.fs.getNodeByID(id);
    if (!node) continue;
    const stored: unknown = node.data.get(NODE.name);
    const displayName = basename(path);
    entries.set(id, {
      id,
      parent: node.parent()?.id ?? null,
      displayName,
      name: typeof stored === "string" ? stored : displayName,
      path,
      kind,
      renamed,
      children: [],
    });
  }
  const roots: TreeEntry[] = [];
  for (const entry of entries.values()) {
    const parent = entry.parent === null ? null : entries.get(entry.parent);
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }
  const sort = (list: TreeEntry[]) => {
    list.sort(compareEntries);
    for (const entry of list) sort(entry.children);
  };
  sort(roots);
  return roots;
}

/** Runs a file operation, showing a toast instead of throwing on failure. */
export function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    toast.error(friendlyFsError(err));
    return undefined;
  }
}

/**
 * Uploads `files` under `parent`, showing a toast for each file that failed
 * instead of throwing. Resolves to the files that were created.
 */
export async function uploadReporting(
  project: ProjectDoc,
  assets: ProjectAssets,
  files: File[],
  parent: TreeID | null,
): Promise<UploadedFile[]> {
  try {
    const { created, errors } = await uploadFiles(
      project,
      assets,
      files,
      parent,
    );
    for (const failure of errors)
      toast.error(`${failure.name}: ${failure.error.message}`);
    return created;
  } catch (err) {
    toast.error(friendlyFsError(err));
    return [];
  }
}

/**
 * Restores a folder or zip under `parent`, reporting progress and the outcome
 * in one toast. Resolves to the created entries, or null when it failed.
 */
export async function uploadTreeReporting(
  project: ProjectDoc,
  assets: ProjectAssets,
  pending: PendingImport,
  parent: TreeID | null,
): Promise<{ created: Map<string, TreeID>; top: TreeID[] } | null> {
  const id = toast.loading(
    pending.kind === "zip" ? "Unpacking zip…" : "Reading files…",
  );
  try {
    const source = await pending.source;
    assertImportable(source);
    const result = await writeSource(
      project,
      source,
      assets,
      parent,
      (uploaded, total) => {
        if (total > 0)
          toast.loading(`Uploading files (${uploaded} of ${total})…`, { id });
      },
    );
    const count = source.files.size;
    toast.success(`Uploaded ${count} ${count === 1 ? "file" : "files"}`, {
      id,
    });
    warnSkipped(source.skipped);
    return result;
  } catch (err) {
    toast.error(
      err instanceof ImportError ? err.message : friendlyFsError(err),
      { id },
    );
    return null;
  }
}

function friendlyFsError(err: unknown): string {
  if (!(err instanceof FsError)) {
    console.error(err);
    return "Something went wrong. See the console for details.";
  }
  switch (err.code) {
    case "invalid-name":
      return err.message;
    case "name-taken":
      return `${err.message} in this folder`;
    case "not-found":
      return "That file no longer exists. Someone may have deleted it.";
    case "not-a-directory":
      return "Files can only be placed inside folders";
    case "not-a-text-file":
      return "Only text files can be the main file";
    case "cycle":
      return "A folder cannot be moved into itself";
  }
}
