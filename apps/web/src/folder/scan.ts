import { MAX_ASSET_BYTES } from "@/assets/project-assets";
import { MAX_IMPORT_ENTRIES, tooManyEntries } from "@/import/import";
import { mb } from "@/import/unzip-limits";

import type { FileStat, FolderFs } from "./folder-fs";
import { IGNORE_FILE, IgnoreRules, isCompiledPdf } from "./ignore";

export interface ScanOptions {
  maxEntries?: number;
  maxFileBytes?: number;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface ScanResult {
  files: Map<string, FileStat>;
  /**
   * Everything the walk saw on disk, synced or not, so a path missing from
   * `files` can be told apart from a deleted one. Files inside an ignored
   * folder aren't listed, but the folder is.
   */
  present: Set<string>;
  dirs: Set<string>;
  skipped: Skipped[];
  rules: IgnoreRules;
}

async function readText(fs: FolderFs, path: string): Promise<string> {
  return new TextDecoder().decode(await fs.read(path));
}

/**
 * Walks the folder once. Ignore files are read as the walk reaches their
 * folder, so a folder the rules exclude is never listed.
 */
export async function scanFolder(
  fs: FolderFs,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const maxEntries = opts.maxEntries ?? MAX_IMPORT_ENTRIES;
  const maxFileBytes = opts.maxFileBytes ?? MAX_ASSET_BYTES;
  const result: ScanResult = {
    files: new Map(),
    present: new Set(),
    dirs: new Set(),
    skipped: [],
    rules: new IgnoreRules(),
  };
  const { rules } = result;
  let seen = 0;

  const pending = [""];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const entries = await fs.readdir(dir);
    const names = new Set(entries.map((e) => e.name));
    if (dir === "") {
      const git = entries.find((e) => e.name === ".git" && e.kind === "dir");
      if (git) {
        const exclude = await fs.stat(".git/info/exclude");
        if (exclude) rules.addExclude(await readText(fs, ".git/info/exclude"));
      }
    }
    const prefix = dir === "" ? "" : `${dir}/`;
    const files: { gitignore?: string; typstryignore?: string } = {};
    for (const [key, name] of [
      ["gitignore", ".gitignore"],
      ["typstryignore", IGNORE_FILE],
    ] as const) {
      const entry = entries.find((e) => e.name === name && e.kind === "file");
      if (entry) files[key] = await readText(fs, entry.path);
    }
    rules.addDir(dir, files);

    // Sorted, so which entries make it under the cap does not depend on the
    // order the browser lists them in.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++seen > maxEntries) throw tooManyEntries();
      const path = prefix + entry.name;
      result.present.add(path);
      const isDir = entry.kind === "dir";
      const verdict = rules.classify(path, isDir);
      if (verdict.kind === "skipped") {
        result.skipped.push({ path, reason: verdict.reason });
        continue;
      }
      if (verdict.kind === "ignored") continue;
      if (isDir) {
        result.dirs.add(path);
        pending.push(path);
        continue;
      }
      if (isCompiledPdf(entry.name, names)) continue;
      const stat = await entry.stat!();
      if (stat.size > maxFileBytes) {
        result.skipped.push({
          path,
          reason: `larger than ${mb(maxFileBytes)} MB`,
        });
        continue;
      }
      result.files.set(path, stat);
    }
  }
  return result;
}
