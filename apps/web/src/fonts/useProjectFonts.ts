import {
  useCallback,
  useEffect,
  useReducer,
  useSyncExternalStore,
} from "react";
import type { TreeID } from "loro-crdt";

import type { ProjectAssets } from "@/assets/project-assets";
import { toError } from "@/lib/errors";
import { useProject } from "@/project/context";
import { projectIndex, type ProjectIndex } from "@/project/project-index";
import { isCompilerFont } from "@/typst/compiler-client";

import {
  isWoffPath,
  parseFontFaces,
  WoffError,
  type FontFaceInfo,
} from "./font-info";

export interface ProjectFontFace {
  path: string;
  nodeId: TreeID;
  hash: string;
  /** File size in bytes; shared by every face of a collection. */
  size: number;
  info: FontFaceInfo;
}

export interface FontFamilyGroup {
  /** The name to use in `#set text(font: ...)`. */
  family: string;
  /** Sorted by weight, then upright before italic. */
  faces: ProjectFontFace[];
}

export interface UnsupportedFont {
  path: string;
  nodeId: TreeID;
  hash: string;
}

export interface ProjectFonts {
  families: FontFamilyGroup[];
  /** Web fonts, which Typst cannot load. */
  unsupported: UnsupportedFont[];
  loading: boolean;
  /** Why a font file could not be read, by path. */
  errors: Record<string, string>;
  /** Plaintext bytes of an asset, for font samples. */
  load: (hash: string) => Promise<Uint8Array>;
}

interface Entry {
  path: string;
  nodeId: TreeID;
  hash: string;
}

type Parsed =
  | { ok: true; size: number; faces: FontFaceInfo[] }
  | { ok: false; woff: boolean; message: string };

interface CacheSlot {
  promise: Promise<Parsed>;
  settled?: Parsed;
}

// Keyed per ProjectAssets so two projects never share parsed fonts, and a
// closed project's entries go with it. The hash is content-addressed, so a
// replaced file simply misses.
const caches = new WeakMap<ProjectAssets, Map<string, CacheSlot>>();

function slotFor(assets: ProjectAssets, hash: string): CacheSlot {
  let cache = caches.get(assets);
  if (!cache) caches.set(assets, (cache = new Map()));
  let slot = cache.get(hash);
  if (!slot) {
    const created: CacheSlot = {
      promise: assets.load(hash).then(
        (bytes): Parsed => {
          try {
            return {
              ok: true,
              size: bytes.length,
              faces: parseFontFaces(bytes),
            };
          } catch (err) {
            return {
              ok: false,
              woff: err instanceof WoffError,
              message: toError(err).message,
            };
          }
        },
        (err): Parsed => {
          // Loading can fail for transient reasons, so retry on next use.
          cache!.delete(hash);
          return { ok: false, woff: false, message: toError(err).message };
        },
      ),
    };
    void created.promise.then((result) => {
      created.settled = result;
    });
    cache.set(hash, (slot = created));
  }
  return slot;
}

const snapshots = new WeakMap<ProjectIndex, Entry[]>();

function sameEntries(a: Entry[], b: Entry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) =>
        e.nodeId === b[i]!.nodeId &&
        e.path === b[i]!.path &&
        e.hash === b[i]!.hash,
    )
  );
}

// useSyncExternalStore needs a stable snapshot, but the index rebuilds its
// state on every read while nobody is subscribed.
function fontEntries(index: ProjectIndex): Entry[] {
  const next = [...index.state.assets.values()]
    .filter(({ path }) => isCompilerFont(path) || isWoffPath(path))
    .map(({ id, path, hash }) => ({ nodeId: id, path, hash }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const prev = snapshots.get(index);
  if (prev && sameEntries(prev, next)) return prev;
  snapshots.set(index, next);
  return next;
}

function compareFaces(a: ProjectFontFace, b: ProjectFontFace): number {
  return (
    a.info.weight - b.info.weight ||
    Number(a.info.italic) - Number(b.info.italic) ||
    a.path.localeCompare(b.path) ||
    a.info.index - b.info.index
  );
}

export function useProjectFonts(): ProjectFonts {
  const { project, assets } = useProject();
  const index = projectIndex(project);
  const entries = useSyncExternalStore(
    useCallback((notify) => index.subscribe(notify), [index]),
    () => fontEntries(index),
  );
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const load = useCallback(
    (hash: string) =>
      assets ? assets.load(hash) : Promise.reject(new Error("No file store")),
    [assets],
  );

  useEffect(() => {
    if (!assets) return;
    let cancelled = false;
    for (const entry of entries) {
      if (isWoffPath(entry.path)) continue;
      const slot = slotFor(assets, entry.hash);
      if (slot.settled) continue;
      void slot.promise.then(() => {
        if (!cancelled) bump();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [assets, entries]);

  const groups = new Map<string, FontFamilyGroup>();
  const unsupported: UnsupportedFont[] = [];
  const errors: Record<string, string> = {};
  let loading = false;

  for (const entry of entries) {
    if (isWoffPath(entry.path)) {
      unsupported.push(entry);
      continue;
    }
    if (!assets) continue;
    const parsed = slotFor(assets, entry.hash).settled;
    if (!parsed) {
      loading = true;
    } else if (!parsed.ok) {
      // A .ttf that is really a web font is as unusable as a .woff file.
      if (parsed.woff) unsupported.push(entry);
      else errors[entry.path] = parsed.message;
    } else {
      for (const info of parsed.faces) {
        let group = groups.get(info.typstFamily);
        if (!group) {
          groups.set(
            info.typstFamily,
            (group = { family: info.typstFamily, faces: [] }),
          );
        }
        group.faces.push({ ...entry, size: parsed.size, info });
      }
    }
  }

  const families = [...groups.values()]
    .map((group) => ({ ...group, faces: group.faces.sort(compareFaces) }))
    .sort((a, b) => a.family.localeCompare(b.family));

  return { families, unsupported, loading, errors, load };
}
