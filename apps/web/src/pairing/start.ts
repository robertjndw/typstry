import { sameBytes } from "@/crypto/bytes";
import {
  DeviceKey,
  PairingCode,
  PersonGraph,
  devicePublicKey,
  loadWasm,
} from "@/crypto/wasm";
import { defaultBackend, type DocBackend } from "@/persist/local-doc-store";
import { loadRecent } from "@/project/recent";

import { applyGrant, holderGrant } from "./grant";
import { allocateChannel, relaySocketUrl } from "./relay";
import { PairSession, type PairRole } from "./session";

export interface StartOptions {
  backend?: DocBackend;
  createSocket?: (url: string) => WebSocket;
  baseUrl?: string;
}

/**
 * Where the relay socket goes: the host the channel was allocated at, so
 * both calls reach the same server, or this page's host without a base.
 */
function baseLocation(baseUrl?: string): Pick<Location, "protocol" | "host"> {
  return baseUrl ? new URL(baseUrl, window.location.href) : window.location;
}

/**
 * Whether this browser has a person graph, which makes it the holder. A
 * browser that never created or joined a project has none yet.
 */
export async function isHolder(backend?: DocBackend): Promise<boolean> {
  return (await (backend ?? (await defaultBackend())).loadGraph()) !== null;
}

/**
 * Whether this browser's person is one it most likely became by accident,
 * by opening a link before it was paired: this device is the only one its
 * graph ever had, and it owns none of the projects it knows. Leaving it for
 * another device's person (`switchPerson`) loses nothing.
 */
export async function isDisposable(backend?: DocBackend): Promise<boolean> {
  await loadWasm();
  const store = backend ?? (await defaultBackend());
  const [graphBytes, seed] = await Promise.all([
    store.loadGraph(),
    store.loadDeviceKey(),
  ]);
  if (!graphBytes || !seed) return false;
  const graph = PersonGraph.decode(graphBytes);
  let person: Uint8Array;
  try {
    if (!graph.onlyEverHad(devicePublicKey(seed))) return false;
    person = graph.id();
  } finally {
    graph.free();
  }
  const owners = await Promise.all(
    loadRecent().map(
      async (recent) => (await store.loadMls(recent.projectId))?.ownerPerson,
    ),
  );
  return !owners.some((owner) => owner && sameBytes(owner, person));
}

async function roleOf(
  backend: DocBackend,
  deviceName: string,
  switchPerson = false,
): Promise<PairRole> {
  if (!switchPerson && (await isHolder(backend)))
    return { kind: "holder", grant: (device) => holderGrant(backend, device) };
  // The page asked about switching when it loaded. Since then this browser
  // may have paired or made a project in another tab, and giving up such a
  // person would strand its devices or projects.
  if (
    switchPerson &&
    (await isHolder(backend)) &&
    !(await isDisposable(backend))
  )
    throw new Error(
      "this browser's person has other devices or owns a project now, so it cannot switch",
    );
  // A browser that backs out of pairing must not be left with a key, so a
  // missing one is only made in memory here and stored once a grant arrives.
  const stored = await backend.loadDeviceKey();
  const key = stored ? DeviceKey.import(stored) : DeviceKey.generate();
  try {
    const deviceSeed = stored ? undefined : key.export();
    return {
      kind: "new",
      deviceName,
      devicePub: key.publicKey(),
      onGrant: (grant) =>
        applyGrant(grant, backend, deviceName, {
          deviceSeed,
          replace: switchPerson,
        }),
    };
  } finally {
    key.free();
  }
}

/** Opens a channel and waits there with a fresh code. */
export async function startShowing(
  deviceName: string,
  opts: StartOptions = {},
): Promise<{ session: PairSession; code: string }> {
  await loadWasm();
  const backend = opts.backend ?? (await defaultBackend());
  const role = await roleOf(backend, deviceName);
  const allocated = await allocateChannel({ baseUrl: opts.baseUrl });
  const code = PairingCode.generate(allocated.channel);
  try {
    const session = new PairSession({
      code,
      role,
      url: relaySocketUrl(
        baseLocation(opts.baseUrl),
        allocated.channel,
        allocated.claim,
      ),
      createSocket: opts.createSocket,
    });
    session.start();
    return { session, code: code.toString() };
  } finally {
    code.free();
  }
}

/**
 * Joins the channel of a code or link. Throws `BadCode` for a bad one. With
 * `switchPerson` this browser joins as a new device even though it is a
 * person already, and gives that person up; see `isDisposable`.
 */
export async function startEntering(
  input: string,
  deviceName: string,
  opts: StartOptions & { switchPerson?: boolean } = {},
): Promise<PairSession> {
  await loadWasm();
  const backend = opts.backend ?? (await defaultBackend());
  const code = PairingCode.parse(input);
  try {
    const session = new PairSession({
      code,
      role: await roleOf(backend, deviceName, opts.switchPerson),
      url: relaySocketUrl(baseLocation(opts.baseUrl), code.channel),
      createSocket: opts.createSocket,
    });
    session.start();
    return session;
  } finally {
    code.free();
  }
}
