// What the sync remembers about the last time doc and folder agreed. Stored in
// IndexedDB next to the doc (persist/local-doc-store.ts), never in the doc.
import type { LoroDoc, OpId } from "loro-crdt";

export type BaseFile =
  | {
      kind: "text";
      digest: string;
      size: number;
      mtime: number;
      /** Set when the disk write was skipped mid-cycle: the file matches the doc at this version, not the base frontiers. */
      at?: OpId[];
      /** Set when a merge was taken into the doc but not written back. Base of the next merge, since no doc version holds this text. */
      text?: string;
    }
  | {
      kind: "asset";
      hash: string;
      digest: string;
      size: number;
      mime: string;
      mtime: number;
      at?: OpId[];
    };

export interface FolderBase {
  frontiers: OpId[];
  files: Record<string, BaseFile>;
}

export interface FolderLink {
  spaceId: string;
  v: 1;
  handle: FileSystemDirectoryHandle;
  name: string;
  base: FolderBase | null;
}

function known(doc: LoroDoc, frontiers: OpId[]): boolean {
  try {
    // Throws when an op of the frontiers is not in the oplog at all.
    const wanted = doc.frontiersToVV(frontiers);
    const order = doc.oplogVersion().compare(wanted);
    return order === 0 || order === 1;
  } catch {
    return false;
  }
}

/**
 * The base if this doc still contains every version it refers to, else null.
 * A doc that lost history (reset, different project under the same id) would
 * otherwise be diffed against a state it never had.
 */
export function trustedBase(
  doc: LoroDoc,
  base: FolderBase | null,
): FolderBase | null {
  if (!base || !known(doc, base.frontiers)) return null;
  for (const file of Object.values(base.files)) {
    if (file.at && !known(doc, file.at)) return null;
  }
  return base;
}
