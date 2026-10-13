import { sameBytes, toHex } from "@/crypto/bytes";
import {
  DeviceKey,
  LinkSecret,
  PersonGraph,
  RecoveryKey,
  adoptGraph,
  devicePublicKey,
  graphsInGroupInfo,
  loadWasm,
  ownerSecretList,
  ownerShareForRecovery,
  personSpacesForRecovery,
  recoverIdentity,
  type PersonSpaceBinding,
  type RecoveredIdentity,
} from "@/crypto/wasm";
import { mapConcurrent } from "@/lib/concurrent";
import { errorKind, toError } from "@/lib/errors";
import { adoptPersonalSpace } from "@/directory/adopt-space";
import { clearBinding } from "@/directory/binding";
import { ensureSpace } from "@/directory/ensure-space";
import { recordOwnerSecret } from "@/directory/record";
import {
  refreshDirectoryService,
  stopDirectoryService,
  waitForDirectorySync,
} from "@/directory/service";
import { directory, resetDirectory } from "@/directory/store";
import type { DocBackend } from "@/persist/local-doc-store";
import { defaultDeviceName } from "@/pairing/device-name";
import {
  adoptProjectLink,
  parseProjectLink,
  projectUrl,
} from "@/project/recent";
import { loadSpaceKey } from "@/space/space-links";
import {
  fetchMlsBootstrap,
  resolveShare,
  type ApiOptions,
  type MlsBootstrap,
  type ShareInfo,
} from "@/sync/api";

import { adoptProfile, localIdentity, mergeOwnGraph } from "./identity";
import { cleanAll, secured } from "./revoke";
import { keepOwnerKey } from "./session";

export const RECOVERY_LABEL = "Recovery key";

/** Something the person can fix, with a message fit to show them. */
export class RecoveryError extends Error {}

/** The browser is a working device of another person; `replace` overrides. */
export class IdentityConflictError extends RecoveryError {}

/**
 * The person revoked this browser's device key, which can never be theirs
 * again. Only a new key, i.e. cleared site data, gets past it.
 */
export class DeviceRevokedError extends RecoveryError {}

type CreateBackend = Pick<
  DocBackend,
  | "loadDeviceKey"
  | "saveDeviceKey"
  | "loadGraph"
  | "mergeGraph"
  | "saveLabels"
  | "loadLabels"
>;

/**
 * Makes a recovery key and adds it to this person's graph, signed by this
 * device. Returns the words, which exist nowhere else: the graph only holds
 * the public half. The personal space is made first: the leaves point at it
 * for the recovery key, and without one recovery reaches a single project.
 */
export async function createRecoveryKey(
  backend: CreateBackend & DocBackend,
  opts: ApiOptions = {},
): Promise<string> {
  await loadWasm();
  try {
    await ensureSpace({ ...opts, backend });
  } catch (error) {
    throw new RecoveryError(
      `Could not set up your personal space, which a recovery key needs: ${toError(error).message}`,
    );
  }
  void refreshDirectoryService().catch((error) =>
    console.warn("could not start the directory sync", error),
  );
  const { deviceSeed, graph } = await localIdentity(backend);
  const generated = RecoveryKey.generate();
  const pub = devicePublicKey(generated.deviceSeed);
  const next = PersonGraph.decode(graph);
  try {
    next.addDevice(deviceSeed, pub, true);
    await mergeOwnGraph(backend, next.encode());
  } catch (error) {
    throw new RecoveryError(
      `Could not add a recovery key: ${toError(error).message}`,
    );
  } finally {
    next.free();
  }
  await backend.saveLabels({ [toHex(pub)]: RECOVERY_LABEL });
  return generated.words;
}

export interface RecoverOptions {
  /** The recovery words, as typed. */
  words: string;
  /** Person graphs read from the project, one per distinct leaf identity. */
  graphs: Uint8Array[];
  /** Leave the person's other devices valid. */
  keepOthers?: boolean;
  /** Overwrite a different identity this browser already has. */
  replace?: boolean;
}

/**
 * Makes this browser a device of the person the recovery key belongs to:
 * adds it, signed by the recovery key, and unless asked not to revokes every
 * other ordinary device. A browser without a device key gets one only once
 * the words matched a graph.
 */
export async function recoverDevice(
  backend: CreateBackend,
  { words, graphs, keepOthers = false, replace = false }: RecoverOptions,
): Promise<{ graph: Uint8Array; revoked: number }> {
  await loadWasm();
  const seed = recoverySeed(words);
  const [storedSeed, storedGraph] = await Promise.all([
    backend.loadDeviceKey(),
    backend.loadGraph(),
  ]);
  const deviceSeed = storedSeed ?? freshDeviceSeed();
  const own = devicePublicKey(deviceSeed);
  let recovered: RecoveredIdentity;
  try {
    recovered = recoverIdentity(graphs, seed, own, storedGraph, {
      keepOthers,
      replace,
    });
  } catch (error) {
    throw recoveryFailure(error);
  }
  if (!storedSeed) {
    // First key stored wins; the graph lists this one, so a key another tab
    // stored meanwhile would leave the browser outside its own person.
    const stored = await backend.saveDeviceKey(deviceSeed);
    if (!sameBytes(stored, deviceSeed))
      throw new RecoveryError(
        "This browser set up an identity of its own while recovering. Try again.",
      );
  }
  let graph: Uint8Array;
  try {
    // Another tab may have stored a graph since it was read above.
    graph = await backend.mergeGraph(recovered.graph, (stored, incoming) =>
      adoptGraph(stored, incoming, own, replace),
    );
  } catch (error) {
    throw recoveryFailure(error);
  }
  adoptProfile(graph, undefined);
  const labels = await backend.loadLabels();
  if (!labels[toHex(own)])
    await backend.saveLabels({ [toHex(own)]: defaultDeviceName() });
  return { graph, revoked: recovered.revoked.length };
}

function recoverySeed(words: string): Uint8Array {
  try {
    return RecoveryKey.fromWords(words);
  } catch (error) {
    if (errorKind(error) === "BadRecoveryWords")
      throw new RecoveryError(
        "Those words are not a recovery key. Check for a typo or a missing word.",
      );
    throw error;
  }
}

function freshDeviceSeed(): Uint8Array {
  const key = DeviceKey.generate();
  try {
    return key.export();
  } finally {
    key.free();
  }
}

function recoveryFailure(error: unknown): RecoveryError {
  switch (errorKind(error)) {
    case "UnknownRecoveryKey":
      return new RecoveryError(
        "This recovery key does not belong to anyone in that project.",
      );
    case "RecoveryKeyRevoked":
      return new RecoveryError(
        "This recovery key was revoked and cannot recover the account any more.",
      );
    case "OwnDeviceRevoked":
      return new DeviceRevokedError(
        "This browser was removed from that account, and a removed device can never be added back. Recover in another browser, or clear this site's data here to start over with a new device key. Projects stored only in this browser are lost with it.",
      );
    case "ForeignIdentity":
      return new IdentityConflictError(
        "This browser already has an identity of its own. Replace it to recover the other one.",
      );
  }
  return new RecoveryError(`Could not recover: ${toError(error).message}`);
}

/**
 * The owner key share a project holds for the recovery key `words` belong
 * to, or undefined when it holds none (a project of someone else, or one
 * made before the recovery key). Read it before the recovered device joins:
 * the shares sit in the leaves of the devices the recovery revokes, and the
 * words are gone once recovery is over.
 */
export function recoveredOwnerKey(
  words: string,
  link: LinkSecret,
  boot: Pick<MlsBootstrap, "groupInfo" | "keyring" | "ownerKey">,
): Uint8Array | undefined {
  try {
    return ownerShareForRecovery(
      link,
      boot.groupInfo,
      boot.keyring,
      boot.ownerKey,
      recoverySeed(words),
    );
  } catch (error) {
    // Recovering the person still works without it; only removing the lost
    // devices from this project does not.
    console.warn("could not read the owner key for the recovery key", error);
    return undefined;
  }
}

/** How long the first directory sync may take before recovery goes on. */
const DIRECTORY_WAIT_MS = 20_000;
const OWNER_KEY_CONCURRENCY = 4;

/**
 * The personal space links the project's leaves hold for the recovery key,
 * best first. Read with the other recovery material, before the lost
 * devices go. Any leaf of the person can carry one, so a stolen device could
 * have planted a pointer: `restorePersonalSpace` tries them in order and
 * takes the first that really is the person's space.
 */
function recoveredPersonSpaces(
  words: string,
  link: LinkSecret,
  boot: Pick<MlsBootstrap, "groupInfo" | "keyring">,
): PersonSpaceBinding[] {
  try {
    return personSpacesForRecovery(
      link,
      boot.groupInfo,
      boot.keyring,
      recoverySeed(words),
    );
  } catch (error) {
    console.warn(
      "could not read the personal space for the recovery key",
      error,
    );
    return [];
  }
}

/**
 * The first of `candidates` that is a live space whose owner key share
 * opens for the recovery key. The share is what ties a pointer to the
 * person: it only opens when the secret derives the key the server names.
 */
async function pickPersonalSpace(
  words: string,
  candidates: PersonSpaceBinding[],
  opts: ApiOptions,
): Promise<{
  binding: PersonSpaceBinding;
  share: ShareInfo;
  owner: Uint8Array;
} | null> {
  const seed = recoverySeed(words);
  for (const binding of candidates) {
    let link: LinkSecret | null = null;
    try {
      const [share, boot] = await Promise.all([
        resolveShare(binding.token, opts),
        fetchMlsBootstrap(binding.token, opts),
      ]);
      if (!share || share.retired || !boot) continue;
      link = LinkSecret.parse(binding.secret);
      const owner = ownerShareForRecovery(
        link,
        boot.groupInfo,
        boot.keyring,
        boot.ownerKey,
        seed,
      );
      if (owner) return { binding, share, owner };
    } catch (error) {
      console.warn("skipping a personal space candidate", error);
    } finally {
      link?.free();
    }
  }
  return null;
}

/**
 * Takes the personal space among `candidates`, which lists every project of
 * the person, and the owner key of each project they own. Returns how many
 * owner keys came back, or null when no candidate was the person's space.
 * The caller removes the lost devices afterwards. Needs the words, so it
 * runs before they are dropped.
 */
async function restorePersonalSpace(
  backend: Pick<DocBackend, "loadMls" | "saveMls">,
  words: string,
  candidates: PersonSpaceBinding[],
  opts: ApiOptions,
): Promise<number | null> {
  const picked = await pickPersonalSpace(words, candidates, opts);
  if (!picked) {
    console.warn("no personal space of the recovery key could be restored");
    return null;
  }
  const { binding, share, owner } = picked;
  await adoptPersonalSpace(backend, { ...binding, share, ownerSecrets: owner });
  await waitForDirectorySync(DIRECTORY_WAIT_MS);

  const entries = (await directory())
    .list(Date.now())
    .filter((entry) => entry.state !== "forgotten");
  const restored = await mapConcurrent(
    entries,
    OWNER_KEY_CONCURRENCY,
    async (entry) => {
      try {
        const [entryShare, projectBoot] = await Promise.all([
          resolveShare(entry.link.token, opts),
          fetchMlsBootstrap(entry.link.token, opts),
        ]);
        // The directory is only as honest as its last writer: the token has
        // to lead to the project it is filed under.
        if (entryShare?.spaceId !== entry.projectId || !projectBoot)
          return false;
        const projectLink = loadSpaceKey(entry.projectId) ?? entry.link.secret;
        const secret = LinkSecret.parse(projectLink);
        let key: Uint8Array | undefined;
        try {
          key = recoveredOwnerKey(words, secret, projectBoot);
        } finally {
          secret.free();
        }
        if (!key) return false;
        await keepOwnerKey(backend, entry.projectId, key);
        await recordOwnerSecret(entry.projectId, ownerSecretList(key)[0]);
        return true;
      } catch (error) {
        console.warn("could not recover the owner key of a project", error);
        return false;
      }
    },
  );
  return restored.filter(Boolean).length;
}

/**
 * Recovers from the words and a link of one of the person's projects: reads
 * the person graphs out of the project's GroupInfo, then recovers. Through
 * the personal space the leaves point at, the whole project list and the
 * owner key of every project comes back too, and the lost devices leave all
 * of them. Returns the path to open, which joins the project as the person.
 * Any step beyond the one project that fails is logged and leaves the
 * recovery of that project as it is.
 */
export async function recoverFromLink(
  backend: CreateBackend & DocBackend,
  input: {
    words: string;
    link: string;
    keepOthers?: boolean;
    replace?: boolean;
  },
  opts: ApiOptions = {},
): Promise<{ path: string; projects: number }> {
  await loadWasm();
  recoverySeed(input.words);
  const parsed = parseProjectLink(input.link.trim());
  if (!parsed)
    throw new RecoveryError(
      "That is not a project link. It looks like …/p/…#…",
    );
  const [share, boot] = await Promise.all([
    resolveShare(parsed.token, opts),
    fetchMlsBootstrap(parsed.token, opts),
  ]);
  if (!share) throw new RecoveryError("That project does not exist any more.");
  if (!boot) throw new RecoveryError("That project has no members to read.");
  let graphs: Uint8Array[];
  let ownerSecrets: Uint8Array | undefined;
  let personal: PersonSpaceBinding[];
  const secret = LinkSecret.parse(parsed.key);
  try {
    graphs = graphsInGroupInfo(secret, boot.groupInfo, boot.keyring);
    ownerSecrets = recoveredOwnerKey(input.words, secret, boot);
    personal = recoveredPersonSpaces(input.words, secret, boot);
  } catch (error) {
    throw new RecoveryError(
      `That link does not open the project: ${toError(error).message}`,
    );
  } finally {
    secret.free();
  }
  await recoverDevice(backend, { ...input, graphs });
  if (ownerSecrets) await keepOwnerKey(backend, share.spaceId, ownerSecrets);

  // The binding, list and owner keys belonged to the person this browser
  // gives up; none of it may upload into the recovered person's space.
  if (input.replace) {
    clearBinding();
    stopDirectoryService();
    await resetDirectory();
  }
  await adoptProjectLink(parsed, share, "");
  let projects = 0;
  if (personal.length > 0) {
    try {
      const restored = await restorePersonalSpace(
        backend,
        input.words,
        personal,
        opts,
      );
      if (restored !== null) {
        projects = restored;
        if (!input.keepOthers) await removeLostDevices(backend);
      }
    } catch (error) {
      console.warn("could not bring back the personal space", error);
    }
  }
  // Removing the lost devices replaced the project's links, and the one
  // typed in is retired by now.
  const current = (await directory()).bestLink(share.spaceId, Date.now());
  const open = current ? { token: current.token, key: current.secret } : parsed;
  return { path: projectUrl(open.token, open.key, ""), projects };
}

/**
 * The recovery already revoked the lost devices in the graph; this applies
 * that to the personal space first (its directory holds every project's
 * links) and then to the projects whose owner key came back.
 */
async function removeLostDevices(backend: DocBackend): Promise<void> {
  const { personal } = await cleanAll(backend);
  if (!secured(personal))
    console.warn("could not secure the project list, projects not cleaned");
}
