import { useSyncExternalStore } from "react";

import { getStorage, readJson, writeJson } from "@/lib/storage";

const KEY = "typstry:line-wrapping";

// Shared by the menu that flips it and the editor that follows it, which sit
// far apart in the tree. Per browser, like the layout, not per project.
let wrapping = readJson(KEY) === true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function setLineWrapping(next: boolean): void {
  if (next === wrapping) return;
  wrapping = next;
  writeJson(KEY, next);
  for (const listener of [...listeners]) listener();
}

/** Whether long lines wrap in the editor, and a way to change it. */
export function useLineWrapping(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => wrapping,
    () => false,
  );
  return [value, setLineWrapping];
}

/** For tests, which share the module between cases. */
export function resetLineWrapping(): void {
  wrapping = readJson(KEY, getStorage()) === true;
  for (const listener of [...listeners]) listener();
}
