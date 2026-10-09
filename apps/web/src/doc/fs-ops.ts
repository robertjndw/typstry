import { LoroText, type LoroTreeNode, type TreeID } from "loro-crdt";

import { normalizeBounded } from "./names";
import {
  isFileKind,
  MAX_TITLE_CHARS,
  META,
  NODE,
  type AssetInfo,
  type FileKind,
  type ProjectDoc,
} from "./schema";

export type FsErrorCode =
  | "invalid-name"
  | "name-taken"
  | "not-found"
  | "not-a-directory"
  | "not-a-text-file"
  | "cycle";

export class FsError extends Error {
  readonly code: FsErrorCode;

  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}

const MAX_NAME_BYTES = 255;
// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function validateName(name: string): void {
  if (name === "") throw new FsError("invalid-name", "Name must not be empty");
  if (name === "." || name === "..")
    throw new FsError("invalid-name", `"${name}" is reserved`);
  if (name.includes("/"))
    throw new FsError("invalid-name", 'Name must not contain "/"');
  if (CONTROL_CHARS.test(name)) {
    throw new FsError(
      "invalid-name",
      "Name must not contain control characters",
    );
  }
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
    throw new FsError(
      "invalid-name",
      `Name must be at most ${MAX_NAME_BYTES} bytes`,
    );
  }
}

function liveNode(project: ProjectDoc, id: TreeID): LoroTreeNode {
  const node = project.liveNode(id);
  if (!node) throw new FsError("not-found", `No such file: ${id}`);
  return node;
}

function kindOf(node: LoroTreeNode): FileKind | null {
  const kind: unknown = node.data.get(NODE.kind);
  return isFileKind(kind) ? kind : null;
}

function assertDir(project: ProjectDoc, parent: TreeID | null): void {
  if (parent === null) return;
  if (kindOf(liveNode(project, parent)) !== "dir") {
    throw new FsError("not-a-directory", `Not a directory: ${parent}`);
  }
}

/** Live nodes directly under `parent` (null for the root). */
export function children(
  project: ProjectDoc,
  parent: TreeID | null,
): LoroTreeNode[] {
  return (
    (parent === null
      ? project.fs.roots()
      : liveNode(project, parent).children()) ?? []
  );
}

// Only checks what this replica sees. Concurrent creates of the same name
// on different peers still clash after merging; paths.ts disambiguates those.
function assertNameFree(
  project: ProjectDoc,
  parent: TreeID | null,
  name: string,
  except?: TreeID,
): void {
  for (const sibling of children(project, parent)) {
    if (sibling.id !== except && sibling.data.get(NODE.name) === name) {
      throw new FsError("name-taken", `"${name}" already exists`);
    }
  }
}

function prepareCreate(
  project: ProjectDoc,
  parent: TreeID | null,
  name: string,
): LoroTreeNode {
  validateName(name);
  assertDir(project, parent);
  assertNameFree(project, parent, name);
  return project.fs.createNode(parent ?? undefined);
}

export function createFile(
  project: ProjectDoc,
  parent: TreeID | null,
  name: string,
  kind: "text" | "dir",
  /** Initial text, written in the same commit so peers never see it empty. */
  content?: string,
): TreeID {
  const node = prepareCreate(project, parent, name);
  node.data.set(NODE.kind, kind);
  node.data.set(NODE.name, name);
  if (kind === "text") {
    const text = node.data.setContainer(NODE.content, new LoroText());
    if (content) text.insert(0, content);
  }
  project.doc.commit({ message: `create ${kind} ${name}` });
  return node.id;
}

export function createAsset(
  project: ProjectDoc,
  parent: TreeID | null,
  name: string,
  asset: AssetInfo,
): TreeID {
  const node = prepareCreate(project, parent, name);
  node.data.set(NODE.kind, "asset");
  node.data.set(NODE.name, name);
  node.data.set(NODE.hash, asset.hash);
  node.data.set(NODE.size, asset.size);
  node.data.set(NODE.mime, asset.mime);
  project.doc.commit({ message: `create asset ${name}` });
  return node.id;
}

export function rename(project: ProjectDoc, id: TreeID, name: string): void {
  validateName(name);
  const node = liveNode(project, id);
  assertNameFree(project, node.parent()?.id ?? null, name, id);
  node.data.set(NODE.name, name);
  project.doc.commit({ message: `rename to ${name}` });
}

export function move(
  project: ProjectDoc,
  id: TreeID,
  parent: TreeID | null,
): void {
  const node = liveNode(project, id);
  if ((node.parent()?.id ?? null) === parent) return;
  // Loro happily moves a node under a deleted parent, which would silently
  // delete it, so the target has to be checked here.
  assertDir(project, parent);
  const name: unknown = node.data.get(NODE.name);
  if (typeof name === "string") assertNameFree(project, parent, name, id);
  try {
    project.fs.move(id, parent ?? undefined);
  } catch (err) {
    // Loro throws a plain string here, not an Error.
    if (String(err).includes("Cycle move")) {
      throw new FsError("cycle", "Cannot move a folder into itself");
    }
    throw err;
  }
  project.doc.commit({ message: "move" });
}

function isSameOrAncestor(
  project: ProjectDoc,
  ancestor: TreeID,
  id: TreeID,
): boolean {
  for (let node = project.fs.getNodeByID(id); node; node = node.parent()) {
    if (node.id === ancestor) return true;
  }
  return false;
}

export function deleteNode(project: ProjectDoc, id: TreeID): void {
  liveNode(project, id);
  const main = project.mainFile;
  if (main !== null && isSameOrAncestor(project, id, main)) {
    project.meta.set(META.mainFile, null);
  }
  project.fs.delete(id);
  project.doc.commit({ message: "delete" });
}

export function setMainFile(project: ProjectDoc, id: TreeID | null): void {
  if (id !== null && kindOf(liveNode(project, id)) !== "text") {
    throw new FsError("not-a-text-file", `Not a text file: ${id}`);
  }
  project.meta.set(META.mainFile, id);
  project.doc.commit({ message: "set main file" });
}

export function getText(project: ProjectDoc, id: TreeID): LoroText {
  const node = liveNode(project, id);
  const content: unknown = node.data.get(NODE.content);
  if (kindOf(node) !== "text" || !(content instanceof LoroText)) {
    throw new FsError("not-a-text-file", `Not a text file: ${id}`);
  }
  return content;
}

/**
 * Trims a project title and checks it against the server's limit (counted
 * in code points, like Rust's `chars()`). Returns null when it is unusable.
 */
export function normalizeTitle(raw: string): string | null {
  return normalizeBounded(raw, MAX_TITLE_CHARS);
}

export function setTitle(project: ProjectDoc, raw: string): void {
  const title = normalizeTitle(raw);
  if (title === null) {
    throw new FsError(
      "invalid-name",
      `Title must be 1 to ${MAX_TITLE_CHARS} characters`,
    );
  }
  if (title === project.title) return;
  project.meta.set(META.title, title);
  project.doc.commit({ message: "rename project" });
}
