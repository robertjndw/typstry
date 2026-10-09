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
  return {
    index: project.versions.length - 1,
    name,
    frontiers,
    createdAt,
    author: doc.peerIdStr,
  };
}

/** All well-formed named versions, oldest first. */
export function listVersions(project: ProjectDoc): NamedVersion[] {
  const out: NamedVersion[] = [];
  const values = project.versions.toArray();
  values.forEach((value, index) => {
    if (typeof value !== "object" || value === null) return;
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
    out.push({ index, name, frontiers, createdAt, author: author as PeerID });
  });
  return out;
}
