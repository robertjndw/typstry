import { LoroDoc } from "loro-crdt";

import { projectAssets, type ProjectAssets } from "@/assets/project-assets";
import { ProjectCrypto } from "@/crypto/project-crypto";
import { LinkSecret, ProjectGroup, loadWasm } from "@/crypto/wasm";
import { initProject, type ProjectDoc } from "@/doc/schema";
import {
  defaultBackend,
  LocalDocStore,
  type DocBackend,
} from "@/persist/local-doc-store";
import {
  encodeProfile,
  loadIdentity,
  provisionalIdentity,
} from "@/presence/identity";
import { localIdentity } from "@/mls/identity";
import { createGroup, type DsClientOptions } from "@/mls/ds-client";
import { createProject, type ApiOptions } from "@/sync/api";

import {
  forgetProject,
  rememberProject,
  rememberShare,
  saveProjectKey,
  saveShareLinks,
} from "./recent";

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
  await loadWasm();
  const created = await createProject(opts);
  const link = LinkSecret.generateEdit();
  const key = link.toBase64url();
  const backend = opts.backend ?? (await defaultBackend());
  const identity = await localIdentity(backend);
  const { group, message } = ProjectGroup.create(
    link,
    encodeProfile(loadIdentity() ?? provisionalIdentity()),
    identity.deviceSeed,
    identity.graph,
  );
  await createGroup(created.editToken, message, opts.ds);

  const doc = new LoroDoc();
  // The group exists on the server now, and this device is its first
  // member. Keeping it is what lets the creator follow the group (and
  // remove people from it) instead of joining their own project as a
  // newcomer on the first visit.
  await backend.saveMls(created.projectId, {
    state: group.exportState(),
    device: group.leafKeys().export(),
    removed: false,
    rotation: null,
    ownerPerson: group.ownerPerson(),
  });
  const store = new LocalDocStore(created.projectId, doc, backend);
  // Load first: the store only writes what changed after it loaded.
  await store.load();
  const project = initProject(doc, { title, starter: !opts.seed });
  if (opts.seed) {
    const assets = projectAssets(
      created.editToken,
      new ProjectCrypto(link, group.docKeys(), group.signer()),
      { baseUrl: opts.baseUrl },
    );
    await opts.seed(project, assets);
  }
  await store.flush();

  // Only remembered once seeding worked, so a failed import leaves no
  // half-filled project behind in the recent list.
  saveShareLinks(created.projectId, created);
  saveProjectKey(created.projectId, key);
  rememberShare(created.editToken, {
    projectId: created.projectId,
    permission: "write",
  });
  rememberShare(created.viewToken, {
    projectId: created.projectId,
    permission: "read",
  });
  rememberProject({
    projectId: created.projectId,
    token: created.editToken,
    title,
  });
  return { projectId: created.projectId, editToken: created.editToken, key };
}

/** Counterpart to createLocalProject. Leaves the server copy alone. */
export async function deleteLocalProject(
  projectId: string,
  opts: { backend?: DocBackend } = {},
): Promise<void> {
  forgetProject(projectId);
  await (opts.backend ?? (await defaultBackend())).remove(projectId);
}
