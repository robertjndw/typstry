// Imported from here by the workers too, so nothing in this file may touch
// the DOM or pull in the doc layer.

/** Key of a package in ROOT.packages. */
export function packageKey(pkg: PackageSpec): string {
  return `${pkg.namespace}/${pkg.name}/${pkg.version}`;
}

/** Where Typst Universe publishes a `@preview` package's .tar.gz. */
export function universeArchiveUrl(name: string, version: string): string {
  return `https://packages.typst.org/preview/${name}-${version}.tar.gz`;
}

/** The Typst version the editor compiles with. */
export const TYPST_VERSION = "0.15.0";

export interface PackageSpec {
  namespace: string;
  name: string;
  version: string;
}

/** Typst's identifier rules, which package and namespace names follow. */
export function isIdent(value: string): boolean {
  return /^[\p{XID_Start}_][\p{XID_Continue}_-]*$/u.test(value);
}

export type Version = [major: number, minor: number, patch: number];

const U32_MAX = 4_294_967_295;

/** Exactly three numeric parts; Typst rejects prereleases and build tags. */
export function parseVersion(value: string): Version | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((n) => n > U32_MAX)) return null;
  return parts as Version;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** `@preview/cetz:0.4.2`, the form used in `#import`. */
export function parseSpec(spec: string): PackageSpec | null {
  const match = /^@([^/:\s]+)\/([^/:\s]+):(\S+)$/.exec(spec);
  if (!match) return null;
  const [, namespace, name, version] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (!isIdent(namespace) || !isIdent(name) || !parseVersion(version)) {
    return null;
  }
  return { namespace, name, version };
}

/**
 * What people type into the pin field: a full spec, or the shorter
 * `cetz:0.4.2` / `cetz 0.4.2` / `@preview/cetz 0.4.2`, which mean the
 * preview namespace unless one is given.
 */
export function parsePinInput(input: string): PackageSpec | null {
  const text = input.trim();
  const full = parseSpec(text);
  if (full) return full;
  const match = /^(?:@?([^/\s:]+)\/)?([^/\s:]+)[\s:]+v?(\S+)$/.exec(text);
  if (!match) return null;
  return parseSpec(`@${match[1] ?? "preview"}/${match[2]}:${match[3]}`);
}

export function formatSpec(pkg: PackageSpec): string {
  return `@${pkg.namespace}/${pkg.name}:${pkg.version}`;
}

export function importSnippet(pkg: PackageSpec): string {
  return `#import "${formatSpec(pkg)}": *`;
}
