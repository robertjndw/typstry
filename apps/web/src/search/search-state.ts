import { useSyncExternalStore } from "react";

import { readJson, writeJson } from "@/lib/storage";

import type { SearchQuery } from "./search";

export interface SearchState extends SearchQuery {
  replacement: string;
  replaceOpen: boolean;
}

const OPTIONS_KEY = "typstry:search-options";

function loadOptions(): Pick<
  SearchQuery,
  "regex" | "caseSensitive" | "wholeWord"
> {
  const raw = readJson(OPTIONS_KEY);
  const o = typeof raw === "object" && raw !== null ? raw : {};
  const flag = (key: string) => (o as Record<string, unknown>)[key] === true;
  return {
    regex: flag("regex"),
    caseSensitive: flag("caseSensitive"),
    wholeWord: flag("wholeWord"),
  };
}

// The sidebar unmounts a panel when another tab is up, so the text lives
// here to survive switching tabs. Only the toggles are persisted: a stale
// pattern on the next visit would be more surprising than helpful.
let state: SearchState = {
  pattern: "",
  replacement: "",
  replaceOpen: false,
  ...loadOptions(),
};
const listeners = new Set<() => void>();

export function setSearchState(patch: Partial<SearchState>): void {
  state = { ...state, ...patch };
  const { regex, caseSensitive, wholeWord } = state;
  if ("regex" in patch || "caseSensitive" in patch || "wholeWord" in patch)
    writeJson(OPTIONS_KEY, { regex, caseSensitive, wholeWord });
  for (const listener of [...listeners]) listener();
}

export function useSearchState(): SearchState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** For tests, which share the module between cases. */
export function resetSearchState(): void {
  state = {
    pattern: "",
    replacement: "",
    replaceOpen: false,
    ...loadOptions(),
  };
  for (const listener of [...listeners]) listener();
}
