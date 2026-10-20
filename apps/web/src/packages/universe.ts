import { concatBytes } from "@/crypto/bytes";

import { PackageError } from "./errors";
import { MAX_PACKAGE_ARCHIVE_BYTES, packageTooLarge } from "./archive-limit";
import {
  formatSpec,
  isIdent,
  parseVersion,
  universeArchiveUrl,
  type PackageSpec,
} from "./spec";

/** The .tar.gz of a Typst Universe package, exactly as published. */
export async function fetchUniverse(
  name: string,
  version: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const spec = formatSpec({ namespace: "preview", name, version });
  // Both end up in the URL, so they are checked rather than escaped.
  if (!isIdent(name) || !parseVersion(version)) {
    throw new PackageError(`${spec} is not a valid package spec.`);
  }
  let res: Response;
  try {
    res = await fetch(universeArchiveUrl(name, version), { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new PackageError(
      "Could not reach Typst Universe. Check your connection and try again.",
      err instanceof Error ? err : undefined,
    );
  }
  if (res.status === 404) {
    throw new PackageError(`No package ${spec} on Typst Universe.`);
  }
  if (!res.ok) {
    throw new PackageError(
      `Typst Universe answered with an error (${res.status}). Try again later.`,
    );
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_PACKAGE_ARCHIVE_BYTES) throw packageTooLarge();

  // Content-Length can be absent or wrong, so the bytes are counted too.
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_PACKAGE_ARCHIVE_BYTES) throw packageTooLarge();
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_PACKAGE_ARCHIVE_BYTES) {
        await reader.cancel();
        throw packageTooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PackageError || signal?.aborted) throw err;
    throw new PackageError(
      "The download from Typst Universe was interrupted. Try again.",
      err instanceof Error ? err : undefined,
    );
  }
  return concatBytes(chunks, total);
}

export interface PreviewImport extends PackageSpec {
  /** `@preview/name:1.2.3`. */
  spec: string;
  /** Files that mention it, sorted. */
  paths: string[];
}

const PREVIEW_IMPORT =
  /@preview\/([\p{XID_Start}_][\p{XID_Continue}_-]*):(\d+\.\d+\.\d+)(?![\w.])/gu;

/**
 * Every `@preview` package the sources refer to. A plain scan rather than a
 * parse: a mention in a comment or string only offers a pin the user can
 * ignore, and a miss costs more than a false hit.
 */
export function findPreviewImports(
  texts: Iterable<{ path: string; text: string }>,
): PreviewImport[] {
  const found = new Map<string, PreviewImport>();
  for (const { path, text } of texts) {
    for (const match of text.matchAll(PREVIEW_IMPORT)) {
      const [, name, version] = match as unknown as [string, string, string];
      if (!parseVersion(version)) continue;
      const spec = `@preview/${name}:${version}`;
      let entry = found.get(spec);
      if (!entry) {
        entry = { spec, namespace: "preview", name, version, paths: [] };
        found.set(spec, entry);
      }
      if (!entry.paths.includes(path)) entry.paths.push(path);
    }
  }
  for (const entry of found.values()) entry.paths.sort();
  return [...found.values()].sort((a, b) => (a.spec < b.spec ? -1 : 1));
}
