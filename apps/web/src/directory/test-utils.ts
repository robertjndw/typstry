import { LoroDoc } from "loro-crdt";

import { toBase64Url } from "@/crypto/bytes";

import { Directory, type NewLink } from "./directory";
import { directory } from "./store";

/** Far past every `addedAt` the directory tests use. Matches NOW in directory.rs tests. */
export const NOW = 1_000_000;

export function newDirectory(peer: number | bigint, init = true): Directory {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  const dir = new Directory(doc);
  if (init) dir.init();
  return dir;
}

/** A 22 character share token, distinct per `n`. */
export function token(n: number): string {
  return String(n).padStart(22, "0");
}

/** An edit secret: any 32 bytes are a seed. */
export function editSecret(fill = 1): string {
  return toBase64Url(new Uint8Array([1, ...new Array<number>(32).fill(fill)]));
}

// The Ed25519 base point, so the attestation key of a test view secret
// decompresses like a real one has to.
const BASE_POINT = [0x58, ...new Array<number>(31).fill(0x66)];

/** A view secret: a view key and a valid attestation key. */
export function viewSecret(fill = 1): string {
  return toBase64Url(
    new Uint8Array([2, ...new Array<number>(32).fill(fill), ...BASE_POINT]),
  );
}

export function link(
  n: number,
  projectId: string,
  over: Partial<NewLink> = {},
): NewLink {
  return {
    token: token(n),
    projectId,
    secret: editSecret(n),
    edit: true,
    addedAt: 100,
    ...over,
  };
}

/** Exchanges missing updates in both directions. */
export function sync(a: Directory, b: Directory): void {
  const fromA = a.doc.export({ mode: "update", from: b.doc.oplogVersion() });
  const fromB = b.doc.export({ mode: "update", from: a.doc.oplogVersion() });
  b.doc.import(fromA);
  a.doc.import(fromB);
}

/**
 * Puts a project in the page's directory with the n-th test token. Later
 * `openedAt` sorts first; it defaults to n so seeding in order lists the
 * last one first.
 */
export async function seedProject(
  projectId: string,
  n: number,
  opts: {
    title?: string;
    openedAt?: number;
    secret?: string;
    edit?: boolean;
  } = {},
): Promise<void> {
  const dir = await directory();
  dir.addLink(
    link(n, projectId, {
      secret: opts.secret ?? editSecret(n),
      edit: opts.edit ?? true,
    }),
  );
  dir.setTitle(projectId, opts.title ?? projectId);
  dir.touchOpened(projectId, opts.openedAt ?? n);
}
