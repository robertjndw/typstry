import { sameBytes, toHex } from "@/crypto/bytes";
import {
  PersonGraph,
  adoptGraph,
  devicePublicKey,
  loadWasm,
  type PairingSpace,
} from "@/crypto/wasm";
import { errorKind } from "@/lib/errors";
import type { DocBackend } from "@/persist/local-doc-store";
import { adoptPersonalSpace } from "@/directory/adopt-space";
import { clearBinding } from "@/directory/binding";
import { ensureSpace } from "@/directory/ensure-space";
import { refreshDirectoryService } from "@/directory/service";
import { resolveShare, type ApiOptions } from "@/sync/api";

import { localDeviceKey, localIdentity, mergeOwnGraph } from "@/mls/identity";

import { defaultDeviceName } from "./device-name";
import { GrantRefusedError, type Grant, type PairingDevice } from "./session";

/**
 * What this browser hands to a new device: the person graph with the device
 * added, and the personal space that syncs the directory of projects. The
 * space is made here if it does not exist yet and its key and owner secrets
 * travel along, only ever inside the sealed pairing. Pairing runs through the
 * server, so a space that cannot be made fails the grant.
 */
export async function holderGrant(
  backend: DocBackend,
  device: PairingDevice,
  opts: ApiOptions = {},
): Promise<Grant> {
  // Before the device is added, so a failure leaves nothing behind.
  const space = await spaceToGrant(backend, opts);
  const { deviceSeed, graph } = await localIdentity(backend);
  const own = PersonGraph.decode(graph);
  let bytes: Uint8Array;
  try {
    own.vouch(deviceSeed, device.pub);
    bytes = own.encode();
  } catch (error) {
    // An entry signed by a revoked device would not count anywhere.
    if (errorKind(error) === "NotValid")
      throw new GrantRefusedError(
        "this device was removed from your account and cannot add another",
      );
    if (errorKind(error) === "DeviceRevoked")
      throw new GrantRefusedError(
        "that device was removed from your account and cannot be added again",
      );
    throw error;
  } finally {
    own.free();
  }
  const holderName =
    (await backend.loadLabels())[toHex(devicePublicKey(deviceSeed))] ??
    defaultDeviceName();
  // Stored before it is handed over: the device is a member of the person
  // from here on, whether or not the grant arrives.
  const saved = await mergeOwnGraph(backend, bytes);
  await backend.saveLabels({ [toHex(device.pub)]: device.name });

  return { graph: saved, holderName, space };
}

async function spaceToGrant(
  backend: DocBackend,
  opts: ApiOptions,
): Promise<PairingSpace> {
  try {
    const binding = await ensureSpace({ ...opts, backend });
    const ownerSecrets = (await backend.loadMls(binding.spaceId))?.ownerSecrets;
    if (!ownerSecrets) throw new Error("no owner key kept for the space");
    // The holder syncs its own directory from now on, whether or not the
    // other device ever finishes.
    void refreshDirectoryService().catch((error) =>
      console.warn("could not start the directory sync", error),
    );
    return {
      token: binding.token,
      secret: binding.secret,
      ownerSecrets,
    };
  } catch (error) {
    console.warn("could not set up the personal space", error);
    throw new GrantRefusedError(
      "could not set up your personal space, which carries your projects to the new device",
    );
  }
}

/**
 * Takes a grant on the new device: stores the person graph and binds the
 * directory to the personal space, whose first sync brings the projects.
 */
export async function applyGrant(
  grant: Grant,
  backend: Pick<
    DocBackend,
    | "loadDeviceKey"
    | "saveDeviceKey"
    | "mergeGraph"
    | "saveLabels"
    | "loadMls"
    | "saveMls"
  >,
  deviceName: string,
  opts: ApiOptions & {
    /** A key made for this pairing that is not stored yet. */
    deviceSeed?: Uint8Array;
    /** Give up the person this browser has for the granted one. */
    replace?: boolean;
  } = {},
): Promise<void> {
  await loadWasm();
  // A key made for this pairing is stored only once the grant proved to
  // list it, so a refused pairing leaves nothing behind.
  const deviceSeed = opts.deviceSeed ?? (await localDeviceKey(backend));
  const pub = devicePublicKey(deviceSeed);
  const granted = PersonGraph.decode(grant.graph);
  let holder: Uint8Array | undefined;
  try {
    if (granted.deviceState(pub) !== "valid")
      throw new GrantRefusedError("the grant does not include this device");
    holder = granted.addedBy(pub);
  } finally {
    granted.free();
  }
  if (opts.deviceSeed) {
    // The first key stored wins. If another tab stored one while we waited,
    // the grant lists a key this browser no longer uses, and storing the
    // graph would leave it without a device of its person. Refusing leaves
    // that tab's identity untouched and the person starts over.
    const stored = await backend.saveDeviceKey(opts.deviceSeed);
    if (!sameBytes(stored, opts.deviceSeed))
      throw new GrantRefusedError(
        "this browser set up its own identity while pairing; try again",
      );
  }
  // Another tab may have made a person of its own since the role was chosen;
  // the merge sees that inside the transaction that stores the grant.
  await backend.mergeGraph(grant.graph, (stored, incoming) => {
    try {
      return adoptGraph(stored, incoming, pub, opts.replace ?? false);
    } catch (error) {
      if (errorKind(error) === "ForeignIdentity")
        throw new GrantRefusedError(
          "this device already belongs to another person",
        );
      throw error;
    }
  });
  const labels: Record<string, string> = { [toHex(pub)]: deviceName };
  if (holder) labels[toHex(holder)] = grant.holderName;
  await backend.saveLabels(labels);

  await adoptSpace(grant.space, backend, opts.replace ?? false, opts);
}

/**
 * Takes the personal space of the person. Never fails the pairing; a device
 * without it keeps a local directory.
 */
async function adoptSpace(
  space: PairingSpace,
  backend: Pick<DocBackend, "loadMls" | "saveMls">,
  replace: boolean,
  opts: ApiOptions,
): Promise<void> {
  // The space belonged to the person this browser gives up. The directory
  // itself stays and merges into the new person's, owner keys included, the
  // way `typstry pair --replace` moves its folders over: the projects belong
  // to whoever switches, and dropping the keys could leave a project this
  // browser owned alone with no owner at all.
  if (replace) clearBinding();
  try {
    const share = await resolveShare(space.token, opts);
    if (!share) throw new Error("the personal space does not exist any more");
    await adoptPersonalSpace(backend, { ...space, share });
  } catch (error) {
    console.warn("could not take the personal space", error);
  }
}
