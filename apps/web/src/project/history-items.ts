import type { OpId, PeerID } from "loro-crdt";

import type { ProjectDoc } from "@/doc/schema";
import type { NamedVersion } from "@/doc/versions";

import type { HistoryData } from "./useHistory";

/** A point in history that can be opened in the version view. */
export interface VersionTarget {
  key: string;
  label: string;
  /** Unix ms, null when unknown. */
  time: number | null;
  frontiers: OpId[];
  /** The version to compare against, null when there is nothing before. */
  previous: OpId[] | null;
}

/** One edit session, with the tags that point at it. */
export interface HistoryItem {
  target: VersionTarget;
  authors: PeerID[];
  detail: string;
  /** Oldest first. */
  tags: NamedVersion[];
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absolute = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Infinity],
];

/** Date and time in the user's locale. */
export function formatAbsolute(time: number): string {
  return absolute.format(time);
}

export function formatRelative(time: number, now = Date.now()): string {
  let value = (time - now) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) {
      if (unit === "second") return "just now";
      return relative.format(Math.round(value), unit);
    }
    value /= size;
  }
  return absolute.format(time);
}

export function buildHistoryItems(
  project: ProjectDoc,
  data: HistoryData,
): HistoryItem[] {
  const { entries, versions } = data;
  // Tags split sessions where they can (see groupChanges), so a tag usually
  // matches a session's end exactly. Otherwise, e.g. a tag taken while
  // another peer's concurrent edits were not synced yet, it goes to the
  // first session that contains it.
  const tagsAt = new Map<number, NamedVersion[]>();
  for (const version of versions) {
    const i = entries.findIndex((entry) => {
      try {
        const cmp = project.doc.cmpFrontiers(
          entry.frontiers,
          version.frontiers,
        );
        return cmp === 0 || cmp === 1;
      } catch {
        return false; // frontiers this doc never saw
      }
    });
    if (i === -1) continue;
    const list = tagsAt.get(i) ?? [];
    list.push(version);
    tagsAt.set(i, list);
  }

  const items: HistoryItem[] = entries.map((entry, i) => {
    const files = entry.files.length;
    const tags = tagsAt.get(i) ?? [];
    const time = entry.end !== null ? absolute.format(entry.end) : null;
    return {
      authors: entry.authors,
      detail:
        files === 0
          ? "No file changes"
          : `${files} ${files === 1 ? "file" : "files"} edited`,
      tags,
      target: {
        key: `g:${entry.id}`,
        // What the version view and file names call it.
        label:
          tags.length > 0
            ? tags.map((t) => t.name).join(", ")
            : (time ?? "Unknown time"),
        time: entry.end,
        frontiers: entry.frontiers,
        previous: i > 0 ? entries[i - 1]!.frontiers : null,
      },
    };
  });
  return items.reverse();
}

/** Finds the group member that signed what a peer wrote. */
export type RosterLookup = (
  peer: string,
) => { name: string; color: string; signer: string } | null;

export interface AuthorIdentity {
  key: string;
  name: string;
  color: string;
}

const UNKNOWN = { name: "Unknown", color: "#71717a" };

/**
 * How one peer is shown. A peer whose records the group's roster vouches
 * for (`memberOfPeer`, from the signers of its decrypted records) appears
 * under the member's signed name; anyone else under the name the peer wrote
 * into the doc, which is only a claim, or else `fallback`.
 *
 * Every page load is a new Loro peer, so one person shows up under several
 * peer ids. The key collapses a member by its signer, the rest by what they
 * look like.
 */
export function authorIdentity(
  project: ProjectDoc,
  peer: string,
  memberOfPeer?: RosterLookup,
  fallback: { name: string; color: string } = UNKNOWN,
): AuthorIdentity {
  const member = memberOfPeer?.(peer);
  if (member) {
    return {
      key: `member:${member.signer}`,
      name: member.name,
      color: member.color,
    };
  }
  const info = project.getPeer(peer) ?? fallback;
  return { key: `${info.name}\u0000${info.color}`, ...info };
}

/** Who wrote what, for the avatars: authorIdentity without duplicates. */
export function authorIdentities(
  project: ProjectDoc,
  peers: PeerID[],
  memberOfPeer?: RosterLookup,
): AuthorIdentity[] {
  const seen = new Map<string, AuthorIdentity>();
  for (const peer of peers) {
    const identity = authorIdentity(project, peer, memberOfPeer);
    if (!seen.has(identity.key)) seen.set(identity.key, identity);
  }
  return [...seen.values()];
}
