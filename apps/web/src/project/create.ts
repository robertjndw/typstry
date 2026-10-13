import { LoroDoc } from "loro-crdt";

import { projectAssets, type ProjectAssets } from "@/assets/project-assets";
import { SpaceCrypto } from "@/crypto/space-crypto";
import { ownerSecretList } from "@/crypto/wasm";
import { initProject, type ProjectDoc } from "@/doc/schema";
import {
  defaultBackend,
  LocalDocStore,
  type DocBackend,
} from "@/persist/local-doc-store";
import type { DsClientOptions } from "@/mls/ds-client";
import type { ApiOptions } from "@/sync/api";

import {
  recordForgotten,
  recordOpened,
  recordOwnerSecret,
} from "@/directory/record";
import { createSpaceGroup } from "@/space/create-space";
import { forgetSpace, rememberCreatedSpace } from "@/space/space-links";

export interface NewProject {
  projectId: string;
  editToken: string;
  /** Edit secret for the `#` part of the edit link. */
  key: string;
}

/**
 * Fills a freshly initialized doc, e.g. with imported files. Assets it
 * stores go to the new project's blob store.
 */
export type ProjectSeed = (
  project: ProjectDoc,
  assets: ProjectAssets,
) => Promise<void>;

/**
 * Registers a project with the server and seeds its doc in this browser.
 * The server hands out ids and tokens and stores the project's MLS group and
 * keyring, which are created here and reach it sealed; the title and files
 * are written locally and reach it encrypted when the project is first
 * opened. Without a `seed`, the project starts with the starter main.typ.
 */
export async function createLocalProject(
  title: string,
  opts: ApiOptions & {
    backend?: DocBackend;
    seed?: ProjectSeed;
    ds?: Pick<DsClientOptions, "url" | "createSocket" | "retry">;
  } = {},
): Promise<NewProject> {
  const { created, key, link, group, backend } = await createSpaceGroup(opts);

  const doc = new LoroDoc();
  // Owns `link` once made; whichever holds it frees it below.
  let seedCrypto: SpaceCrypto | null = null;
  try {
    const store = new LocalDocStore(created.spaceId, doc, backend);
    // Load first: the store only writes what changed after it loaded.
    await store.load();
    const project = initProject(doc, { title, starter: !opts.seed });
    if (opts.seed) {
      seedCrypto = new SpaceCrypto(link, group.docKeys(), group.signer());
      const assets = projectAssets(created.editToken, seedCrypto, {
        baseUrl: opts.baseUrl,
      });
      await opts.seed(project, assets);
    }
    await store.flush();
  } catch (error) {
    group.free();
    throw error;
  } finally {
    if (seedCrypto) seedCrypto.free();
    else link.free();
    doc.free();
  }
  const ownerSecret = ownerSecretList(group.ownerSecrets())[0];
  group.free();

  // Only remembered once seeding worked, so a failed import leaves no
  // half-filled project behind in the project list.
  rememberCreatedSpace(created, key);
  await recordOpened(
    created.spaceId,
    { token: created.editToken, secret: key, edit: true },
    title,
  );
  // A fresh group holds exactly the one key the server was given.
  await recordOwnerSecret(created.spaceId, ownerSecret);
  return { projectId: created.spaceId, editToken: created.editToken, key };
}

/** Counterpart to createLocalProject. Leaves the server copy alone. */
export async function deleteLocalProject(
  projectId: string,
  opts: { backend?: DocBackend } = {},
): Promise<void> {
  forgetSpace(projectId);
  await recordForgotten(projectId);
  await (opts.backend ?? (await defaultBackend())).remove(projectId);
}
