// Three-way merge of a text file: the base is the doc as of the last sync,
// the disk text is "their" edit and the live doc holds ours. The disk edit
// is replayed as ordinary Loro ops on a fork of the base, so merging it
// back behaves like a collaborator who typed it concurrently.
import { LoroDoc, LoroText, type OpId, type TreeID } from "loro-crdt";

import { buildPathIndex } from "@/doc/paths";
import { NODE, ProjectDoc } from "@/doc/schema";

import { replaceText } from "./apply";
import { fileOf } from "./materialize";

/**
 * The text of `path` after merging `diskText` into the live doc, or null
 * when the base has no such file or it is another node than `liveNodeId`
 * (replaced or recreated since). The caller then treats the file as a
 * conflict. Nothing is written to `doc`; the caller applies the result.
 */
export function mergeText(
  doc: LoroDoc,
  basePin: OpId[],
  path: string,
  diskText: string,
  liveNodeId: TreeID,
): string | null {
  // forkAt and fork both start on a fresh random peer, so the ops written
  // here can never collide with ones from this or any other replica.
  const baseDoc = doc.forkAt(basePin);
  let live: LoroDoc | null = null;
  try {
    const baseIndex = buildPathIndex(baseDoc);
    const id = baseIndex.byPath.get(path);
    if (id === undefined || id !== liveNodeId) return null;
    if (baseIndex.byId.get(id)?.kind !== "text") return null;

    const baseNode = new ProjectDoc(baseDoc).liveNode(id);
    const content: unknown = baseNode?.data.get(NODE.content);
    if (!(content instanceof LoroText)) return null;
    replaceText(content, diskText);
    baseDoc.commit();

    live = doc.fork();
    live.import(baseDoc.export({ mode: "update", from: live.oplogVersion() }));
    const merged = fileOf(live, id, "text");
    return merged?.kind === "text" ? merged.text : null;
  } finally {
    baseDoc.free();
    live?.free();
  }
}

/**
 * Three-way merge of plain texts, for when no doc version holds `base`.
 * Both edits are replayed on forks of a scratch doc, so concurrent changes
 * to different places combine like they do between two collaborators.
 */
export function mergeTexts(base: string, ours: string, theirs: string): string {
  const scratch = new LoroDoc();
  scratch.getText("t").insert(0, base);
  scratch.commit();
  const a = scratch.fork();
  const b = scratch.fork();
  try {
    replaceText(a.getText("t"), ours);
    a.commit();
    replaceText(b.getText("t"), theirs);
    b.commit();
    a.import(b.export({ mode: "update", from: a.oplogVersion() }));
    return a.getText("t").toString();
  } finally {
    scratch.free();
    a.free();
    b.free();
  }
}
