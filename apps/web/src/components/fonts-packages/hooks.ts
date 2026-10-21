import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { getText } from "@/doc/fs-ops";
import type { PackageRecord } from "@/doc/schema";
import type { FontBundleId } from "@/fonts/builtin";
import { setFontBundle } from "@/packages/records";
import { findPreviewImports, type PreviewImport } from "@/packages/universe";
import { useProject } from "@/project/context";
import { projectIndex } from "@/project/project-index";

function useIndex() {
  const { project } = useProject();
  const index = projectIndex(project);
  const subscribe = useCallback(
    (notify: () => void) => index.subscribe(() => notify()),
    [index],
  );
  return { project, index, subscribe };
}

/** The project's packages, sorted by name; follows edits from collaborators. */
export function usePackages(): PackageRecord[] {
  const { index, subscribe } = useIndex();
  // The index keeps this map's identity until a record actually changes.
  const records = useSyncExternalStore(subscribe, () => index.state.packages);
  return useMemo(
    () =>
      [...records.values()].sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          a.namespace.localeCompare(b.namespace) ||
          a.version.localeCompare(b.version, undefined, { numeric: true }),
      ),
    [records],
  );
}

export interface FontBundles {
  cjk: boolean;
  emoji: boolean;
  set: (bundle: FontBundleId, on: boolean) => void;
}

export function useFontBundles(): FontBundles {
  const { project, index, subscribe } = useIndex();
  const wanted = useSyncExternalStore(subscribe, () => index.state.fontAssets);
  const cjk = wanted.includes("cjk");
  const emoji = wanted.includes("emoji");
  const set = useCallback(
    (bundle: FontBundleId, on: boolean) => setFontBundle(project, bundle, on),
    [project],
  );
  return useMemo(() => ({ cjk, emoji, set }), [cjk, emoji, set]);
}

function sameImports(a: PreviewImport[], b: PreviewImport[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, i) =>
        item.spec === b[i]!.spec &&
        item.paths.join("\n") === b[i]!.paths.join("\n"),
    )
  );
}

/**
 * `@preview` packages the project's sources mention. Text edits do not
 * change the index state, so the scan reruns on a short debounce instead of
 * on every keystroke of a collaborator typing.
 */
export function useUsedPreviewImports(): PreviewImport[] {
  const { project, index } = useIndex();
  const scan = useCallback(() => {
    const texts: { path: string; text: string }[] = [];
    for (const { id, path } of index.state.texts.values()) {
      try {
        texts.push({ path, text: getText(project, id).toString() });
      } catch {
        // The content container has not arrived yet; the next batch retries.
      }
    }
    return findPreviewImports(texts);
  }, [project, index]);
  const [found, setFound] = useState(scan);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () =>
      setFound((prev) => {
        const next = scan();
        return sameImports(prev, next) ? prev : next;
      });
    const off = index.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    });
    refresh();
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [index, scan]);

  return found;
}
