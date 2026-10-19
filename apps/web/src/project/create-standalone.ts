import { LoroDoc } from "loro-crdt";

import { localProjectAssets } from "@/assets/project-assets";
import { newEditSecret } from "@/crypto/secret";
import { initProject } from "@/doc/schema";
import { recordForgotten, recordOpened } from "@/directory/record";
import { defaultBackend, LocalDocStore } from "@/persist/local-doc-store";

import type { DocBackend } from "@/persist/local-doc-store";
import type { NewProject, ProjectSeed } from "./create";

const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** The shape `validToken` in the directory accepts. */
const ID_LENGTH = 22;

function randomId(): string {
  // 248 is the largest multiple of the alphabet size that fits a byte;
  // bytes above it are skipped so every character is equally likely.
  let id = "";
  while (id.length < ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && id.length < ID_LENGTH)
        id += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }
  return id;
}

/**
 * Creates a project that lives only in this browser: no server, group or
 * wasm. The id doubles as the link token. Nothing reads the edit secret, it
 * only exists because the directory refuses entries without one.
 */
export async function createStandaloneProject(
  title: string,
  opts: { backend?: DocBackend; seed?: ProjectSeed } = {},
): Promise<NewProject> {
  const projectId = randomId();
  const key = newEditSecret();
  const backend = opts.backend ?? (await defaultBackend());

  const doc = new LoroDoc();
  try {
    const store = new LocalDocStore(projectId, doc, backend);
    // Load first: the store only writes what changed after it loaded.
    await store.load();
    const project = initProject(doc, { title, starter: !opts.seed });
    if (opts.seed)
      await opts.seed(project, localProjectAssets(projectId, backend));
    await store.flush();
  } catch (error) {
    // A failed import must not leave its files behind.
    await backend.remove(projectId).catch(() => {});
    throw error;
  } finally {
    doc.free();
  }

  await recordOpened(
    projectId,
    { token: projectId, secret: key, edit: true },
    title,
  );
  return { projectId, editToken: projectId, key };
}

/** Counterpart to createStandaloneProject. */
export async function deleteStandaloneProject(
  projectId: string,
  opts: { backend?: DocBackend } = {},
): Promise<void> {
  await recordForgotten(projectId);
  await (opts.backend ?? (await defaultBackend())).remove(projectId);
}
