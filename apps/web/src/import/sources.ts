import { isSafePath } from "@/doc/fs-ops";

import {
  JUNK_DIRS,
  readFiles,
  readZip,
  tooManyEntries,
  MAX_IMPORT_ENTRIES,
  type ImportSource,
} from "./import";

/** What is being imported, and the source once it has been read. */
export interface PendingImport {
  /** A zip is unpacked first, so the UI says so. */
  kind: "zip" | "files";
  source: Promise<ImportSource>;
}

function isZip(name: string): boolean {
  return /\.zip$/i.test(name);
}

/**
 * Files from the picker: a single zip is unpacked, anything else becomes a
 * project of loose files. The picker cannot select folders.
 */
export function readPicked(files: File[]): PendingImport {
  const [only] = files;
  if (files.length === 1 && isZip(only!.name)) {
    return { kind: "zip", source: readZip(only!) };
  }
  return {
    kind: "files",
    source: readFiles(files.map((file) => ({ path: file.name, file }))),
  };
}

type Dropped =
  { kind: "entry"; entry: FileSystemEntry } | { kind: "file"; file: File };

/**
 * Turns a drop into an import: a single zip is unpacked, anything else
 * (files, folders, or both) is imported as it is. Has to be called during
 * the drop event; the browser empties `dataTransfer` once the handler
 * returns, so the items are captured before anything async happens.
 */
export function readDrop(data: DataTransfer): PendingImport | null {
  const dropped: Dropped[] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    // Null for drops that do not come from the file system, e.g. ones
    // built by a script; the plain file still works there.
    const entry = item.webkitGetAsEntry();
    const file = item.getAsFile();
    if (entry) dropped.push({ kind: "entry", entry });
    else if (file) dropped.push({ kind: "file", file });
  }
  if (dropped.length === 0) return null;

  const only = dropped.length === 1 ? data.files[0] : undefined;
  if (only && isZip(only.name) && !isDirectory(dropped[0]!)) {
    return { kind: "zip", source: readZip(only) };
  }
  const source = (async () => {
    const files: { path: string; file: File | null }[] = [];
    for (const d of dropped) {
      if (d.kind === "file") files.push({ path: d.file.name, file: d.file });
      else await walk(d.entry, files);
    }
    return readFiles(files);
  })();
  return { kind: "files", source };
}

function isDirectory(d: Dropped): boolean {
  return d.kind === "entry" && d.entry.isDirectory;
}

async function walk(
  entry: FileSystemEntry,
  out: { path: string; file: File | null }[],
  depth = 0,
): Promise<void> {
  if (out.length >= MAX_IMPORT_ENTRIES) throw tooManyEntries();
  // fullPath starts with "/", which collect() drops along with empty segments.
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ path: entry.fullPath, file });
    return;
  }
  out.push({ path: entry.fullPath, file: null });
  // A dropped folder is usually a project's root, so its own name does not
  // matter (it names the project). Below it, a .git or node_modules can hold
  // more files than the project itself; collect() would drop them, so they
  // are not listed at all. The folder entry above still gets a reserved one
  // reported as skipped.
  if (depth > 0 && (JUNK_DIRS.has(entry.name) || !isSafePath(entry.name)))
    return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries hands out a directory in batches (100 in Chromium) and
  // signals the end with an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, out, depth + 1);
  }
}
