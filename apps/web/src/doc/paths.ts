// Path derivation shared with crates/typstry-doc/src/paths.rs. Both sides
// must produce byte-identical paths for the same doc state; the fixture test
// in fixture.test.ts and crates/typstry-doc/tests/fixture.rs guards that.
import type { LoroDoc, TreeID } from "loro-crdt";
import { stemLength } from "./names";
import { isFileKind, NODE, ProjectDoc, type FileKind } from "./schema";

export interface PathEntry {
  path: string;
  kind: FileKind;
  /** True when the node lost a same-name clash and shows a derived name. */
  renamed: boolean;
}

export interface PathIndex {
  byPath: Map<string, TreeID>;
  byId: Map<TreeID, PathEntry>;
}

export interface ParsedTreeId {
  peer: bigint;
  counter: number;
}

export function parseTreeId(id: TreeID): ParsedTreeId {
  const at = id.indexOf("@");
  return { counter: Number(id.slice(0, at)), peer: BigInt(id.slice(at + 1)) };
}

/** Orders by peer as an unsigned 64-bit integer, then by counter. */
export function compareTreeIds(a: TreeID, b: TreeID): number {
  const pa = parseTreeId(a);
  const pb = parseTreeId(b);
  if (pa.peer !== pb.peer) return pa.peer < pb.peer ? -1 : 1;
  return pa.counter - pb.counter;
}

/**
 * Name shown for a node that lost a same-name clash: "main.typ" with id
 * 3@42 becomes "main~3@42.typ". A leading dot does not start an extension,
 * so ".gitignore" becomes ".gitignore~3@42".
 */
export function disambiguatedName(name: string, id: TreeID): string {
  const { peer, counter } = parseTreeId(id);
  const split = stemLength(name);
  return `${name.slice(0, split)}~${counter}@${peer}${name.slice(split)}`;
}

interface LiveNode {
  id: TreeID;
  name: string;
  kind: FileKind;
}

/**
 * Derives every live node's path. Nodes whose metadata has no valid name or
 * kind are skipped together with their subtree; our own ops never produce
 * them, so they can only come from a broken or foreign client.
 */
export function buildPathIndex(source: LoroDoc | ProjectDoc): PathIndex {
  const project =
    source instanceof ProjectDoc ? source : new ProjectDoc(source);
  const children = new Map<TreeID | null, LiveNode[]>();
  for (const node of project.fs.getNodes()) {
    const name: unknown = node.data.get(NODE.name);
    const kind: unknown = node.data.get(NODE.kind);
    if (typeof name !== "string" || name === "" || !isFileKind(kind)) continue;
    const parent = node.parent()?.id ?? null;
    let list = children.get(parent);
    if (!list) children.set(parent, (list = []));
    list.push({ id: node.id, name, kind });
  }

  const index: PathIndex = { byPath: new Map(), byId: new Map() };
  const stack: { parent: TreeID | null; prefix: string }[] = [
    { parent: null, prefix: "" },
  ];
  while (stack.length > 0) {
    const { parent, prefix } = stack.pop()!;
    for (const { node, name, renamed } of resolveSiblingNames(
      children.get(parent) ?? [],
    )) {
      const path = prefix + name;
      index.byPath.set(path, node.id);
      index.byId.set(node.id, { path, kind: node.kind, renamed });
      if (node.kind === "dir")
        stack.push({ parent: node.id, prefix: path + "/" });
    }
  }
  return index;
}

function resolveSiblingNames(
  siblings: LiveNode[],
): { node: LiveNode; name: string; renamed: boolean }[] {
  const groups = new Map<string, LiveNode[]>();
  for (const node of siblings) {
    const group = groups.get(node.name);
    if (group) group.push(node);
    else groups.set(node.name, [node]);
  }
  const out: { node: LiveNode; name: string; renamed: boolean }[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => compareTreeIds(a.id, b.id));
    group.forEach((node, i) => {
      // A derived name could in theory equal a real sibling's name (someone
      // literally named a file "main~3@42.typ"). That is vanishingly rare and
      // left unresolved; only one of the two ends up in byPath.
      out.push(
        i === 0
          ? { node, name: node.name, renamed: false }
          : {
              node,
              name: disambiguatedName(node.name, node.id),
              renamed: true,
            },
      );
    });
  }
  return out;
}
