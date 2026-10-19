import { EphemeralStore, LoroDoc } from "loro-crdt";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { projectAssets, type ProjectAssets } from "@/assets/project-assets";
import { isEditSecret } from "@/crypto/secret";
import type { SpaceCrypto } from "@/crypto/space-crypto";
import {
  recordAdopted,
  recordOpened,
  recordResolved,
  recordRetired,
  recordRotation,
  recordStatus,
  recordTitle,
} from "@/directory/record";
import {
  DOC_KIND,
  docKind,
  isForeignKind,
  isSchemaTooNew,
  migrate,
  ProjectDoc,
} from "@/doc/schema";
import type { MlsSession } from "@/mls/session";
import {
  loadIdentity,
  provisionalIdentity,
  type Identity,
} from "@/presence/identity";
import { loadShareLinks, loadSpaceKey } from "@/space/space-links";
import {
  LINK_REPLACED,
  SpaceSession,
  TOO_NEW,
  type FollowedLinks,
} from "@/space/space-session";
import type { ShareInfo } from "@/sync/api";
import type { SyncNowResult, SyncStatus } from "@/sync/connection";

import { useDisposeOnUnmount } from "./dispose";

export const NOT_A_PROJECT = "This link does not open a project.";

/** Matches the server's presence timeout. */
const EPHEMERAL_TIMEOUT_MS = 30_000;

// Stops the store's expiry timer, which would otherwise keep it alive.
const destroyEphemeral = (ephemeral: EphemeralStore) => ephemeral.destroy();

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
      crypto: SpaceCrypto;
      /**
       * An edit token with only the view secret can reach the server but
       * not sign, so it is read-only too.
       */
      canWrite: boolean;
    };

export type { FollowedLinks };

export interface ProjectSession {
  state: SessionPhase;
  status: SyncStatus;
  /**
   * The server refused local edits for good on this connection, said for
   * people; null while all is well.
   */
  syncProblem: string | null;
  project: ProjectDoc;
  ephemeral: EphemeralStore;
  /** The project's member group; null until the share is known. */
  mls: MlsSession | null;
  /** Set after a rotation: navigate to these, keeping the session. */
  following: FollowedLinks | null;
  /** Saves locally and pushes pending edits to the server right away. */
  syncNow: () => Promise<SyncNowResult>;
  /** Writes pending edits to this browser's store, without pushing them. */
  saveLocally: () => Promise<void>;
  /** The doc has caught up with the server at least once. */
  synced: boolean;
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
  useDisposeOnUnmount(ephemeral, destroyEphemeral);
  const [fallbackIdentity] = useState(
    () => loadIdentity() ?? provisionalIdentity(),
  );
  const identity = opts.identity ?? fallbackIdentity;
  const [session] = useState(
    () =>
      new SpaceSession({
        token,
        linkKey,
        doc: project.doc,
        ephemeral,
        identity,
        // Undecided until the kind arrives: a fresh link starts from an empty doc.
        accept: (doc) => {
          const kind = docKind(doc);
          return kind === null ? undefined : kind === DOC_KIND.project;
        },
        refusedMessage: NOT_A_PROJECT,
        onRotated: (rotation, spaceId, replaced) =>
          void recordRotation(spaceId, rotation, replaced),
      }),
  );
  const snap = useSyncExternalStore(session.subscribe, session.snapshot);
  const { share, crypto, opened, synced, mls, followed } = snap;

  const schema = useSyncExternalStore(
    useCallback((onChange) => project.meta.subscribe(onChange), [project]),
    () => project.schemaVersion,
  );

  const foreign = useSyncExternalStore(
    useCallback((onChange) => project.meta.subscribe(onChange), [project]),
    () => isForeignKind(project),
  );

  useEffect(() => {
    session.setIdentity(identity);
  });

  useEffect(() => {
    session.setTarget(token, linkKey);
  }, [session, token, linkKey]);

  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);

  useEffect(() => {
    session.updateProfile();
  }, [session, mls, identity.name, identity.color]);

  const assets = useMemo(
    () => (crypto ? projectAssets(token, crypto) : null),
    [token, crypto],
  );

  useEffect(() => {
    if (!opened || !share || !crypto || schema === null || foreign) return;
    if (!session.keepSecret()) return;
    const secret = loadSpaceKey(share.spaceId);
    if (!secret) return;
    const title = project.title || "Untitled";
    void recordOpened(
      share.spaceId,
      {
        token,
        secret,
        edit: share.permission === "write" && isEditSecret(secret),
      },
      title,
    );
    // Someone who opens the view link of their own project (to see what
    // others see) keeps the edit link as the one the list opens.
    const editToken = loadShareLinks(share.spaceId)?.editToken;
    if (editToken && editToken !== token && isEditSecret(secret))
      void recordAdopted(
        share.spaceId,
        { token: editToken, secret, edit: true },
        title,
      );
  }, [opened, synced, share, crypto, schema, foreign, token, project, session]);

  useEffect(() => {
    if (!opened || !share || foreign) return;
    return project.meta.subscribe(
      () => void recordTitle(share.spaceId, project.title || "Untitled"),
    );
  }, [opened, share, foreign, project]);

  const spaceId = share?.spaceId;
  useEffect(() => {
    if (spaceId) void recordResolved(token, spaceId);
  }, [spaceId, token]);

  const p = snap.phase;

  // What this link turned out to be, for the project list. A token the
  // directory never saw open is ignored, so a mistyped link leaves no trace.
  const retired = share?.retired === true;
  const lost = p.phase === "error" && p.message === LINK_REPLACED;
  useEffect(() => {
    if (retired) void recordRetired(token);
  }, [retired, token]);
  useEffect(() => {
    if (p.phase === "removed") void recordStatus(token, "removed");
    else if (p.phase === "not-found" || lost) void recordStatus(token, "gone");
  }, [p.phase, lost, token]);

  let state: SessionPhase;
  if (p.phase === "removed" || p.phase === "error") state = p;
  else if (foreign) state = { phase: "error", message: NOT_A_PROJECT };
  else if (isSchemaTooNew(schema)) state = { phase: "error", message: TOO_NEW };
  else if (
    p.phase === "resolving" ||
    p.phase === "not-found" ||
    p.phase === "missing-key"
  )
    state = p;
  else if (p.phase === "syncing" || !assets)
    state = { phase: "syncing", share: p.share, slow: snap.slow };
  else if (schema === null)
    state = synced
      ? { phase: "empty", share: p.share }
      : { phase: "syncing", share: p.share, slow: snap.slow };
  else
    state = {
      phase: "ready",
      share: p.share,
      assets,
      crypto: p.crypto,
      canWrite: p.share.permission === "write" && p.crypto.canWrite,
    };

  // Only after the initial sync: a doc loaded from this browser alone may
  // lack ops the server has, and migrating that would work on a partial
  // project. A newer doc or another kind never gets here, they are the errors above.
  const canMigrate = synced && state.phase === "ready" && state.canWrite;
  useEffect(() => {
    // migrate() itself skips a doc that is already current. schema is a
    // dependency so the effect runs again once a pull changes it.
    if (canMigrate) migrate(project);
  }, [canMigrate, schema, project]);

  // The page has followed once its token is the new one.
  const following = followed && followed.token !== token ? followed : null;

  return {
    state,
    status: snap.status,
    syncProblem: snap.syncProblem,
    project,
    ephemeral,
    mls,
    following,
    syncNow: session.syncNow,
    saveLocally: session.saveLocally,
    synced,
  };
}
