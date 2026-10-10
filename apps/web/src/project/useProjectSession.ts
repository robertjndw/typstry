import { EphemeralStore, LoroDoc } from "loro-crdt";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { projectAssets, type ProjectAssets } from "@/assets/project-assets";
import { importProjectKey, isRawProjectKey } from "@/crypto/project-key";
import { ProjectDoc, SCHEMA_VERSION } from "@/doc/schema";
import { defaultBackend, LocalDocStore } from "@/persist/local-doc-store";
import { resolveShare, type ShareInfo } from "@/sync/api";
import { connectProject, type SyncStatus } from "@/sync/connection";

import {
  forgetShare,
  loadProjectKey,
  loadShare,
  rememberProject,
  rememberShare,
  saveProjectKey,
  updateRecentTitle,
} from "./recent";

/** Matches the server's presence timeout. */
export const EPHEMERAL_TIMEOUT_MS = 30_000;
const SLOW_SYNC_MS = 15_000;

export type SessionPhase =
  | { phase: "resolving" }
  | { phase: "not-found" }
  /** The link lacks its `#key` and this browser never saw the project. */
  | { phase: "missing-key" }
  /** Synced, but nobody has uploaded the project's first version yet. */
  | { phase: "empty"; share: ShareInfo }
  | { phase: "error"; message: string }
  | { phase: "syncing"; share: ShareInfo; slow: boolean }
  | {
      phase: "ready";
      share: ShareInfo;
      assets: ProjectAssets;
      /** The raw key, for building share links. */
      key: string;
    };

export interface ProjectSession {
  state: SessionPhase;
  status: SyncStatus;
  project: ProjectDoc;
  ephemeral: EphemeralStore;
}

const WRONG_KEY =
  "This link's key does not match the project. Check that the link was copied completely, including the part after #.";
const TOO_NEW =
  "This project was saved by a newer version of typstry. Reload the page to update.";

function sameShare(a: ShareInfo | null | undefined, b: ShareInfo | null) {
  if (!a || !b) return a === b;
  return (
    a.projectId === b.projectId &&
    a.permission === b.permission &&
    a.viewToken === b.viewToken
  );
}

/**
 * Opens a project from a share token and the key from the link fragment,
 * keeps it synced and saved in this browser while mounted. A project this
 * browser has opened before opens from local storage right away, without
 * the server. Mount it under a `key` of the token: the doc belongs to one
 * project for good. The doc and store outlive a StrictMode effect cycle;
 * only the socket and the local store binding are re-created.
 */
export function useProjectSession(
  token: string,
  linkKey: string | null,
): ProjectSession {
  const [resources] = useState(() => ({
    project: new ProjectDoc(new LoroDoc()),
    ephemeral: new EphemeralStore(EPHEMERAL_TIMEOUT_MS),
  }));
  const { project, ephemeral } = resources;
  const [share, setShare] = useState<ShareInfo | null | undefined>(
    () => loadShare(token) ?? undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<ProjectAssets | null>(null);
  const [loadedLocally, setLoadedLocally] = useState(false);
  const [synced, setSynced] = useState(false);
  const [slow, setSlow] = useState(false);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const schema = useSyncExternalStore(
    useCallback((onChange) => project.meta.subscribe(onChange), [project]),
    () => project.schemaVersion,
  );

  const key =
    linkKey && isRawProjectKey(linkKey)
      ? linkKey
      : share
        ? loadProjectKey(share.projectId)
        : null;

  useEffect(() => {
    const abort = new AbortController();
    const cached = loadShare(token);
    resolveShare(token, { signal: abort.signal }).then(
      (info) => {
        if (info) rememberShare(token, info);
        else forgetShare(token);
        setShare((prev) => (sameShare(prev, info) ? prev : info));
      },
      (err) => {
        if (abort.signal.aborted) return;
        // Offline with a project seen before: carry on from local data.
        if (cached) return;
        console.error(err);
        setError("The server could not be reached.");
      },
    );
    return () => abort.abort();
  }, [token]);

  useEffect(() => {
    if (!share || !key) return;
    let active = true;
    let local: LocalDocStore | null = null;
    let close: (() => void) | null = null;

    (async () => {
      const [projectKey, backend] = await Promise.all([
        importProjectKey(key),
        defaultBackend(),
      ]);
      local = new LocalDocStore(share.projectId, project.doc, backend);
      const found = await local.load();
      if (!active) return;
      local.start();
      setAssets(projectAssets(token, projectKey));
      if (found) setLoadedLocally(true);

      const conn = connectProject({
        projectId: share.projectId,
        token,
        key: projectKey,
        canWrite: share.permission === "write",
        doc: project.doc,
        ephemeral,
        // A StrictMode remount closes the first socket mid-join; that is noise.
        onError: (err) => {
          if (active) console.warn("sync:", err);
        },
        onDecryptError: (err) => {
          console.error(err);
          if (active) setError(WRONG_KEY);
        },
      });
      const stopStatus = conn.subscribe((s) => setStatus(s));
      const slowTimer = setTimeout(() => setSlow(true), SLOW_SYNC_MS);
      conn.synced.then(
        () => {
          clearTimeout(slowTimer);
          if (active) setSynced(true);
        },
        (err: unknown) => {
          console.error(err);
          if (active) setError("The server refused to open this project.");
        },
      );
      close = () => {
        clearTimeout(slowTimer);
        stopStatus();
        conn.close();
      };
    })().catch((err: unknown) => {
      console.error(err);
      if (active) setError("This project could not be opened.");
    });

    return () => {
      active = false;
      close?.();
      void local?.stop();
    };
  }, [share, key, token, project, ephemeral]);

  const opened = synced || loadedLocally;

  useEffect(() => {
    if (!opened || !share || !key || schema === null) return;
    // Only now is the key known to fit: local data was written with it, or
    // the server's data decrypted.
    saveProjectKey(share.projectId, key);
    rememberProject({
      projectId: share.projectId,
      token,
      title: project.title || "Untitled",
    });
  }, [opened, share, key, schema, token, project]);

  useEffect(() => {
    if (!opened || !share) return;
    return project.meta.subscribe(() =>
      updateRecentTitle(share.projectId, project.title || "Untitled"),
    );
  }, [opened, share, project]);

  let state: SessionPhase;
  if (error) state = { phase: "error", message: error };
  else if (schema !== null && schema > SCHEMA_VERSION)
    state = { phase: "error", message: TOO_NEW };
  else if (share === undefined) state = { phase: "resolving" };
  else if (share === null) state = { phase: "not-found" };
  else if (!key) state = { phase: "missing-key" };
  else if (!opened || !assets) state = { phase: "syncing", share, slow };
  else if (schema === null)
    state = synced
      ? { phase: "empty", share }
      : { phase: "syncing", share, slow };
  else state = { phase: "ready", share, assets, key };

  return { state, status, project, ephemeral };
}
