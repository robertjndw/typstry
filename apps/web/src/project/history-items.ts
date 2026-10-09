import type { OpId, PeerID } from "loro-crdt";

import type { ProjectDoc } from "@/doc/schema";

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

export interface HistoryItem {
  target: VersionTarget;
  kind: "session" | "named";
  authors: PeerID[];
  detail: string;
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
  const items: HistoryItem[] = entries.map((entry, i) => {
    const files = entry.files.length;
    return {
      kind: "session",
      authors: entry.authors,
      detail:
        files === 0
          ? "No file changes"
          : `${files} ${files === 1 ? "file" : "files"} edited`,
      target: {
        key: `g:${entry.id}`,
        label: entry.end !== null ? absolute.format(entry.end) : "Unknown time",
        time: entry.end,
        frontiers: entry.frontiers,
        previous: i > 0 ? entries[i - 1]!.frontiers : null,
      },
    };
  });
  for (const version of versions) {
    // Compare against the latest session that lies strictly before it.
    let previous: OpId[] | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (
        project.doc.cmpFrontiers(entries[i]!.frontiers, version.frontiers) ===
        -1
      ) {
        previous = entries[i]!.frontiers;
        break;
      }
    }
    items.push({
      kind: "named",
      authors: [version.author],
      detail: "Named version",
      target: {
        key: `v:${version.index}`,
        label: version.name,
        time: version.createdAt,
        frontiers: version.frontiers,
        previous,
      },
    });
  }
  // Newest first; a named version sorts above the session it names.
  return items.sort(
    (a, b) =>
      (b.target.time ?? 0) - (a.target.time ?? 0) ||
      (a.kind === "named" ? -1 : 0) - (b.kind === "named" ? -1 : 0),
  );
}
