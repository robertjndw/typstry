import type { TreeID } from "loro-crdt";

import { children, createAsset, createFile, validateName } from "@/doc/fs-ops";
import { extensionOf, stemLength } from "@/doc/names";
import { NODE, type ProjectDoc } from "@/doc/schema";
import { toError } from "@/lib/errors";

import type { ProjectAssets } from "./project-assets";

/** Imported into the doc as editable text instead of going to the blob store. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "typ",
  "bib",
  "yml",
  "yaml",
  "toml",
  "csv",
  "txt",
  "json",
  "xml",
  "svg",
  "md",
]);

// Larger "text" files (data dumps, huge CSVs) would bloat the CRDT history
// for every peer forever, so they are stored as blobs. Typst reads them the
// same way.
export const MAX_TEXT_BYTES = 1024 * 1024;

export interface UploadedFile {
  id: TreeID;
  /** Final name, which may carry a " (2)" style suffix. */
  name: string;
  kind: "text" | "asset";
}

export interface UploadFailure {
  name: string;
  error: Error;
}

export interface UploadResult {
  created: UploadedFile[];
  errors: UploadFailure[];
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The first of "name", "name (2)", "name (3)", ... that no live sibling
 * uses. The suffix goes before the extension: "logo (2).png".
 */
export function freeName(
  project: ProjectDoc,
  parent: TreeID | null,
  name: string,
): string {
  const taken = new Set<unknown>(
    children(project, parent).map((node) => node.data.get(NODE.name)),
  );
  if (!taken.has(name)) return name;
  const split = stemLength(name);
  const stem = name.slice(0, split);
  const ext = name.slice(split);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function isTextCandidate(name: string, size: number): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(name)) && size <= MAX_TEXT_BYTES;
}

/** The file's text, or null when it should be stored as a blob instead. */
export function decodeText(name: string, bytes: Uint8Array): string | null {
  if (!isTextCandidate(name, bytes.length)) return null;
  try {
    // fatal: a Latin-1 .bib decoded leniently would be silently corrupted;
    // as a blob its bytes at least stay intact.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return normalizeNewlines(decoder.decode(bytes));
  } catch {
    return null;
  }
}

async function readText(file: File): Promise<string | null> {
  // Checked before reading, so a big binary is not read here and then again
  // for the upload.
  if (!isTextCandidate(file.name, file.size)) return null;
  return decodeText(file.name, new Uint8Array(await file.arrayBuffer()));
}

/**
 * Adds dropped or picked files to the project under `parent`. Text formats
 * become editable text files, everything else goes to the blob store first.
 * Each file succeeds or fails on its own; the doc is only touched once a
 * file's upload is done, so a failed upload leaves no trace.
 */
export async function uploadFiles(
  project: ProjectDoc,
  assets: ProjectAssets,
  files: File[],
  parent: TreeID | null,
): Promise<UploadResult> {
  const results = await Promise.all(
    files.map(async (file): Promise<UploadedFile | UploadFailure> => {
      try {
        return await addFile(project, assets, file, parent);
      } catch (err) {
        return {
          name: file.name,
          error: toError(err),
        };
      }
    }),
  );
  const out: UploadResult = { created: [], errors: [] };
  for (const r of results) {
    if ("error" in r) out.errors.push(r);
    else out.created.push(r);
  }
  return out;
}

async function addFile(
  project: ProjectDoc,
  assets: ProjectAssets,
  file: File,
  parent: TreeID | null,
): Promise<UploadedFile> {
  // Checked up front as well so a bad name fails before the upload, not after.
  validateName(file.name);
  const text = await readText(file);
  if (text !== null) {
    const name = freeName(project, parent, file.name);
    const id = createFile(project, parent, name, "text", text);
    return { id, name, kind: "text" };
  }

  const asset = await assets.store(file);
  // Picked after the upload: other files of this batch, or a peer, may have
  // taken the name in the meantime.
  const name = freeName(project, parent, file.name);
  const id = createAsset(project, parent, name, asset);
  return { id, name, kind: "asset" };
}
