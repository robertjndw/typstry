import { LoroDoc } from "loro-crdt";

import { projectAssets, type ProjectAssets } from "@/assets/project-assets";
import { generateEditSecret, importProjectKey } from "@/crypto/project-key";
import { initProject, type ProjectDoc } from "@/doc/schema";
import {
  defaultBackend,
  LocalDocStore,
  type DocBackend,
} from "@/persist/local-doc-store";
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
 * The server only hands out ids and tokens; the title and files are written
 * locally and reach it encrypted when the project is first opened. Without
 * a `seed`, the project starts with the starter main.typ.
 */
export async function createLocalProject(
  title: string,
  opts: ApiOptions & { backend?: DocBackend; seed?: ProjectSeed } = {},
): Promise<NewProject> {
  const created = await createProject(opts);
  const key = generateEditSecret();

  const doc = new LoroDoc();
  const backend = opts.backend ?? (await defaultBackend());
  const store = new LocalDocStore(created.projectId, doc, backend);
  // Load first: the store only writes what changed after it loaded.
  await store.load();
  const project = initProject(doc, { title, starter: !opts.seed });
  if (opts.seed) {
    const assets = projectAssets(
      created.editToken,
      await importProjectKey(key),
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
