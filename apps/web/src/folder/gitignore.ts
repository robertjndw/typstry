export type IgnoreVerdict = "ignore" | "include";

interface Rule {
  pattern: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/**
 * The rules of one `.gitignore`-style file. A subset of git's syntax:
 * comments, `!` negation, a trailing `/` for folders only, anchoring by a
 * leading or inner `/`, `*`, `?`, `**`, `[...]` classes and `\` escapes.
 * Matching is case-sensitive, like git without `core.ignorecase`.
 */
export class GitignoreFile {
  private readonly rules: Rule[] = [];
  private readonly prefix: string;

  constructor(text: string, base = "") {
    this.prefix = base === "" ? "" : `${base}/`;
    for (const line of text.split(/\r?\n/)) {
      const rule = parseLine(line);
      if (rule) this.rules.push(rule);
    }
  }

  get empty(): boolean {
    return this.rules.length === 0;
  }

  /**
   * Verdict of the last rule matching `path` (relative to the folder root),
   * or null if none does or the path is outside the base. Doesn't look at
   * parent folders; the caller checks those.
   */
  match(path: string, isDir: boolean): IgnoreVerdict | null {
    if (!path.startsWith(this.prefix)) return null;
    const rel = path.slice(this.prefix.length);
    if (rel === "") return null;
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]!;
      if (rule.dirOnly && !isDir) continue;
      if (rule.pattern.test(rel)) return rule.negated ? "include" : "ignore";
    }
    return null;
  }
}

export function parseGitignore(text: string, base = ""): GitignoreFile {
  return new GitignoreFile(text, base);
}

function parseLine(raw: string): Rule | null {
  let line = raw;
  // Trailing spaces are dropped unless escaped with a backslash.
  while (line.endsWith(" ") && !line.endsWith("\\ ")) line = line.slice(0, -1);
  if (line === "" || line.startsWith("#")) return null;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return null;
  // A slash anywhere but the end ties the pattern to the file's folder.
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  const body = translate(line);
  if (body === null) return null;
  return {
    pattern: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
    negated,
    dirOnly,
  };
}

const escapeRegex = (c: string) => c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

function translate(glob: string): string | null {
  if (glob === "**") return ".+";
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    const atStart = i === 0 || glob[i - 1] === "/";
    if (c === "*" && glob[i + 1] === "*") {
      if (atStart && glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
        continue;
      }
      if (atStart && i + 2 === glob.length) {
        // "a/**" matches what is inside a, not a itself.
        out += ".+";
        i += 1;
        continue;
      }
      // Other runs of stars count as one, as in git.
      while (glob[i + 1] === "*") i++;
      out += "[^/]*";
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "\\") {
      i++;
      if (i >= glob.length) return null;
      out += escapeRegex(glob[i]!);
    } else if (c === "[") {
      const cls = parseClass(glob, i);
      if (cls) {
        out += cls.source;
        i = cls.end;
      } else {
        out += "\\[";
      }
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

function parseClass(
  glob: string,
  start: number,
): { source: string; end: number } | null {
  let i = start + 1;
  let negated = false;
  if (glob[i] === "!" || glob[i] === "^") {
    negated = true;
    i++;
  }
  let body = "";
  // A "]" right after the opening is a member, not the end.
  let first = true;
  for (; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "]" && !first) {
      if (body === "") return null;
      return { source: `[${negated ? "^/" : ""}${body}]`, end: i };
    }
    first = false;
    if (c === "\\") {
      i++;
      if (i >= glob.length) return null;
      body += escapeRegex(glob[i]!);
    } else if (c === "-" && body !== "" && glob[i + 1] !== "]") {
      body += "-";
    } else {
      body += escapeRegex(c);
    }
  }
  return null;
}
