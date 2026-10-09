import type { LoroDoc } from "loro-crdt";
import { useEffect, useState } from "react";

import {
  computeHistory,
  DEFAULT_GROUPING,
  type GroupingOptions,
  type HistoryEntry,
} from "@/doc/history";
import type { ProjectDoc } from "@/doc/schema";
import { listVersions, type NamedVersion } from "@/doc/versions";

export interface HistoryData {
  /** Oldest first. */
  entries: HistoryEntry[];
  versions: NamedVersion[];
}

interface CacheEntry {
  key: string;
  grouping: GroupingOptions;
  data: HistoryData;
}

// Reopening the panel without new changes costs nothing.
const cache = new WeakMap<LoroDoc, CacheEntry>();

function versionKey(doc: LoroDoc): string {
  return JSON.stringify(doc.oplogFrontiers());
}

export function loadHistory(
  project: ProjectDoc,
  grouping: GroupingOptions,
): HistoryData {
  const key = versionKey(project.doc);
  const hit = cache.get(project.doc);
  if (hit && hit.key === key && hit.grouping === grouping) return hit.data;
  const data = {
    entries: computeHistory(project, grouping),
    versions: listVersions(project),
  };
  // computeHistory commits pending ops first, so re-read the key.
  cache.set(project.doc, { key: versionKey(project.doc), grouping, data });
  return data;
}

/**
 * In dev, `?historyGap=<seconds>` shrinks the session gap (and the maximum
 * span to six times that) so grouping can be tried out without waiting five
 * minutes between edits.
 */
export function groupingFromLocation(
  search = typeof location === "undefined" ? "" : location.search,
): GroupingOptions {
  if (!import.meta.env.DEV) return DEFAULT_GROUPING;
  const gap = Number(new URLSearchParams(search).get("historyGap"));
  if (!Number.isFinite(gap) || gap <= 0) return DEFAULT_GROUPING;
  return { gapMs: gap * 1000, maxSpanMs: gap * 6000 };
}

const REFRESH_DELAY_MS = 1000;

type IdleHandle = { cancel: () => void };

function whenIdle(fn: () => void): IdleHandle {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout: 2000 });
    return { cancel: () => cancelIdleCallback(id) };
  }
  const id = setTimeout(fn, 0);
  return { cancel: () => clearTimeout(id) };
}

/**
 * History of `project` while `enabled` (the panel is open), else null.
 * Computed in an idle callback so opening the panel never blocks typing,
 * and refreshed a second after the doc stops changing.
 */
export function useHistory(
  project: ProjectDoc,
  enabled: boolean,
  grouping: GroupingOptions,
): HistoryData | null {
  const [data, setData] = useState<HistoryData | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let idle: IdleHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      idle?.cancel();
      idle = whenIdle(() => {
        idle = null;
        setData(loadHistory(project, grouping));
      });
    };
    run();
    const unsubscribe = project.doc.subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, REFRESH_DELAY_MS);
    });
    return () => {
      unsubscribe();
      idle?.cancel();
      if (timer !== null) clearTimeout(timer);
    };
  }, [project, enabled, grouping]);

  return enabled ? data : null;
}
