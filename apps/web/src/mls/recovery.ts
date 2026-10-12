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
  mergeOwnerSecrets,
  ownerShareForRecovery,
  recoverIdentity,
  type RecoveredIdentity,
} from "@/crypto/wasm";
import { errorKind, toError } from "@/lib/errors";
import type { DocBackend } from "@/persist/local-doc-store";
import { defaultDeviceName } from "@/pairing/device-name";
import { adoptProjectLink, parseProjectLink } from "@/project/recent";
import {
  fetchMlsBootstrap,
  resolveShare,
  type ApiOptions,
  type MlsBootstrap,
} from "@/sync/api";

import { adoptProfile, localIdentity, mergeOwnGraph } from "./identity";
import { emptyRecord } from "./session";

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
 * the public half.
 */
export async function createRecoveryKey(
  backend: CreateBackend,
): Promise<string> {
  await loadWasm();
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

/**
 * Adds `ownerSecrets` (from `recoveredOwnerKey`) to the project's group
 * record, where the join that follows picks them up: with them the
 * recovered device can remove the lost devices and replace the links they
 * hold. What the record kept already stays.
 */
export async function keepOwnerKey(
  backend: Pick<DocBackend, "loadMls" | "saveMls">,
  projectId: string,
  ownerSecrets: Uint8Array,
): Promise<void> {
  const record = await backend.loadMls(projectId);
  await backend.saveMls(projectId, {
    ...(record ?? emptyRecord()),
    ownerSecrets: mergeOwnerSecrets(record?.ownerSecrets, ownerSecrets),
  });
}

/**
 * Recovers from the words and a link of one of the person's projects: reads
 * the person graphs out of the project's GroupInfo, then recovers. Returns
 * the path to open, which joins the project as the person.
 */
export async function recoverFromLink(
  backend: CreateBackend & Pick<DocBackend, "loadMls" | "saveMls">,
  input: {
    words: string;
    link: string;
    keepOthers?: boolean;
    replace?: boolean;
  },
  opts: ApiOptions = {},
): Promise<{ path: string }> {
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
  const secret = LinkSecret.parse(parsed.key);
  try {
    graphs = graphsInGroupInfo(secret, boot.groupInfo, boot.keyring);
    ownerSecrets = recoveredOwnerKey(input.words, secret, boot);
  } catch (error) {
    throw new RecoveryError(
      `That link does not open the project: ${toError(error).message}`,
    );
  } finally {
    secret.free();
  }
  await recoverDevice(backend, { ...input, graphs });
  if (ownerSecrets) await keepOwnerKey(backend, share.projectId, ownerSecrets);

  adoptProjectLink(parsed, share, "");
  return { path: `/p/${encodeURIComponent(parsed.token)}#${parsed.key}` };
}
