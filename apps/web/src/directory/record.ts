// What the directory learns from the rest of the app. Call sites stay one
// line; a directory that cannot be written must never stop a project from
// opening, so failures are logged and dropped here.
import { isEditSecret } from "@/crypto/secret";
import { loadWasm, withOwnerSecrets } from "@/crypto/wasm";
import type { StoredRotation } from "@/persist/local-doc-store";

import { loadBinding } from "./binding";
import type { Directory, NewLink } from "./directory";
import type { State } from "./schema";
import { directory, flushDirectory } from "./store";

/**
 * The page's directory, unless it must not be written: a doc of another kind
 * or a newer layout would be corrupted by this build's writes, the same rule
 * as `ensure_supported` in the CLI.
 */
async function writableDirectory(): Promise<Directory> {
  const dir = await directory();
  const unsupported = dir.unsupported();
  if (unsupported)
    throw new Error(`unsupported directory: ${JSON.stringify(unsupported)}`);
  return dir;
}

async function write(
  what: string,
  change: (dir: Directory, now: number) => unknown,
): Promise<void> {
  try {
    await change(await writableDirectory(), Date.now());
    await flushDirectory();
  } catch (error) {
    console.warn(`could not record ${what} in the directory`, error);
  }
}

type LinkFacts = Omit<NewLink, "projectId" | "addedAt">;

/** A project was opened (or created) with this link. */
export function recordOpened(
  projectId: string,
  link: LinkFacts,
  title: string,
): Promise<void> {
  return write("an opened project", (dir, now) =>
    dir.batch("open project", () => {
      dir.addLink({ ...link, projectId, addedAt: now });
      dir.setTitle(projectId, title);
      dir.touchOpened(projectId, now);
      // Opening it again is proof it works, whatever was seen before.
      const known = dir.entry(projectId, now);
      if (known && known.state !== "listed")
        dir.setStatus(projectId, "listed", now);
    }),
  );
}

/** A link was handed to this browser; the project was not opened. */
export function recordAdopted(
  projectId: string,
  link: LinkFacts,
  title: string,
): Promise<void> {
  return write("an adopted link", (dir, now) =>
    dir.batch("adopt link", () => {
      dir.addLink({ ...link, projectId, addedAt: now });
      dir.setTitle(projectId, title);
    }),
  );
}

export function recordTitle(projectId: string, title: string): Promise<void> {
  return write("a title", (dir) => dir.setTitle(projectId, title));
}

/**
 * The links of a project changed. The best link before this one is retired
 * with `replaced`, since a rotation replaces every link at once.
 */
export function recordRotation(
  projectId: string,
  rotation: StoredRotation,
  replaced?: string,
): Promise<void> {
  return write("a rotation", (dir, now) =>
    dir.batch("rotate links", () => {
      const before = dir.bestLink(projectId, now)?.token;
      dir.addLink({
        token: rotation.token,
        projectId,
        secret: rotation.link,
        edit: rotation.canEdit && isEditSecret(rotation.link),
        addedAt: now,
      });
      for (const old of new Set([before, replaced]))
        if (old && old !== rotation.token) dir.retire(old, now);
      dir.pruneRetired(now);
    }),
  );
}

/**
 * A session resolved `token` to `projectId`. If the directory files the token
 * under another project the filing is wrong, whether planted or mistaken, and
 * the entry is moved to the project the server names. The link itself may
 * still be the only working one, so it is not retired.
 */
export function recordResolved(
  token: string,
  projectId: string,
): Promise<void> {
  return write("a resolved link", (dir, now) => {
    const filed = dir.projectOfToken(token, now);
    if (!filed || filed === projectId) return;
    console.warn("the project list filed a link under the wrong project");
    dir.refileLink(token, projectId);
  });
}

/** The server said this share token is replaced. */
export function recordRetired(token: string): Promise<void> {
  return write("a retired link", (dir, now) => {
    dir.retire(token, now);
  });
}

/** What happened to the project behind a token this browser used. */
export function recordStatus(
  token: string,
  state: Exclude<State, "listed" | "forgotten">,
): Promise<void> {
  return write(`a ${state} project`, (dir, now) => {
    const projectId = dir.projectOfToken(token, now);
    if (projectId) dir.setStatus(projectId, state, now, token);
  });
}

/**
 * The person removed the project from their list. Unlike the rest, this
 * throws: the person asked for it and is told whether it worked.
 */
export async function recordForgotten(projectId: string): Promise<void> {
  const dir = await writableDirectory();
  dir.setStatus(projectId, "forgotten", Date.now());
  await flushDirectory();
}

/**
 * The owner key secret (bare 32 bytes) the server currently names for a
 * project goes to the directory so the person's other devices can rotate
 * its links too. Only that one, never the whole held set: an old key could
 * otherwise be planted again after pruning. Nothing is written or flushed
 * when it is there already. The personal space's own key is left out: it
 * travels in the pairing grant, and the directory lives inside that space.
 */
export function recordOwnerSecret(
  projectId: string,
  secret: Uint8Array | null | undefined,
): Promise<void> {
  if (!secret || projectId === loadBinding()?.spaceId) return Promise.resolve();
  return (async () => {
    try {
      await loadWasm();
      const dir = await writableDirectory();
      const now = Date.now();
      if (!dir.addOwnerKey(projectId, secret, now)) return;
      dir.pruneOwnerKeys(projectId, now);
      await flushDirectory();
    } catch (error) {
      console.warn("could not record an owner key in the directory", error);
    }
  })();
}

/**
 * The directory's owner key secrets for the project, newest first; empty
 * when it knows none or cannot be read.
 */
export async function directoryOwnerSecrets(
  projectId: string,
): Promise<Uint8Array[]> {
  if (projectId === loadBinding()?.spaceId) return [];
  try {
    await loadWasm();
    return (await directory())
      .ownerKeys(projectId, Date.now())
      .map((key) => key.secret);
  } catch (error) {
    console.warn("could not read owner keys from the directory", error);
    return [];
  }
}

/**
 * `ownerSecrets` with the directory's keys for the project added in free
 * room only: the directory is shared with every device of the person, so
 * what it holds must never push out a key this device already has.
 * Returns `ownerSecrets` untouched when the directory knows none.
 */
export async function withDirectoryOwnerKeys(
  projectId: string,
  ownerSecrets: Uint8Array | undefined,
): Promise<Uint8Array | undefined> {
  const secrets = await directoryOwnerSecrets(projectId);
  if (secrets.length === 0) return ownerSecrets;
  return withOwnerSecrets(ownerSecrets, secrets);
}
