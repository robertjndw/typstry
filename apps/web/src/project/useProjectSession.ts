import { EphemeralStore, LoroDoc } from "loro-crdt";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { projectAssets, type ProjectAssets } from "@/assets/project-assets";
import {
  CryptoError,
  NewerVersionError,
  ProjectCrypto,
  viewSecretOf,
} from "@/crypto/project-crypto";
import { isEditSecret, secretKind } from "@/crypto/secret";
import { loadWasm } from "@/crypto/wasm";
import { isSchemaTooNew, migrate, ProjectDoc } from "@/doc/schema";
import { localIdentity, mergeOwnGraph } from "@/mls/identity";
import { MlsSession, type GroupKeys } from "@/mls/session";
import { useMlsSnapshot } from "@/mls/useMlsSnapshot";
import { defaultBackend, LocalDocStore } from "@/persist/local-doc-store";
import {
  loadIdentity,
  provisionalIdentity,
  type Identity,
} from "@/presence/identity";
import {
  ApiError,
  fetchMlsBootstrap,
  OutdatedClientError,
  resolveShare,
  type ShareInfo,
} from "@/sync/api";
import {
  connectProject,
  type SyncNowResult,
  type SyncStatus,
} from "@/sync/connection";
import { RELOAD_MESSAGE } from "@/sync/protocol";

import {
  keepRotation,
  forgetShare,
  loadKeyring,
  loadProjectKey,
  loadShare,
  rememberProject,
  rememberShare,
  saveKeyring,
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
  /** The group removed this device. Its links stopped working. */
  | { phase: "removed" }
  | { phase: "syncing"; share: ShareInfo; slow: boolean }
  | {
      phase: "ready";
      share: ShareInfo;
      assets: ProjectAssets;
      /** Holds the secrets share links are built from. */
      crypto: ProjectCrypto;
      /**
       * An edit token with only the view secret can reach the server but
       * not sign, so it is read-only too.
       */
      canWrite: boolean;
    };

/** The links the project moved to; the page should open them. */
export interface FollowedLinks {
  token: string;
  /** The secret for the URL fragment. */
  link: string;
}

export interface ProjectSession {
  state: SessionPhase;
  status: SyncStatus;
  project: ProjectDoc;
  ephemeral: EphemeralStore;
  /** The project's member group; null until the share is known. */
  mls: MlsSession | null;
  /** Set after a rotation: navigate to these, keeping the session. */
  following: FollowedLinks | null;
  /** Saves locally and pushes pending edits to the server right away. */
  syncNow: () => Promise<SyncNowResult>;
}

const WRONG_KEY =
  "This link's key does not match the project. Check that the link was copied completely, including the part after #.";
const TOO_NEW =
  "This project was saved by a newer version of typstry. Reload the page to update.";
const NO_KEYS =
  "The server has no encryption keys for this project, so it cannot be opened.";
const LINK_REPLACED =
  "This link was replaced, and this browser has no way to find the new one. Ask someone in the project for the current link.";

function sameShare(a: ShareInfo | null | undefined, b: ShareInfo | null) {
  if (!a || !b) return a === b;
  return (
    a.projectId === b.projectId &&
    a.permission === b.permission &&
    a.viewToken === b.viewToken &&
    a.retired === b.retired
  );
}

/** What to tell the user when the project's keys would not open. */
function openError(error: unknown): string {
  if (error instanceof NewerVersionError) return TOO_NEW;
  if (error instanceof NoKeyringError) return NO_KEYS;
  if (error instanceof ApiError) return "This project could not be opened.";
  // A link of another project fails the keyring's signature check or its
  // key match; anything else typed is this family too.
  if (error instanceof CryptoError) return WRONG_KEY;
  return "This project could not be opened.";
}

/** The server holds no group, and so no keyring, for the project. */
class NoKeyringError extends Error {
  constructor() {
    super(NO_KEYS);
    this.name = "NoKeyringError";
  }
}

/**
 * Opens the project's keys from the link's secret and the sealed keyring the
 * server stores (or the copy this browser kept, so a project opens offline).
 * A creator who opens their own view link (to check what others see) keeps
 * the edit secret this browser already holds, instead of being downgraded to
 * read-only for good.
 */
async function openCrypto(
  token: string,
  projectId: string,
  raw: string,
): Promise<ProjectCrypto> {
  await loadWasm();
  let secret = raw;
  if (secretKind(raw) === "view") {
    const stored = loadProjectKey(projectId);
    if (
      stored &&
      isEditSecret(stored) &&
      viewSecretOf(stored) === viewSecretOf(raw)
    )
      secret = stored;
  }
  const cached = loadKeyring(projectId);
  if (cached) {
    try {
      return ProjectCrypto.open(secret, cached);
    } catch (error) {
      // A copy from before a rotation, say; the server's is checked next.
      if (error instanceof NewerVersionError) throw error;
    }
  }
  const bootstrap = await fetchMlsBootstrap(token);
  if (!bootstrap) throw new NoKeyringError();
  const crypto = ProjectCrypto.open(secret, bootstrap.keyring);
  saveKeyring(projectId, bootstrap.keyring);
  return crypto;
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
  opts: { identity?: Identity } = {},
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
  const [crypto, setCrypto] = useState<ProjectCrypto | null>(null);
  const [loadedLocally, setLoadedLocally] = useState(false);
  const [synced, setSynced] = useState(false);
  const [slow, setSlow] = useState(false);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [followed, setFollowed] = useState<FollowedLinks | null>(null);
  /** A rotation happened here, so the next connection uploads a snapshot. */
  const rotatedRef = useRef(false);
  const [fallbackIdentity] = useState(
    () => loadIdentity() ?? provisionalIdentity(),
  );
  const identity = opts.identity ?? fallbackIdentity;
  const identityRef = useRef(identity);
  const syncRef = useRef<(() => Promise<SyncNowResult>) | null>(null);
  const schema = useSyncExternalStore(
    useCallback((onChange) => project.meta.subscribe(onChange), [project]),
    () => project.schemaVersion,
  );

  const key =
    // A newer kind of secret goes through too, so importing it can say why
    // it does not open.
    linkKey && secretKind(linkKey)
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
        // Local data would open, but the socket is refused just the same,
        // so working on would only pile up edits that never sync.
        if (err instanceof OutdatedClientError) {
          setError(RELOAD_MESSAGE);
          return;
        }
        // Offline with a project seen before: carry on from local data.
        if (cached) return;
        console.error(err);
        setError("The server could not be reached.");
      },
    );
    return () => abort.abort();
  }, [token]);

  const projectId = share?.projectId;
  const permission = share?.permission;
  const retired = share?.retired === true;
  const title = project.title;
  const titleRef = useRef(title);

  useEffect(() => {
    identityRef.current = identity;
    titleRef.current = title;
  });

  // Holds no resources until `start`, so building it during render is safe
  // (and a discarded StrictMode copy costs nothing).
  const mls = useMemo(() => {
    if (!projectId) return null;
    return new MlsSession({
      projectId,
      backend: {
        loadMls: async (id) => (await defaultBackend()).loadMls(id),
        saveMls: async (id, record) =>
          (await defaultBackend()).saveMls(id, record),
      },
      fetchBootstrap: (t) => fetchMlsBootstrap(t),
      identity: () => identityRef.current,
      localIdentity: async () => localIdentity(await defaultBackend()),
      mergeGraph: async (graph) => mergeOwnGraph(await defaultBackend(), graph),
      // Keep the new links before anything else: they are the only way
      // back into the project, and nothing else holds them.
      onRotated: (rotation) => {
        keepRotation(projectId, rotation, titleRef.current);
        rotatedRef.current = true;
        setFollowed({ token: rotation.token, link: rotation.link });
      },
      onKeyring: (keyring) => saveKeyring(projectId, keyring),
      onError: (err) => console.warn("group:", err),
    });
  }, [projectId]);
  const mlsRef = useRef(mls);
  useEffect(() => {
    mlsRef.current = mls;
  }, [mls]);

  useEffect(() => () => mls?.stop(), [mls]);

  useEffect(() => {
    if (!mls || !key) return;
    let active = true;
    loadWasm()
      .then(() => (active ? mls.start({ token, link: key }) : undefined))
      .catch((err: unknown) => console.warn("group:", err));
    return () => {
      active = false;
    };
  }, [mls, token, key]);

  // Records, presence and blobs use the group's keys from the moment it is
  // joined, and again after every epoch and rotation.
  useEffect(() => {
    if (!mls || !crypto) return;
    const apply = (keys: GroupKeys) => {
      crypto.setGroupKeys(keys.docKeys, keys.signer, keys.presenceKey);
    };
    const now = mls.keys();
    if (now) apply(now);
    return mls.onKeys(apply);
  }, [mls, crypto]);

  useEffect(() => {
    mls?.updateProfile();
  }, [mls, identity.name, identity.color]);

  const mlsSnapshot = useMlsSnapshot(mls);

  useEffect(() => {
    if (!projectId || !permission || !key) return;
    let active = true;
    // Stopping the connection fails the pending join too, which must not
    // replace the reload message with a vaguer one.
    let outdated = false;
    let local: LocalDocStore | null = null;
    let close: (() => void) | null = null;

    (async () => {
      const [projectCrypto, backend] = await Promise.all([
        openCrypto(token, projectId, key),
        defaultBackend(),
      ]);
      local = new LocalDocStore(projectId, project.doc, backend);
      const found = await local.load();
      if (!active) return;
      local.start();
      setAssets(projectAssets(token, projectCrypto));
      setCrypto(projectCrypto);
      if (found) setLoadedLocally(true);

      // The server refuses a replaced token, so there is nothing to sync;
      // the local copy stays open while the group looks for the new links.
      if (retired) return;

      const compactOnJoin = rotatedRef.current;
      rotatedRef.current = false;
      const conn = connectProject({
        projectId,
        token,
        crypto: projectCrypto,
        canWrite: permission === "write" && projectCrypto.canWrite,
        compactOnJoin: compactOnJoin && permission === "write",
        doc: project.doc,
        ephemeral,
        // A StrictMode remount closes the first socket mid-join; that is noise.
        onError: (err) => {
          if (active) console.warn("sync:", err);
        },
        onDecryptError: (err) => {
          console.error(err);
          if (active)
            setError(err instanceof NewerVersionError ? TOO_NEW : WRONG_KEY);
        },
        // The group rotated; its new links are what open these records.
        onUnknownGeneration: () => mlsRef.current?.catchUp(),
        checkRetired: async () => (await resolveShare(token))?.retired === true,
        onRetired: () => mlsRef.current?.catchUp(),
        onOutdated: () => {
          outdated = true;
          if (active) setError(RELOAD_MESSAGE);
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
          if (active && !outdated)
            setError("The server refused to open this project.");
        },
      );
      close = () => {
        clearTimeout(slowTimer);
        stopStatus();
        conn.close();
      };
    })().catch((err: unknown) => {
      console.error(err);
      // A replaced token has no keyring to fetch; the notice about the
      // replaced link says it better.
      if (active && !(retired && err instanceof NoKeyringError))
        setError(openError(err));
    });

    return () => {
      active = false;
      syncRef.current = null;
      close?.();
      void local?.stop();
    };
  }, [projectId, permission, retired, key, token, project, ephemeral]);

  const opened = synced || loadedLocally;

  useEffect(() => {
    if (!opened || !share || !crypto || schema === null) return;
    // Still the keys of the link before a rotation: saving their secret
    // would put the old key over the new one that was just kept.
    if (key && !crypto.matches(key)) return;
    // Only now is the key likely to fit, but local data is stored in plain
    // text, so loading it proves nothing about the key. A view key that
    // reaches this point did not match the stored edit secret (see
    // openCrypto), and letting it replace that secret would let any crafted
    // link take edit access away from this browser for good. The same goes
    // for any other key replacing a stored one: until the server's records
    // decrypted with it, it may just be a wrong link, and saving it would
    // lose the working key.
    const secret = crypto.editSecret ?? crypto.viewSecret;
    const stored = loadProjectKey(share.projectId);
    const proven = synced || stored === null || stored === secret;
    if (proven && (crypto.editSecret || !stored || !isEditSecret(stored))) {
      saveProjectKey(share.projectId, secret);
    }
    rememberProject({
      projectId: share.projectId,
      token,
      title: project.title || "Untitled",
    });
  }, [opened, synced, share, crypto, schema, token, project, key]);

  useEffect(() => {
    if (!opened || !share) return;
    return project.meta.subscribe(() =>
      updateRecentTitle(share.projectId, project.title || "Untitled"),
    );
  }, [opened, share, project]);

  let state: SessionPhase;
  // Before the error: a removed device's sockets are refused, which would
  // otherwise read as the server failing.
  if (mlsSnapshot.phase === "removed") state = { phase: "removed" };
  else if (error) state = { phase: "error", message: error };
  else if (
    mlsSnapshot.phase === "lost" ||
    (retired && mlsSnapshot.phase === "unavailable")
  )
    state = { phase: "error", message: LINK_REPLACED };
  else if (isSchemaTooNew(schema)) state = { phase: "error", message: TOO_NEW };
  else if (share === undefined) state = { phase: "resolving" };
  else if (share === null) state = { phase: "not-found" };
  else if (!key) state = { phase: "missing-key" };
  else if (!opened || !assets || !crypto)
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
      crypto,
      canWrite: share.permission === "write" && crypto.canWrite,
    };

  // Only after the initial sync: a doc loaded from this browser alone may
  // lack ops the server has, and migrating that would work on a partial
  // project. A newer doc never gets here, it is the TOO_NEW error above.
  const canMigrate = synced && state.phase === "ready" && state.canWrite;
  useEffect(() => {
    // migrate() itself skips a doc that is already current. schema is a
    // dependency so the effect runs again once a pull changes it.
    if (canMigrate) migrate(project);
  }, [canMigrate, schema, project]);

  const syncNow = useCallback(
    async (): Promise<SyncNowResult> =>
      (await syncRef.current?.()) ?? "offline",
    [],
  );

  // The page has followed once its token is the new one.
  const following = followed && followed.token !== token ? followed : null;

  return { state, status, project, ephemeral, mls, following, syncNow };
}
