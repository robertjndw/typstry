import { PersonGraph, devicePublicKey, loadWasm } from "@/crypto/wasm";
import type { DocBackend } from "@/persist/local-doc-store";
import {
  decodeProfile,
  encodeProfile,
  type Identity,
} from "@/presence/identity";

import { mergeOwnGraph } from "./identity";

type ProfileBackend = Pick<
  DocBackend,
  "loadDeviceKey" | "loadGraph" | "mergeGraph"
>;

/**
 * Writes a name and color the user just chose into the person graph, so the
 * other devices pick it up. Entries count against the graph's size cap, so
 * this runs on an explicit change only, and not at all when the graph
 * already says the same. Returns whether an entry was appended. A browser
 * without a graph, or whose device was revoked, has nothing to write into.
 */
export async function publishProfile(
  backend: ProfileBackend,
  identity: Identity,
): Promise<boolean> {
  const [stored, deviceSeed] = await Promise.all([
    backend.loadGraph(),
    backend.loadDeviceKey(),
  ]);
  if (!stored || !deviceSeed) return false;
  await loadWasm();
  const graph = PersonGraph.decode(stored);
  try {
    if (graph.deviceState(devicePublicKey(deviceSeed)) !== "valid")
      return false;
    const bytes = encodeProfile(identity);
    const current = graph.profile();
    if (current && sameProfile(current, identity)) return false;
    graph.setProfile(deviceSeed, bytes);
    await mergeOwnGraph(backend, graph.encode());
    return true;
  } finally {
    graph.free();
  }
}

function sameProfile(bytes: Uint8Array, identity: Identity): boolean {
  const profile = decodeProfile(bytes);
  return profile?.name === identity.name && profile.color === identity.color;
}
