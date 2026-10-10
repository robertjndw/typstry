import { EphemeralStore, LoroDoc } from "loro-crdt";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { projectAssets, type ProjectAssets } from "@/assets/project-assets";
import {
  importProjectKey,
  isEditSecret,
  isProjectSecret,
  type ProjectKey,
} from "@/crypto/project-key";
import { ProjectDoc, SCHEMA_VERSION } from "@/doc/schema";
import { defaultBackend, LocalDocStore } from "@/persist/local-doc-store";
import { resolveShare, type ShareInfo } from "@/sync/api";
import {
  connectProject,
  type SyncNowResult,
  type SyncStatus,
} from "@/sync/connection";

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
      /** Holds the secrets share links are built from. */
      key: ProjectKey;
      /**
       * An edit token with only the view secret can reach the server but
       * not sign, so it is read-only too.
       */
      canWrite: boolean;
    };

export interface ProjectSession {
  state: SessionPhase;
  status: SyncStatus;
  project: ProjectDoc;
  ephemeral: EphemeralStore;
  /** Saves locally and pushes pending edits to the server right away. */
  syncNow: () => Promise<SyncNowResult>;
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
 * Imports the link's secret. A creator who opens their own view link (to
 * check what others see) keeps the edit secret this browser already holds,
 * instead of being downgraded to read-only for good.
 */
async function openKey(projectId: string, raw: string): Promise<ProjectKey> {
  const key = await importProjectKey(raw);
  if (key.sign) return key;
  const stored = loadProjectKey(projectId);
  if (!stored || !isEditSecret(stored)) return key;
  const editor = await importProjectKey(stored);
  return editor.viewSecret === key.viewSecret ? editor : key;
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
  const [projectKey, setProjectKey] = useState<ProjectKey | null>(null);
  const [loadedLocally, setLoadedLocally] = useState(false);
  const [synced, setSynced] = useState(false);
  const [slow, setSlow] = useState(false);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const syncRef = useRef<(() => Promise<SyncNowResult>) | null>(null);
  const schema = useSyncExternalStore(
    useCallback((onChange) => project.meta.subscribe(onChange), [project]),
    () => project.schemaVersion,
  );

  const key =
    linkKey && isProjectSecret(linkKey)
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
        openKey(share.projectId, key),
        defaultBackend(),
      ]);
      local = new LocalDocStore(share.projectId, project.doc, backend);
      const found = await local.load();
      if (!active) return;
      local.start();
      setAssets(projectAssets(token, projectKey));
      setProjectKey(projectKey);
      if (found) setLoadedLocally(true);

      const conn = connectProject({
        projectId: share.projectId,
        token,
        key: projectKey,
        canWrite: share.permission === "write" && projectKey.sign !== null,
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
      const store = local;
      syncRef.current = async () => {
        await store.flush();
        return conn.syncNow();
      };
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
      syncRef.current = null;
      close?.();
      void local?.stop();
    };
  }, [share, key, token, project, ephemeral]);

  const opened = synced || loadedLocally;

  useEffect(() => {
    if (!opened || !share || !projectKey || schema === null) return;
    // Only now is the key likely to fit, but local data is stored in plain
    // text, so loading it proves nothing about the key. A view key that
    // reaches this point did not match the stored edit secret (see openKey),
    // and letting it replace that secret would let any crafted link take
    // edit access away from this browser for good. The same goes for any
    // other key replacing a stored one: until the server's records decrypted
    // with it, it may just be a wrong link, and saving it would lose the
    // working key.
    const secret = projectKey.editSecret ?? projectKey.viewSecret;
    const stored = loadProjectKey(share.projectId);
    const proven = synced || stored === null || stored === secret;
    if (proven && (projectKey.editSecret || !stored || !isEditSecret(stored))) {
      saveProjectKey(share.projectId, secret);
    }
    rememberProject({
      projectId: share.projectId,
      token,
      title: project.title || "Untitled",
    });
  }, [opened, synced, share, projectKey, schema, token, project]);

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
  else if (!opened || !assets || !projectKey)
    state = { phase: "syncing", share, slow };
  else if (schema === null)
    state = synced
      ? { phase: "empty", share }
      : { phase: "syncing", share, slow };
  else
    state = {
      phase: "ready",
      share,
      assets,
      key: projectKey,
      canWrite: share.permission === "write" && projectKey.sign !== null,
    };

  const syncNow = useCallback(
    async (): Promise<SyncNowResult> =>
      (await syncRef.current?.()) ?? "offline",
    [],
  );

  return { state, status, project, ephemeral, syncNow };
}
