import { sameBytes } from "@/crypto/bytes";
import {
  DeviceKey,
  PersonGraph,
  adoptGraph,
  devicePublicKey,
  loadWasm,
} from "@/crypto/wasm";
import type { DocBackend } from "@/persist/local-doc-store";
import {
  decodeProfile,
  encodeProfile,
  loadIdentity,
  setIdentity,
} from "@/presence/identity";

type IdentityBackend = Pick<
  DocBackend,
  "loadDeviceKey" | "saveDeviceKey" | "loadGraph" | "mergeGraph"
>;

/** What a project's group needs of this browser to vouch for its leaf. */
export interface LocalIdentity {
  /** `DeviceKey.export` bytes. */
  deviceSeed: Uint8Array;
  /** `PersonGraph.encode` bytes, with the device valid in it. */
  graph: Uint8Array;
}

/**
 * This browser's device key, made the first time it is needed. It stays in
 * this browser's storage and is never sent anywhere.
 */
export async function localDeviceKey(
  backend: Pick<DocBackend, "loadDeviceKey" | "saveDeviceKey">,
): Promise<Uint8Array> {
  const stored = await backend.loadDeviceKey();
  if (stored) return stored;
  await loadWasm();
  const fresh = DeviceKey.generate();
  try {
    // Returns the winner when another tab saved a key in the meantime.
    return await backend.saveDeviceKey(fresh.export());
  } finally {
    fresh.free();
  }
}

/**
 * The device key and the person graph of this browser. The graph starts as
 * a genesis signed by the device, which makes it the first device of a new
 * person; pairing replaces that role by storing a granted graph instead.
 * A name already chosen here goes into the new graph right away, since a
 * name picked before the first project would otherwise only reach it with
 * the next change.
 */
export async function localIdentity(
  backend: IdentityBackend,
): Promise<LocalIdentity> {
  const [deviceSeed, stored] = await Promise.all([
    localDeviceKey(backend),
    backend.loadGraph(),
  ]);
  if (stored) return { deviceSeed, graph: stored };
  const genesis = PersonGraph.genesis(deviceSeed);
  const chosen = loadIdentity();
  if (chosen) genesis.setProfile(deviceSeed, encodeProfile(chosen));
  try {
    // First write wins: a tab that raced us made a different genesis, and
    // two of them cannot be merged.
    const graph = await backend.mergeGraph(
      genesis.encode(),
      (existing, incoming) => existing ?? incoming,
    );
    return { deviceSeed, graph };
  } finally {
    genesis.free();
  }
}

/**
 * Folds `bytes` into the stored graph and returns the result. A graph of
 * another person is refused while this device is valid in the stored one.
 * A profile that the merge brought in, e.g. set on another device, becomes
 * this browser's name and color.
 */
export async function mergeOwnGraph(
  backend: Pick<DocBackend, "loadDeviceKey" | "mergeGraph">,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  await loadWasm();
  const seed = await backend.loadDeviceKey();
  if (!seed) throw new Error("this browser has no device key yet");
  const own = devicePublicKey(seed);
  let before: Uint8Array | undefined;
  const merged = await backend.mergeGraph(bytes, (stored, incoming) => {
    before = stored ? profileOf(stored) : undefined;
    return adoptGraph(stored, incoming, own, false);
  });
  adoptProfile(merged, before);
  return merged;
}

/**
 * Takes the graph's profile into the stored identity, but only when the
 * merge changed it: a name picked here and not yet written to the graph
 * must not be rolled back by an unrelated merge. Adopting only touches the
 * local identity, never the graph, so it cannot start a write loop.
 */
export function adoptProfile(
  graph: Uint8Array,
  before: Uint8Array | undefined,
) {
  takeProfile(profileOf(graph), before);
}

function profileOf(graph: Uint8Array): Uint8Array | undefined {
  const decoded = PersonGraph.decode(graph);
  try {
    return decoded.profile();
  } finally {
    decoded.free();
  }
}

function takeProfile(
  bytes: Uint8Array | undefined,
  before: Uint8Array | undefined,
) {
  if (!bytes || (before && sameBytes(before, bytes))) return;
  const profile = decodeProfile(bytes);
  if (!profile) return;
  const current = loadIdentity();
  if (current?.name === profile.name && current.color === profile.color) return;
  setIdentity(profile);
}
