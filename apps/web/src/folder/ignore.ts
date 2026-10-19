import { isReservedName, isSafePath } from "@/doc/fs-ops";
import { JUNK_DIRS, JUNK_NAMES } from "@/import/unzip-limits";

import { CASE_PROBE_PREFIX } from "./folder-fs";
import { GitignoreFile, parseGitignore } from "./gitignore";

export const IGNORE_FILE = ".typstryignore";

/**
 * Files that configure git or the checkout rather than belong to the
 * document. Not synced unless `.typstryignore` re-includes them (`!.gitignore`).
 * Same list as the CLI.
 */
export const GIT_FILES = [
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".github",
  IGNORE_FILE,
];

export const GIT_FILE_REASON =
  "git file, not synced by default (opt in with a !pattern in .typstryignore)";

export type PathVerdict =
  { kind: "sync" } | { kind: "ignored" } | { kind: "skipped"; reason: string };

const SYNC: PathVerdict = { kind: "sync" };
const IGNORED: PathVerdict = { kind: "ignored" };

export function isGitFile(name: string): boolean {
  const lower = name.toLowerCase();
  return GIT_FILES.some((file) => file === lower);
}

/** Names nobody wants synced and nobody needs to hear about. */
function isAlwaysIgnoredName(name: string): boolean {
  return (
    isReservedName(name) ||
    JUNK_NAMES.has(name) ||
    JUNK_DIRS.has(name) ||
    name.endsWith(".crswap") ||
    name.startsWith(CASE_PROBE_PREFIX)
  );
}

/**
 * Web-only rule: a `X.pdf` next to `X.typ` is most likely the compiled
 * output of that document, which would only churn the project. `siblings`
 * are the names in the same folder.
 */
export function isCompiledPdf(
  name: string,
  siblings: ReadonlySet<string>,
): boolean {
  if (!/\.pdf$/i.test(name)) return false;
  return siblings.has(`${name.slice(0, -4)}.typ`);
}

/**
 * Which paths of the folder are synced. Ignore files are added as the scan
 * walks down, outermost first: a later file is more specific and wins, and
 * within a folder `.typstryignore` wins over `.gitignore`.
 */
export class IgnoreRules {
  private readonly matchers: GitignoreFile[] = [];
  private readonly optIns: GitignoreFile[] = [];

  /** `.git/info/exclude`: lowest priority, patterns relative to the root. */
  addExclude(text: string): void {
    this.matchers.unshift(parseGitignore(text, ""));
  }

  /** The ignore files found in `dir` ("" for the root), if any. */
  addDir(dir: string, files: { gitignore?: string; typstryignore?: string }) {
    if (files.gitignore !== undefined) {
      this.matchers.push(parseGitignore(files.gitignore, dir));
    }
    if (files.typstryignore !== undefined) {
      const rules = parseGitignore(files.typstryignore, dir);
      this.matchers.push(rules);
      this.optIns.push(rules);
    }
  }

  /**
   * Whether `path` is synced. Checks every folder on the way too, since
   * nothing inside an ignored folder can be re-included.
   */
  classify(path: string, isDir: boolean): PathVerdict {
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const last = i === segments.length - 1;
      const sub = segments.slice(0, i + 1).join("/");
      const dir = isDir || !last;
      if (isAlwaysIgnoredName(segments[i]!)) return IGNORED;
      if (isGitFile(segments[i]!) && !this.optedIn(sub, dir)) {
        return { kind: "skipped", reason: GIT_FILE_REASON };
      }
      if (this.ignoredByFiles(sub, dir)) return IGNORED;
    }
    if (!isSafePath(path)) {
      return { kind: "skipped", reason: "name not allowed in a project" };
    }
    return SYNC;
  }

  private ignoredByFiles(path: string, isDir: boolean): boolean {
    for (let i = this.matchers.length - 1; i >= 0; i--) {
      const verdict = this.matchers[i]!.match(path, isDir);
      if (verdict) return verdict === "ignore";
    }
    return false;
  }

  /**
   * Whether `.typstryignore` re-includes a git file with a negated pattern.
   * Only that file counts: a `.gitignore` that negates itself is about git,
   * not about co-authors.
   */
  private optedIn(path: string, isDir: boolean): boolean {
    for (let i = this.optIns.length - 1; i >= 0; i--) {
      const verdict = this.optIns[i]!.match(path, isDir);
      if (verdict) return verdict === "include";
    }
    return false;
  }
}
