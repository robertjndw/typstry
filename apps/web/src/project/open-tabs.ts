import type { TreeID } from "loro-crdt";

import { readJson, writeJson } from "@/lib/storage";

// Per browser rather than in the doc: which files someone has open is
// theirs, and collaborators would otherwise fight over it.
const PREFIX = "typstry:tabs:";

export interface OpenTabs {
  tabs: readonly TreeID[];
  open: TreeID | null;
}

const isTreeId = (value: unknown): value is TreeID =>
  typeof value === "string" && /^\d+@\d+$/.test(value);

export function loadOpenTabs(
  projectId: string,
  storage?: Storage | null,
): OpenTabs | null {
  const value = readJson(PREFIX + projectId, storage) as {
    tabs?: unknown;
    open?: unknown;
  } | null;
  if (typeof value !== "object" || value === null) return null;
  const { tabs, open } = value;
  if (!Array.isArray(tabs) || !tabs.every(isTreeId)) return null;
  if (open !== null && !isTreeId(open)) return null;
  return { tabs, open };
}

export function saveOpenTabs(
  projectId: string,
  value: OpenTabs,
  storage?: Storage | null,
): void {
  writeJson(PREFIX + projectId, value, storage);
}
