import { sameBytes } from "@/crypto/bytes";
import { PersonGraph, devicePublicKey, loadWasm } from "@/crypto/wasm";
import { mapConcurrent } from "@/lib/concurrent";
import {
  defaultBackend,
  type DocBackend,
  type StoredRotation,
} from "@/persist/local-doc-store";
import { loadIdentity, provisionalIdentity } from "@/presence/identity";
import { loadBinding, saveBinding } from "@/directory/binding";
import { recordRotation, withDirectoryOwnerKeys } from "@/directory/record";
import { refreshDirectoryService } from "@/directory/service";
import { directory } from "@/directory/store";
import { loadSpaceKey, saveKeyring, storeRotation } from "@/space/space-links";
import { fetchMlsBootstrap, resolveShare } from "@/sync/api";

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
   * A space this person owns: the revoked device may know its links from the
   * directory or a shared link, so they were replaced although it has no
   * leaf in it.
   */
  | { status: "links-reset" }
  /**
   * Reached and told, but only an owner device with the owner key can
   * remove a device: the revoke is in this device's leaf for it to act on
   * the next time it opens the project.
   */
  | { status: "left-to-owner" }
  | { status: "unreached"; reason: string };

/** What happened to the personal space that holds the directory. */
export type PersonalRevoke =
  /** Nothing synced here, so there is no space to clean. */
  { status: "none" } | ProjectRevokeResult;

/**
 * While `personal` is not `secured`, `projects` stays empty: new links would
 * have gone into a directory the revoked device still reads.
 */
export interface RevokeOutcome {
  personal: PersonalRevoke;
  projects: ProjectRevoke[];
}

/** Whether `resetLinks` is wanted when no revoked leaf was found. */
export interface CleanOptions {
  /** Default true. Off for callers that only want identities in step. */
  resetLinks?: boolean;
}

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
    backend: DocBackend,
  ) => MlsSession = projectSession,
  { resetLinks = true }: CleanOptions = {},
): Promise<ProjectRevoke[]> {
  await loadWasm();
  // Forgotten only hides a project from the list: its links stay valid, and
  // the revoked device may know them, so the ones this person owns are
  // cleaned too.
  const entries = (await directory()).list(Date.now());
  const stored = await Promise.all(
    entries.map((entry) => backend.loadMls(entry.projectId)),
  );
  const cleanOne = async (i: number): Promise<ProjectRevokeResult | null> => {
    const entry = entries[i]!;
    const record = stored[i];
    const link = loadSpaceKey(entry.projectId) ?? entry.link.secret;
    // A group is joined from outside only by a device that kept the owner
    // key of a project it lost the state of; any other would not get the key
    // before an owner device hands it over, and joining someone else's
    // project just to look would add this device to it.
    const detached = !record?.state;
    if (record?.removed)
      return { status: "unreached", reason: "you were removed from it" };
    // Joining a project this browser never opened rotates its links, which
    // only a revocation is worth.
    if (detached && !resetLinks) return null;
    // Another device of the person may hold the key of a project this one
    // never opened; the directory carries it here.
    let ownerSecrets: Uint8Array | undefined;
    try {
      ownerSecrets = detached
        ? await withDirectoryOwnerKeys(entry.projectId, record?.ownerSecrets)
        : undefined;
    } catch (error) {
      // Owner keys saved by a newer typstry must not be merged over, and one
      // such project should not abort the cleanup of all the others.
      console.error(error);
      return {
        status: "unreached",
        reason: "its owner keys could not be read",
      };
    }
    if (!link || (detached && !(entry.link.edit && ownerSecrets)))
      // A project the person dropped and cannot clean from here is not worth
      // a word, they chose not to see it.
      return entry.state === "forgotten"
        ? null
        : { status: "unreached", reason: NEVER_OPENED };
    // An entry is only a claim of whoever wrote the directory; the token has
    // to lead to the project it is filed under before it is acted on.
    try {
      const share = await resolveShare(entry.link.token);
      if (share?.spaceId !== entry.projectId)
        return { status: "unreached", reason: BAD_ENTRY };
    } catch {
      return { status: "unreached", reason: "the server did not answer" };
    }
    const session = create(entry.projectId, backend);
    try {
      return await clean(
        session,
        { token: entry.link.token, link },
        resetLinks,
      );
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
  const results = await mapConcurrent(
    entries,
    CLEAN_CONCURRENCY,
    async ({ projectId, title }, i): Promise<ProjectRevoke | null> => {
      const result = await cleanOne(i);
      return result && { projectId, title: title ?? "Untitled", result };
    },
  );
  return results.filter((r) => r !== null);
}

const NEVER_OPENED =
  "never opened here, and no device of yours has its owner key";
const BAD_ENTRY = "its link in your project list leads somewhere else";
const NO_OWNER_KEY = "this device does not have the project's owner key yet";

/**
 * An owner with the key also resets the links when the revoked device has no
 * leaf: the directory or a shared link may have told it where the space is.
 */
async function clean(
  session: MlsSession,
  target: { token: string; link: string },
  resetLinks: boolean,
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
  const owner = members.find((m) => m.isSelf)?.role === "owner";
  if (owner && resetLinks) {
    if (!holdsOwnerKey) return { status: "unreached", reason: NO_OWNER_KEY };
    await session.resetLinks();
    return { status: "links-reset" };
  }
  if (holdsOwnerKey || !members.some((m) => m.deviceRevoked))
    return { status: "clean" };
  // The person's own project, opened on a device the owner key has not
  // reached yet: another of their devices has to do it.
  if (owner) return { status: "unreached", reason: NO_OWNER_KEY };
  return { status: "left-to-owner" };
}

function projectSession(projectId: string, backend: DocBackend): MlsSession {
  return headlessSession(projectId, backend, (rotation) => {
    void recordRotation(projectId, rotation);
  });
}

/** The directory's binding has to follow the rotation or sync stops. */
function personalSession(spaceId: string, backend: DocBackend): MlsSession {
  return headlessSession(spaceId, backend, (rotation) => {
    if (rotation.canEdit)
      saveBinding({
        spaceId,
        token: rotation.token,
        secret: rotation.link,
      });
  });
}

function headlessSession(
  spaceId: string,
  backend: DocBackend,
  onRotated: (rotation: StoredRotation) => void,
): MlsSession {
  return new MlsSession({
    spaceId,
    backend,
    fetchBootstrap: (token) => fetchMlsBootstrap(token),
    identity: () => loadIdentity() ?? provisionalIdentity(),
    localIdentity: () => localIdentity(backend),
    mergeGraph: (graph) => mergeOwnGraph(backend, graph),
    onRotated: (rotation) => {
      storeRotation(spaceId, rotation);
      onRotated(rotation);
    },
    onKeyring: (keyring) => saveKeyring(spaceId, keyring),
    onError: (error) => console.warn("group:", error),
  });
}

/**
 * Drops the revoked device from the personal space first: the directory
 * holds the links of every project, so until the space has rotated the
 * device would keep reading the links the later steps replace.
 */
export async function cleanPersonalSpace(
  backend: DocBackend,
  create: (
    spaceId: string,
    backend: DocBackend,
  ) => MlsSession = personalSession,
  { resetLinks = true }: CleanOptions = {},
): Promise<PersonalRevoke> {
  await loadWasm();
  const binding = loadBinding();
  if (!binding) return { status: "none" };
  const record = await backend.loadMls(binding.spaceId);
  // A recovered device holds the owner key but never joined the space yet.
  const detached = !record?.state && !!record?.ownerSecrets;
  if ((!record?.state && !detached) || record?.removed)
    return { status: "unreached", reason: "it is not open on this device" };
  // Joining a space this browser never opened just to look would rotate it
  // for nothing; only a revocation justifies that.
  if (detached && !resetLinks) return { status: "none" };
  const session = create(binding.spaceId, backend);
  try {
    return await clean(
      session,
      {
        token: binding.token,
        link: loadSpaceKey(binding.spaceId) ?? binding.secret,
      },
      resetLinks,
    );
  } catch (error) {
    console.error(error);
    return { status: "unreached", reason: "something went wrong" };
  } finally {
    session.stop();
    // The running sync may still hold the old links.
    void refreshDirectoryService().catch(() => {});
  }
}

export function secured(personal: PersonalRevoke): boolean {
  return (
    personal.status === "none" ||
    personal.status === "cleaned" ||
    personal.status === "links-reset"
  );
}

export interface RevokeDeps {
  backend?: DocBackend;
  createProject?: (projectId: string, backend: DocBackend) => MlsSession;
  createPersonal?: (spaceId: string, backend: DocBackend) => MlsSession;
}

/**
 * Applies the graph's revocations to the personal space and, once that is
 * secured, to every project.
 */
export async function cleanAll(
  backend: DocBackend,
  deps: Omit<RevokeDeps, "backend"> = {},
): Promise<RevokeOutcome> {
  const personal = await cleanPersonalSpace(backend, deps.createPersonal);
  // New project links are written into the directory; with the personal
  // space still open to the revoked device they would just be handed over.
  if (!secured(personal)) return { personal, projects: [] };
  const projects = await cleanProjects(backend, deps.createProject);
  return { personal, projects };
}

/** Revokes and cleans in one go; the dialog shows what each project said. */
export async function revokeDevice(
  target: Uint8Array,
  deps: RevokeDeps = {},
): Promise<RevokeOutcome> {
  const backend = deps.backend ?? (await defaultBackend());
  await revokeInGraph(backend, target);
  return cleanAll(backend, deps);
}
