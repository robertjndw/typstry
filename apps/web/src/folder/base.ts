// What the folder sync remembers about the last time doc and folder agreed.
// Lives in IndexedDB next to the doc (persist/local-doc-store.ts), never in
// the synced doc.
import type { LoroDoc, OpId } from "loro-crdt";

export type BaseFile =
  | {
      kind: "text";
      /** Hash of the bytes on disk. */
      digest: string;
      size: number;
      mtime: number;
      /**
       * Set when the write to disk was skipped mid-cycle: the file still
       * matches the doc at this version, not at the base frontiers.
       */
      at?: OpId[];
      /**
       * Set when the doc took in this disk text through a merge but the
       * merged result was not written back. It is the base of the next
       * merge, since no doc version holds exactly this text.
       */
      text?: string;
    }
  | {
      kind: "asset";
      /** Blob hash the doc references. */
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
 * The base when this doc still contains every version it refers to, else
 * null. A doc that lost history (a reset, a different project under the same
 * id) would otherwise be diffed against a state it never had.
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
