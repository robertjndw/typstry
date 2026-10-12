import { sameBytes, toHex } from "@/crypto/bytes";
import {
  PersonGraph,
  adoptGraph,
  devicePublicKey,
  loadWasm,
  type PairingProject,
} from "@/crypto/wasm";
import { errorKind } from "@/lib/errors";
import type { DocBackend } from "@/persist/local-doc-store";
import {
  adoptProjectLink,
  loadProjectKey,
  loadRecent,
  parseProjectLink,
  projectUrl,
} from "@/project/recent";
import { resolveShare, type ApiOptions } from "@/sync/api";

import { localDeviceKey, localIdentity, mergeOwnGraph } from "@/mls/identity";

import { defaultDeviceName } from "./device-name";
import {
  GrantRefusedError,
  type Grant,
  type PairedProject,
  type PairingDevice,
} from "./session";

/**
 * What this browser hands to a new device: the person graph with the device
 * added, and the links of the projects it holds a key for. The links are
 * secrets, which is why they only ever travel inside the sealed pairing.
 * The pairing cuts the list to what a grant holds.
 */
export async function holderGrant(
  backend: Pick<
    DocBackend,
    | "loadDeviceKey"
    | "saveDeviceKey"
    | "loadGraph"
    | "mergeGraph"
    | "saveLabels"
    | "loadLabels"
  >,
  device: PairingDevice,
  origin = window.location.origin,
): Promise<Grant> {
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

  const projects: PairingProject[] = [];
  for (const recent of loadRecent()) {
    const key = loadProjectKey(recent.projectId);
    if (key)
      projects.push({
        title: recent.title,
        link: projectUrl(recent.token, key, origin),
      });
  }
  return { graph: saved, projects, holderName };
}

/**
 * Takes a grant on the new device: stores the person graph, then the key of
 * each project and puts it in the recent list. The group is joined when the
 * project is first opened, and the join carries the identity by itself.
 * Returns the projects that can be opened now; one that cannot be looked up
 * is left out rather than failing the rest.
 */
export async function applyGrant(
  grant: Grant,
  backend: Pick<
    DocBackend,
    "loadDeviceKey" | "saveDeviceKey" | "mergeGraph" | "saveLabels"
  >,
  deviceName: string,
  opts: ApiOptions & {
    /** A key made for this pairing that is not stored yet. */
    deviceSeed?: Uint8Array;
    /** Give up the person this browser has for the granted one. */
    replace?: boolean;
  } = {},
): Promise<PairedProject[]> {
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

  // Looked up side by side, but stored one by one in the grant's order: each
  // store rewrites the recent list, and the order decides where it ends up.
  const links = grant.projects.flatMap((project) => {
    const parsed = parseProjectLink(project.link);
    return parsed ? [{ title: project.title, parsed }] : [];
  });
  const shares = await Promise.allSettled(
    links.map(({ parsed }) => resolveShare(parsed.token, opts)),
  );
  const opened: PairedProject[] = [];
  links.forEach(({ title, parsed }, i) => {
    const share = shares[i]!;
    if (share.status === "rejected") {
      console.error(share.reason);
      return;
    }
    if (!share.value) return;
    adoptProjectLink(parsed, share.value, title);
    opened.push({
      title: title || "Untitled",
      link: `/p/${encodeURIComponent(parsed.token)}`,
    });
  });
  return opened;
}
