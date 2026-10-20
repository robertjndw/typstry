import type { TreeID } from "loro-crdt";
import { useEffect, useRef, useState } from "react";

import { getText } from "@/doc/fs-ops";
import type { ProjectDoc } from "@/doc/schema";
import { projectIndex } from "@/project/project-index";

import {
  searchProject,
  type SearchInput,
  type SearchQuery,
  type SearchResult,
} from "./search";

const DEBOUNCE_MS = 150;

/**
 * Searches every text file of `project` and keeps the result current while
 * collaborators or the user edit. `result` is null until the first run.
 */
export function useProjectSearch(
  project: ProjectDoc,
  query: SearchQuery,
): { result: SearchResult | null; searching: boolean } {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const { pattern, regex, caseSensitive, wholeWord } = query;
  // The project effect below outlives query changes, so its string cache
  // survives typing; it reads the query and is poked through these refs.
  const queryRef = useRef<SearchQuery>(query);
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const index = projectIndex(project);
    // toString() on a large text is not free, so only edited files are
    // re-read; a rename or removal rebuilds the entry from the index.
    const strings = new Map<TreeID, { container: string; text: string }>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      timer = undefined;
      const files: SearchInput[] = [];
      const live = new Set<TreeID>();
      for (const entry of index.state.texts.values()) {
        live.add(entry.id);
        let cached = strings.get(entry.id);
        if (cached?.container !== entry.container) {
          try {
            cached = {
              container: entry.container,
              text: getText(project, entry.id).toString(),
            };
          } catch {
            continue; // deleted between the index and now
          }
          strings.set(entry.id, cached);
        }
        files.push({ fileId: entry.id, path: entry.path, text: cached.text });
      }
      for (const id of strings.keys()) if (!live.has(id)) strings.delete(id);
      setResult(searchProject(files, queryRef.current));
      setSearching(false);
    };
    const schedule = () => {
      setSearching(true);
      clearTimeout(timer);
      timer = setTimeout(run, DEBOUNCE_MS);
    };

    const unsubscribe = index.subscribe((change) => {
      for (const id of change.edited) strings.delete(id);
      // Edits to a file with no match and no stale entry still need a run:
      // they can create the first match.
      if (change.edited.size > 0 || change.structural) schedule();
    });
    scheduleRef.current = schedule;
    schedule();
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [project]);

  useEffect(() => {
    queryRef.current = { pattern, regex, caseSensitive, wholeWord };
    scheduleRef.current();
  }, [pattern, regex, caseSensitive, wholeWord]);

  return { result, searching };
}
