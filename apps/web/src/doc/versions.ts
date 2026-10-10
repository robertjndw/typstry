// Named versions ("Save version"). Each one is a plain value appended to the
// root `versions` list:
//
//   { name: string, frontiers: Uint8Array (encodeFrontiers), createdAt:
//     number (unix ms), author: PeerID }
//
// The list is append-only and the doc keeps its full history, so a version
// can always be checked out with forkAt(frontiers). This is the hook for git
// export later: one named version maps to one commit whose tree is
// materialize_at(frontiers) and whose author comes from the peers map.
//
// Deleting a version leaves its entry in place and records it in the root
// `deletedVersions` map instead, keyed by the entry's list element id
// ("counter@peer") with the deletion time as value. Removing the entry would
// shift every later index, and the CLI addresses versions as #index. The id
// rather than the index is the key because concurrent saves on two peers can
// still reorder entries until they have synced.
import {
  decodeFrontiers,
  encodeFrontiers,
  type OpId,
  type PeerID,
} from "loro-crdt";

import { normalizeBounded } from "./names";
import { META_ORIGIN, type ProjectDoc } from "./schema";

export const MAX_VERSION_NAME_CHARS = 100;

export const VERSION = {
  name: "name",
  frontiers: "frontiers",
  createdAt: "createdAt",
  author: "author",
} as const;

export interface NamedVersion {
  /** Position in the list; stable because entries are never removed. */
  index: number;
  /** The entry's list element id, which is what deleting it records. */
  id: string;
  name: string;
  frontiers: OpId[];
  createdAt: number;
  author: PeerID;
}

export function normalizeVersionName(raw: string): string | null {
  return normalizeBounded(raw, MAX_VERSION_NAME_CHARS);
}

/** Names the current state of `project` (or the given frontiers). */
export function saveVersion(
  project: ProjectDoc,
  rawName: string,
  options: { frontiers?: OpId[]; now?: number } = {},
): NamedVersion {
  const name = normalizeVersionName(rawName);
  if (name === null) {
    throw new Error(
      `Version name must be 1 to ${MAX_VERSION_NAME_CHARS} characters`,
    );
  }
  const { doc } = project;
  // Pending edits belong to the version being named.
  doc.commit();
  const frontiers = options.frontiers ?? doc.oplogFrontiers();
  const createdAt = options.now ?? Date.now();
  const entry = {
    [VERSION.name]: name,
    [VERSION.frontiers]: encodeFrontiers(frontiers),
    [VERSION.createdAt]: createdAt,
    [VERSION.author]: doc.peerIdStr,
  };
  project.versions.push(entry);
  doc.commit({ message: `save version ${name}`, origin: META_ORIGIN });
  const index = project.versions.length - 1;
  return {
    index,
    id: entryId(project, index)!,
    name,
    frontiers,
    createdAt,
    author: doc.peerIdStr,
  };
}

function entryId(project: ProjectDoc, index: number): string | undefined {
  const id = project.versions.getIdAt(index);
  return id && `${id.counter}@${id.peer}`;
}

/**
 * Hides a named version for everyone. Only the name goes away: the edits it
 * pointed at stay in the history as a session.
 */
export function deleteVersion(
  project: ProjectDoc,
  version: Pick<NamedVersion, "id" | "name">,
  options: { now?: number } = {},
): void {
  project.deletedVersions.set(version.id, options.now ?? Date.now());
  project.doc.commit({
    message: `delete version ${version.name}`,
    origin: META_ORIGIN,
  });
}

/** Brings back a version deleted with deleteVersion, e.g. for "Undo". */
export function undeleteVersion(
  project: ProjectDoc,
  version: Pick<NamedVersion, "id" | "name">,
): void {
  project.deletedVersions.delete(version.id);
  project.doc.commit({
    message: `undelete version ${version.name}`,
    origin: META_ORIGIN,
  });
}

/** All well-formed named versions that are not deleted, oldest first. */
export function listVersions(project: ProjectDoc): NamedVersion[] {
  const out: NamedVersion[] = [];
  const deleted = project.deletedVersions;
  const values = project.versions.toArray();
  values.forEach((value, index) => {
    if (typeof value !== "object" || value === null) return;
    const id = entryId(project, index);
    if (id === undefined || deleted.get(id) !== undefined) return;
    const v = value as Record<string, unknown>;
    const name = v[VERSION.name];
    const bytes = v[VERSION.frontiers];
    const createdAt = v[VERSION.createdAt];
    const author = v[VERSION.author];
    if (
      typeof name !== "string" ||
      !(bytes instanceof Uint8Array) ||
      typeof createdAt !== "number" ||
      typeof author !== "string"
    ) {
      return;
    }
    let frontiers: OpId[];
    try {
      frontiers = decodeFrontiers(bytes);
    } catch {
      return;
    }
    out.push({
      index,
      id,
      name,
      frontiers,
      createdAt,
      author: author as PeerID,
    });
  });
  return out;
}
