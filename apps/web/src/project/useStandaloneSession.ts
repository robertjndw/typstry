import { LoroDoc } from "loro-crdt";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  localProjectAssets,
  type ProjectAssets,
} from "@/assets/project-assets";
import { isEditSecret } from "@/crypto/secret";
import { recordOpened, recordTitle } from "@/directory/record";
import {
  isForeignKind,
  isSchemaTooNew,
  migrate,
  NOT_A_PROJECT,
  ProjectDoc,
  TOO_NEW,
} from "@/doc/schema";
import { defaultBackend, LocalDocStore } from "@/persist/local-doc-store";

export type StandalonePhase =
  | { phase: "loading" }
  | { phase: "not-found" }
  | { phase: "error"; message: string }
  | { phase: "ready"; assets: ProjectAssets };

export interface StandaloneSession {
  state: StandalonePhase;
  project: ProjectDoc;
  /** Writes pending edits to this browser's store. */
  saveLocally: () => Promise<void>;
}

/**
 * Opens a project that only exists in this browser, with no server in the
 * picture: the doc comes from the local store and every edit goes back to
 * it. Mount it with the id as `key`, since the doc is tied to one project
 * for good. The doc outlives a StrictMode effect cycle; only the store
 * binding is re-created. `key` is the edit secret from the link, which the
 * project list keeps next to the id.
 */
export function useStandaloneSession(
  projectId: string,
  key = "",
): StandaloneSession {
  const [project] = useState(() => new ProjectDoc(new LoroDoc()));
  const storeRef = useRef<LocalDocStore | null>(null);
  const [state, setState] = useState<StandalonePhase>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    let store: LocalDocStore | null = null;
    void (async () => {
      try {
        const backend = await defaultBackend();
        store = new LocalDocStore(projectId, project.doc, backend);
        const found = await store.load();
        if (cancelled) return;
        storeRef.current = store;
        if (!found || project.schemaVersion === null) {
          setState({ phase: "not-found" });
          return;
        }
        if (isForeignKind(project)) {
          setState({ phase: "error", message: NOT_A_PROJECT });
          return;
        }
        if (isSchemaTooNew(project.schemaVersion)) {
          setState({ phase: "error", message: TOO_NEW });
          return;
        }
        migrate(project);
        store.start();
        setState({
          phase: "ready",
          assets: localProjectAssets(projectId, backend),
        });
      } catch (error) {
        console.error(error);
        if (!cancelled)
          setState({
            phase: "error",
            message: "Could not read the project from this browser.",
          });
      }
    })();
    return () => {
      cancelled = true;
      void store?.stop();
    };
  }, [projectId, project]);

  const ready = state.phase === "ready";
  useEffect(() => {
    if (!ready) return;
    // Opening is what moves a project to the top of the start page's list,
    // and it lists the project again if the list lost track of it.
    if (isEditSecret(key))
      void recordOpened(
        projectId,
        { token: projectId, secret: key, edit: true },
        project.title || "Untitled",
      );
    return project.meta.subscribe(
      () => void recordTitle(projectId, project.title || "Untitled"),
    );
  }, [ready, projectId, key, project]);

  const saveLocally = useCallback(
    () => storeRef.current?.flush() ?? Promise.resolve(),
    [],
  );

  return { state, project, saveLocally };
}
