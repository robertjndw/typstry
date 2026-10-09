import { LoroDoc } from "loro-crdt";

import { generateRawProjectKey } from "@/crypto/project-key";
import { initProject } from "@/doc/schema";
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
  /** Raw key for the `#` part of share links. */
  key: string;
}

/**
 * Registers a project with the server and seeds its doc in this browser.
 * The server only hands out ids and tokens; the title and starter file are
 * written locally and reach it encrypted when the project is first opened.
 */
export async function createLocalProject(
  title: string,
  opts: ApiOptions & { backend?: DocBackend } = {},
): Promise<NewProject> {
  const created = await createProject(opts);
  const key = generateRawProjectKey();
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

  const doc = new LoroDoc();
  const store = new LocalDocStore(
    created.projectId,
    doc,
    opts.backend ?? (await defaultBackend()),
  );
  // Load first: the store only writes what changed after it loaded.
  await store.load();
  initProject(doc, { title });
  await store.flush();

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
