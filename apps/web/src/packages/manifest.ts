import { parse } from "smol-toml";

import { PackageError } from "./errors";
import { isIdent, parseVersion } from "./spec";
import { normalizeArchivePath } from "./tar";

export interface PackageManifest {
  name: string;
  version: string;
  entrypoint: string;
  authors?: string[];
  license?: string;
  description?: string;
  compiler?: string;
}

function string(
  table: Record<string, unknown>,
  key: string,
  required: boolean,
): string | undefined {
  const value = table[key];
  if (value === undefined) {
    if (required) throw new PackageError(`typst.toml has no ${key}.`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PackageError(`${key} in typst.toml must be a string.`);
  }
  return value;
}

/**
 * Reads the `[package]` table of a typst.toml. Only what the editor shows
 * or relies on is checked; anything else (`[tool]`, `[template]`, keys
 * added in later Typst versions) is none of our business.
 */
export function parseManifest(text: string): PackageManifest {
  let root: Record<string, unknown>;
  try {
    root = parse(text);
  } catch (err) {
    throw new PackageError(
      `typst.toml is not valid TOML: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
      err instanceof Error ? err : undefined,
    );
  }
  const table = root["package"];
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new PackageError("typst.toml has no [package] section.");
  }
  const pkg = table as Record<string, unknown>;

  const name = string(pkg, "name", true)!;
  if (!isIdent(name)) {
    throw new PackageError(
      `"${name}" is not a valid package name. Use letters, digits, - and _, starting with a letter.`,
    );
  }
  const version = string(pkg, "version", true)!;
  if (!parseVersion(version)) {
    throw new PackageError(
      `"${version}" is not a valid version. Use three numbers like 1.2.3.`,
    );
  }
  const rawEntry = string(pkg, "entrypoint", true)!;
  const entrypoint = normalizeArchivePath(rawEntry);
  if (!entrypoint) {
    throw new PackageError(
      `The entrypoint "${rawEntry}" must be a path inside the package.`,
    );
  }
  const compiler = string(pkg, "compiler", false);
  if (compiler !== undefined && !parseCompiler(compiler)) {
    throw new PackageError(`"${compiler}" is not a valid compiler version.`);
  }

  const manifest: PackageManifest = { name, version, entrypoint };
  const authors = pkg["authors"];
  if (Array.isArray(authors)) {
    manifest.authors = authors.filter(
      (a): a is string => typeof a === "string",
    );
  }
  const license = string(pkg, "license", false);
  if (license !== undefined) manifest.license = license;
  const description = string(pkg, "description", false);
  if (description !== undefined) manifest.description = description;
  if (compiler !== undefined) manifest.compiler = compiler;
  return manifest;
}

/** `0.12` is as valid for `compiler` as `0.12.0`. */
export function parseCompiler(value: string) {
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 3) return null;
  return parseVersion([...parts, "0", "0"].slice(0, 3).join("."));
}
