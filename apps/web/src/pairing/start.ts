import { DeviceKey, PairingCode, loadWasm } from "@/crypto/wasm";
import { defaultBackend, type DocBackend } from "@/persist/local-doc-store";

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

async function roleOf(
  backend: DocBackend,
  deviceName: string,
): Promise<PairRole> {
  if (await isHolder(backend))
    return { kind: "holder", grant: (device) => holderGrant(backend, device) };
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
        applyGrant(grant, backend, deviceName, { deviceSeed }),
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

/** Joins the channel of a code or link. Throws `BadCode` for a bad one. */
export async function startEntering(
  input: string,
  deviceName: string,
  opts: StartOptions = {},
): Promise<PairSession> {
  await loadWasm();
  const backend = opts.backend ?? (await defaultBackend());
  const code = PairingCode.parse(input);
  try {
    const session = new PairSession({
      code,
      role: await roleOf(backend, deviceName),
      url: relaySocketUrl(baseLocation(opts.baseUrl), code.channel),
      createSocket: opts.createSocket,
    });
    session.start();
    return session;
  } finally {
    code.free();
  }
}
