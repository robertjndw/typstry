import type { TreeID } from "loro-crdt";

import { freeName } from "@/assets/upload";
import { children, createFile } from "@/doc/fs-ops";
import { NODE, type ProjectDoc } from "@/doc/schema";
import { isCompilerFont } from "@/typst/compiler-client";

import { isWoffPath, parseFontFaces, type FontFaceInfo } from "./font-info";

export const FONTS_DIR = "fonts";

/** The root `fonts` folder, created when missing. */
export function ensureFontsDir(project: ProjectDoc): TreeID {
  const existing = children(project, null).find(
    (node) =>
      node.data.get(NODE.name) === FONTS_DIR &&
      node.data.get(NODE.kind) === "dir",
  );
  if (existing) return existing.id;
  // A file called "fonts" may be in the way; the folder gets "fonts (2)".
  return createFile(project, null, freeName(project, null, FONTS_DIR), "dir");
}

export interface FontPartition {
  /** Files the compiler loads. */
  ok: File[];
  /** Web fonts, which Typst cannot read. */
  woff: File[];
  other: File[];
}

export function partitionFontFiles(files: File[]): FontPartition {
  const out: FontPartition = { ok: [], woff: [], other: [] };
  for (const file of files) {
    if (isCompilerFont(file.name)) out.ok.push(file);
    else if (isWoffPath(file.name)) out.woff.push(file);
    else out.other.push(file);
  }
  return out;
}

/**
 * Parses `file` and returns its faces. Run this before uploading, so a
 * corrupt file never reaches the doc, where every collaborator would pass it
 * to the compiler.
 */
export async function validateFontFile(file: File): Promise<FontFaceInfo[]> {
  return parseFontFaces(new Uint8Array(await file.arrayBuffer()));
}
