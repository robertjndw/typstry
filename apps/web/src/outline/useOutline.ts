import type { TreeID } from "loro-crdt";
import { useEffect, useState } from "react";

import { fileCategory } from "@/assets/file-types";
import { getText } from "@/doc/fs-ops";
import type { ProjectDoc } from "@/doc/schema";
import { useProject } from "@/project/context";
import { projectIndex } from "@/project/project-index";

import { extractOutline, type OutlineItem } from "./extract";
import {
  buildProjectOutline,
  type ProjectOutline,
  type ProjectOutlineItem,
} from "./project-outline";

const DEBOUNCE_MS = 200;
const EMPTY: ProjectOutline = { items: [], files: new Set() };

/**
 * The outline of the compiled document: the main file, or the open file
 * when the project has no usable main file, with includes expanded.
 */
export function useOutline(): {
  items: ProjectOutlineItem[];
  /** False when there is no .typ file to start from. */
  hasRoot: boolean;
} {
  const { project, mainFile, openFileId } = useProject();
  const [outline, setOutline] = useState<ProjectOutline | null>(null);

  useEffect(() => {
    const index = projectIndex(project);
    // Parsing the same text again is the expensive part of a rebuild, and
    // most rebuilds are caused by an edit in just one of the files.
    const parsed = new Map<string, { text: string; items: OutlineItem[] }>();
    const extract = (path: string, text: string) => {
      const hit = parsed.get(path);
      if (hit?.text === text) return hit.items;
      const items = extractOutline(text);
      parsed.set(path, { text, items });
      return items;
    };

    let files: ReadonlySet<TreeID> = new Set();
    const compute = () => {
      const { paths } = index.state;
      const rootPath = [mainFile, openFileId]
        .map((id) => (id ? paths.byId.get(id) : undefined))
        .find(
          (e) => e?.kind === "text" && fileCategory(e.path) === "typst",
        )?.path;
      const next = rootPath
        ? buildProjectOutline(
            rootPath,
            (path) => readText(project, paths.byPath.get(path)),
            extract,
          )
        : EMPTY;
      files = next.files;
      setOutline(next);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = index.subscribe((change) => {
      // Edits to files outside the include graph cannot change the outline.
      if (
        !change.structural &&
        !change.mainChanged &&
        ![...change.edited].some((id) => files.has(id))
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(compute, DEBOUNCE_MS);
    });
    compute();
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [project, mainFile, openFileId]);

  // Until the first computation, assume a root so the panel does not flash
  // its "no main file" notice.
  return { items: outline?.items ?? EMPTY.items, hasRoot: outline !== EMPTY };
}

function readText(project: ProjectDoc, id: TreeID | undefined) {
  if (!id) return null;
  try {
    return { fileId: id, text: getText(project, id).toString() };
  } catch {
    return null; // an asset, or a text whose content has not arrived yet
  }
}
