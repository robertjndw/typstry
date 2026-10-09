import { LoroDoc } from "loro-crdt";
import { ProjectDoc } from "./schema";

export function newProject(peer: number | bigint): ProjectDoc {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  return new ProjectDoc(doc);
}

export function fork(source: ProjectDoc, peer: number | bigint): ProjectDoc {
  const project = newProject(peer);
  project.doc.import(source.doc.export({ mode: "snapshot" }));
  return project;
}

/** Exchanges missing updates in both directions. */
export function sync(...projects: ProjectDoc[]): void {
  for (const from of projects) {
    for (const to of projects) {
      if (from === to) continue;
      to.doc.import(
        from.doc.export({ mode: "update", from: to.doc.oplogVersion() }),
      );
    }
  }
}
