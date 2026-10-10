// Edit history as a list of "sessions": runs of changes close together in
// time. The grouping itself is pure (groupChanges) so it can be tested with
// hand-made timestamps; computeHistory feeds it from a real doc.
//
// Limits: everything here is O(changes) and runs on the main thread.
// getAllChanges() materializes every change, and file counts ask Loro for
// the containers each change touched. Thanks to the change merge interval
// (schema.ts) a long typing session is a few changes per minute, so even
// years of history stay in the tens of thousands. Callers compute lazily
// and memoize by version (see useHistory).
import type { ContainerID, LoroDoc, OpId, PeerID, TreeID } from "loro-crdt";

import { NODE, ROOT, type ProjectDoc } from "./schema";
import { listVersions, type NamedVersion } from "./versions";

export interface ChangeInfo {
  peer: PeerID;
  counter: number;
  /** Number of ops; the change covers counters [counter, counter + length). */
  length: number;
  lamport: number;
  /** Unix seconds, 0 when the author did not record a time. */
  timestamp: number;
  deps: OpId[];
  /**
   * Bookkeeping rather than an edit: it only touched the peers map or the
   * named versions. See groupChanges for how that is treated.
   */
  meta?: boolean;
}

export interface GroupingOptions {
  /** A pause longer than this starts a new group. */
  gapMs: number;
  /** A group never spans more than this. */
  maxSpanMs: number;
}

export const DEFAULT_GROUPING: GroupingOptions = {
  gapMs: 5 * 60_000,
  maxSpanMs: 30 * 60_000,
};

export interface ChangeGroup {
  /** `counter@peer` of the group's first change; stable across clients. */
  id: string;
  /** Unix ms, or null for changes from before timestamps were recorded. */
  start: number | null;
  end: number | null;
  /** Sorted by how many changes they made in this group, then by id. */
  authors: PeerID[];
  /** The version after this group, including everything ordered before it. */
  frontiers: OpId[];
  changes: ChangeInfo[];
}

function comparePeers(a: PeerID, b: PeerID): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Orders changes so that every prefix is causally closed, then splits them
 * into groups. The result is oldest first and depends only on the set of
 * changes, so every client computes the same groups.
 *
 * Clocks of different peers disagree, so a change can carry an earlier
 * timestamp than one it depends on. Each change is therefore placed at its
 * "effective" time, the latest timestamp among itself and its ancestors.
 * That keeps the order causal, and it also attaches changes without a
 * timestamp (old data) to whatever came before them. Untimed changes with
 * no timed ancestor end up in a leading group with an unknown time.
 */
export function groupChanges(
  input: readonly ChangeInfo[],
  options: GroupingOptions = DEFAULT_GROUPING,
  /**
   * Versions (tags) a group should end at when the history passes through
   * them exactly, so that a tagged state is a group boundary rather than a
   * point somewhere inside a group.
   */
  cuts: readonly OpId[][] = [],
): ChangeGroup[] {
  const cutKeys = new Set(cuts.map(frontiersKey));
  const byPeer = new Map<PeerID, ChangeInfo[]>();
  for (const change of input) {
    let list = byPeer.get(change.peer);
    if (!list) byPeer.set(change.peer, (list = []));
    list.push(change);
  }
  for (const list of byPeer.values())
    list.sort((a, b) => a.counter - b.counter);

  const changeOf = (id: OpId): ChangeInfo | undefined => {
    const list = byPeer.get(id.peer);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = list[mid]!;
      if (id.counter < c.counter) hi = mid - 1;
      else if (id.counter >= c.counter + c.length) lo = mid + 1;
      else return c;
    }
    return undefined;
  };

  // Lamport timestamps grow along every dependency edge, so this visits
  // deps before dependents.
  const causal = [...input].sort(
    (a, b) => a.lamport - b.lamport || comparePeers(a.peer, b.peer),
  );
  const effective = new Map<ChangeInfo, number>();
  for (const change of causal) {
    let time = change.timestamp;
    for (const dep of change.deps) {
      const parent = changeOf(dep);
      if (parent) time = Math.max(time, effective.get(parent) ?? 0);
    }
    // Same-peer predecessors are implied rather than listed as deps.
    const own = changeOf({ peer: change.peer, counter: change.counter - 1 });
    if (own) time = Math.max(time, effective.get(own) ?? 0);
    effective.set(change, time);
  }

  const ordered = [...input].sort(
    (a, b) =>
      effective.get(a)! - effective.get(b)! ||
      a.lamport - b.lamport ||
      comparePeers(a.peer, b.peer) ||
      a.counter - b.counter,
  );

  const groups: ChangeGroup[] = [];
  // Per peer: last included counter, and the highest counter of that peer
  // that some other included change depends on. A peer's last op is part of
  // the frontiers unless another included change already depends on it.
  const last = new Map<PeerID, number>();
  const depended = new Map<PeerID, number>();
  let current: { changes: ChangeInfo[]; first: number; prev: number } | null =
    null;

  const currentFrontiers = (): OpId[] => {
    const frontiers: OpId[] = [];
    for (const [peer, counter] of last) {
      if ((depended.get(peer) ?? -1) < counter)
        frontiers.push({ peer, counter });
    }
    return frontiers.sort((a, b) => comparePeers(a.peer, b.peer));
  };
  // Set once the group reached a cut. The group only closes at the next
  // edit, so bookkeeping that follows the tag (saving it) stays inside.
  let cutReached = false;

  const close = () => {
    cutReached = false;
    if (!current) return;
    const frontiers = currentFrontiers();
    const counts = new Map<PeerID, number>();
    const edits = current.changes.filter((c) => !c.meta);
    for (const c of edits.length > 0 ? edits : current.changes)
      counts.set(c.peer, (counts.get(c.peer) ?? 0) + 1);
    const authors = [...counts.keys()].sort(
      (a, b) => counts.get(b)! - counts.get(a)! || comparePeers(a, b),
    );
    const first = current.changes[0]!;
    groups.push({
      id: `${first.counter}@${first.peer}`,
      start: current.first > 0 ? current.first * 1000 : null,
      end: current.prev > 0 ? current.prev * 1000 : null,
      authors,
      frontiers,
      changes: current.changes,
    });
    current = null;
  };

  const include = (change: ChangeInfo) => {
    const end = change.counter + change.length - 1;
    last.set(change.peer, Math.max(last.get(change.peer) ?? -1, end));
    for (const dep of change.deps) {
      if (dep.peer === change.peer) continue;
      depended.set(
        dep.peer,
        Math.max(depended.get(dep.peer) ?? -1, dep.counter),
      );
    }
    if (cutKeys.size > 0 && cutKeys.has(frontiersKey(currentFrontiers())))
      cutReached = true;
  };

  for (const change of ordered) {
    const time = effective.get(change)!;
    // Bookkeeping comes after the edits it belongs to: saving a version, or
    // a page load recording the name again (every load is a new peer). If it
    // could extend a session, open one or count as authorship, the same edits
    // would show up again as a newer session above their version.
    if (change.meta && current) {
      current.changes.push(change);
      include(change);
      continue;
    }
    if (
      current &&
      (cutReached ||
        time - current.prev > options.gapMs / 1000 ||
        time - current.first > options.maxSpanMs / 1000 ||
        // Never mix unknown and known times in one group.
        (current.first === 0) !== (time === 0))
    ) {
      close();
    }
    current ??= { changes: [], first: time, prev: time };
    current.changes.push(change);
    current.prev = time;
    include(change);
  }
  close();
  return groups;
}

function frontiersKey(frontiers: readonly OpId[]): string {
  return frontiers
    .map((id) => `${id.counter}@${id.peer}`)
    .sort()
    .join(",");
}

export function readChanges(doc: LoroDoc): ChangeInfo[] {
  const out: ChangeInfo[] = [];
  for (const changes of doc.getAllChanges().values()) {
    for (const c of changes) {
      out.push({
        peer: c.peer,
        counter: c.counter,
        length: c.length,
        lamport: c.lamport,
        timestamp: c.timestamp,
        deps: c.deps,
      });
    }
  }
  return out;
}

export interface HistoryEntry extends ChangeGroup {
  /** Files whose name, metadata or content changed (not pure moves). */
  files: TreeID[];
}

/**
 * Maps container ids to the file node they belong to: the node's own data
 * map and its text content. Deleted nodes are included so that edits made
 * before a deletion still count.
 */
function containerOwners(project: ProjectDoc): Map<ContainerID, TreeID> {
  const owners = new Map<ContainerID, TreeID>();
  for (const node of project.fs.getNodes({ withDeleted: true })) {
    owners.set(node.data.id, node.id);
    const content: unknown = node.data.get(NODE.content);
    if (content && typeof content === "object" && "id" in content) {
      owners.set((content as { id: ContainerID }).id, node.id);
    }
  }
  return owners;
}

/** Root containers whose changes are bookkeeping, not edits. */
const META_CONTAINERS: ReadonlySet<string> = new Set(
  [
    { name: ROOT.peers, type: "Map" },
    { name: ROOT.versions, type: "List" },
    { name: ROOT.deletedVersions, type: "Map" },
  ].map(({ name, type }) => `cid:root-${name}:${type}`),
);

function changedContainers(doc: LoroDoc, change: ChangeInfo): ContainerID[] {
  return doc.getChangedContainersIn(
    { peer: change.peer, counter: change.counter },
    change.length,
  );
}

function isMeta(containers: readonly ContainerID[]): boolean {
  return (
    containers.length > 0 && containers.every((id) => META_CONTAINERS.has(id))
  );
}

/**
 * The tag on the revision that `frontiers` (by default the current state)
 * belongs to, if any. Tagging itself, and other bookkeeping, adds changes
 * of its own, so a tag still names the state as long as nothing but
 * bookkeeping happened between it and `frontiers`.
 */
export function tagAt(
  project: ProjectDoc,
  frontiers?: OpId[],
): NamedVersion | undefined {
  const { doc } = project;
  doc.commit();
  const target = frontiers ?? doc.oplogFrontiers();
  const targetVV = doc.frontiersToVV(target);
  let changes: ChangeInfo[] | null = null;
  // Newest first: the most recent tag is the likeliest match.
  for (const version of listVersions(project).reverse()) {
    let cmp: number | undefined;
    try {
      cmp = doc.cmpFrontiers(version.frontiers, target);
    } catch {
      continue; // frontiers this doc never saw
    }
    if (cmp !== 0 && cmp !== -1) continue;
    const versionVV = doc.frontiersToVV(version.frontiers);
    changes ??= readChanges(doc);
    const onlyMetaSince = changes.every((c) => {
      const inTarget = (targetVV.get(c.peer) ?? 0) > c.counter;
      const inVersion = (versionVV.get(c.peer) ?? 0) > c.counter;
      return !inTarget || inVersion || isMeta(changedContainers(doc, c));
    });
    if (onlyMetaSince) return version;
  }
  return undefined;
}

/** Groups the whole history of `project`, oldest first. */
export function computeHistory(
  project: ProjectDoc,
  options: GroupingOptions = DEFAULT_GROUPING,
  /** Tagged versions, which become group boundaries; see groupChanges. */
  cuts: readonly OpId[][] = [],
): HistoryEntry[] {
  const { doc } = project;
  // getChangedContainersIn commits implicitly; do it once, up front, so a
  // pending local edit is not split at an arbitrary point.
  doc.commit();
  const touched = new Map<string, ContainerID[]>();
  const changes = readChanges(doc).map((c) => {
    const containers = changedContainers(doc, c);
    touched.set(`${c.counter}@${c.peer}`, containers);
    return isMeta(containers) ? { ...c, meta: true } : c;
  });
  const groups = groupChanges(changes, options, cuts);
  const owners = containerOwners(project);
  return groups.map((group) => {
    const files = new Set<TreeID>();
    for (const c of group.changes) {
      for (const cid of touched.get(`${c.counter}@${c.peer}`)!) {
        const owner = owners.get(cid);
        if (owner) files.add(owner);
      }
    }
    return { ...group, files: [...files] };
  });
}
