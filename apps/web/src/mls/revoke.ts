import { sameBytes } from "@/crypto/bytes";
import { PersonGraph, devicePublicKey, loadWasm } from "@/crypto/wasm";
import { defaultBackend, type DocBackend } from "@/persist/local-doc-store";
import { loadIdentity, provisionalIdentity } from "@/presence/identity";
import {
  keepRotation,
  loadProjectKey,
  loadRecent,
  saveKeyring,
} from "@/project/recent";
import { fetchMlsBootstrap } from "@/sync/api";

import { localIdentity, mergeOwnGraph } from "./identity";
import { MlsSession } from "./session";

/** How long one project may take to answer before it counts as not reached. */
const REACH_MS = 20_000;
const CLEAN_CONCURRENCY = 4;

export type ProjectRevokeResult =
  | { status: "cleaned"; removed: number }
  /** Reached, and no leaf of the revoked device was in it. */
  | { status: "clean" }
  /**
   * Reached and told, but only an owner device with the owner key can
   * remove a device: the revoke is in this device's leaf for it to act on
   * the next time it opens the project.
   */
  | { status: "left-to-owner" }
  | { status: "unreached"; reason: string };

export interface ProjectRevoke {
  projectId: string;
  title: string;
  result: ProjectRevokeResult;
}

/**
 * Marks `target` revoked in this browser's graph. This alone only stops
 * the device from being trusted by what reads the graph later; the projects
 * still hold its leaves until `cleanProjects` has run.
 */
export async function revokeInGraph(
  backend: DocBackend,
  target: Uint8Array,
): Promise<void> {
  await loadWasm();
  const { deviceSeed, graph } = await localIdentity(backend);
  if (sameBytes(devicePublicKey(deviceSeed), target))
    throw new Error("Revoke this device from another one.");
  const next = PersonGraph.decode(graph);
  try {
    next.revoke(deviceSeed, target);
    await mergeOwnGraph(backend, next.encode());
  } finally {
    next.free();
  }
}

/**
 * Applies the graph to every project this browser has a group for: each is
 * opened headless like a project page would, which merges the graph into
 * its leaf and, with the owner key, removes the revoked device's leaves and
 * rotates the links. In a project someone else owns the owner does the
 * removing. A viewer cannot commit, and a project that was never opened
 * here has no group state to act from; both are reported, not hidden.
 * Projects that fail now are cleaned the next time they are opened, since
 * every open runs the same step.
 */
export async function cleanProjects(
  backend: DocBackend,
  create: (
    projectId: string,
    title: string,
    backend: DocBackend,
  ) => MlsSession = headlessSession,
): Promise<ProjectRevoke[]> {
  await loadWasm();
  const recents = loadRecent();
  const stored = await Promise.all(
    recents.map((recent) => backend.loadMls(recent.projectId)),
  );
  const results = new Array<ProjectRevoke>(recents.length);
  const cleanOne = async (i: number): Promise<ProjectRevokeResult> => {
    const recent = recents[i]!;
    const record = stored[i];
    const link = loadProjectKey(recent.projectId);
    if (!link || !record?.state || record.removed)
      return {
        status: "unreached",
        reason: record?.removed
          ? "you were removed from it"
          : "it was never opened in this browser",
      };
    const session = create(recent.projectId, recent.title, backend);
    try {
      return await clean(session, { token: recent.token, link });
    } catch (error) {
      console.error(error);
      return { status: "unreached", reason: "something went wrong" };
    } finally {
      session.stop();
    }
  };
  // Each project can wait out REACH_MS on a server that does not answer,
  // so they run side by side, but only a few at a time: each holds a socket
  // and a group in memory.
  let next = 0;
  async function worker() {
    while (next < recents.length) {
      const i = next++;
      const { projectId, title } = recents[i]!;
      results[i] = { projectId, title, result: await cleanOne(i) };
    }
  }
  await Promise.all(Array.from({ length: CLEAN_CONCURRENCY }, () => worker()));
  return results;
}

async function clean(
  session: MlsSession,
  target: { token: string; link: string },
): Promise<ProjectRevokeResult> {
  await session.start(target);
  if (!(await session.untilSynced(REACH_MS)))
    return { status: "unreached", reason: "the server did not answer" };
  if (session.getSnapshot().phase !== "active")
    return { status: "unreached", reason: "you are no longer a member" };
  const done = await session.syncIdentity();
  if (!done.canCommit)
    return { status: "unreached", reason: "you can only view it" };
  if (session.removedLeaves > 0)
    return { status: "cleaned", removed: session.removedLeaves };
  const { members, holdsOwnerKey } = session.getSnapshot();
  if (holdsOwnerKey || !members.some((m) => m.deviceRevoked))
    return { status: "clean" };
  // The person's own project, opened on a device the owner key has not
  // reached yet: another of their devices has to do it.
  if (members.find((m) => m.isSelf)?.role === "owner")
    return {
      status: "unreached",
      reason: "this device does not have the project's owner key yet",
    };
  return { status: "left-to-owner" };
}

function headlessSession(
  projectId: string,
  title: string,
  backend: DocBackend,
): MlsSession {
  return new MlsSession({
    projectId,
    backend,
    fetchBootstrap: (token) => fetchMlsBootstrap(token),
    identity: () => loadIdentity() ?? provisionalIdentity(),
    localIdentity: () => localIdentity(backend),
    mergeGraph: (graph) => mergeOwnGraph(backend, graph),
    onRotated: (rotation) => keepRotation(projectId, rotation, title),
    onKeyring: (keyring) => saveKeyring(projectId, keyring),
    onError: (error) => console.warn("group:", error),
  });
}

/** Revokes and cleans in one go; the dialog shows what each project said. */
export async function revokeDevice(
  target: Uint8Array,
): Promise<ProjectRevoke[]> {
  const backend = await defaultBackend();
  await revokeInGraph(backend, target);
  return cleanProjects(backend);
}
