import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A real smart HTTP Git server for tests, without a network: `git
// http-backend` run as a CGI against a bare repo. isomorphic-git cannot serve
// upload-pack itself, and a recorded response would not survive a change of
// the request it was recorded for.

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface Fixture {
  /** Parent of the bare repo, served as "/o/repo.git". */
  root: string;
}

export interface FixtureSpec {
  /** Files of the first commit, by path. */
  files: Record<string, string | Buffer>;
  /** Symlinks to add, by path, with their targets. */
  links?: Record<string, string>;
  /** A second commit on this branch, with these files on top. */
  branch?: { name: string; files: Record<string, string | Buffer> };
  /** A lightweight tag on the first commit. */
  tag?: string;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function put(dir: string, files: Record<string, string | Buffer>): void {
  for (const [file, data] of Object.entries(files)) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/** Builds `<root>/o/repo.git` from the spec. */
export function makeFixture(spec: FixtureSpec): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "typstry-git-"));
  const work = path.join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  put(work, spec.files);
  for (const [link, target] of Object.entries(spec.links ?? {})) {
    mkdirSync(path.dirname(path.join(work, link)), { recursive: true });
    symlinkSync(target, path.join(work, link));
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "first");
  if (spec.tag) git(work, "tag", spec.tag);
  if (spec.branch) {
    git(work, "checkout", "-q", "-b", spec.branch.name);
    put(work, spec.branch.files);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "second");
    git(work, "checkout", "-q", "main");
  }
  mkdirSync(path.join(root, "o"));
  git(root, "clone", "-q", "--bare", work, "o/repo.git");
  return { root };
}

/** Serves one request; `url` is the part after the host, query included. */
export function serve(
  fixture: Fixture,
  req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: Buffer;
  },
): Promise<Reply> {
  const [pathname, query = ""] = req.url.split("?");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_PROJECT_ROOT: fixture.root,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method,
    PATH_INFO: pathname!,
    QUERY_STRING: query,
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    CONTENT_LENGTH: String(req.body?.length ?? 0),
    HTTP_ACCEPT_ENCODING: "",
  };
  if (req.headers["git-protocol"])
    env.GIT_PROTOCOL = req.headers["git-protocol"];

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      const all = Buffer.concat(out);
      const split = all.indexOf("\r\n\r\n");
      const head = all.subarray(0, split).toString().split("\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).toLowerCase();
        const value = line.slice(at + 1).trim();
        if (name === "status") status = parseInt(value, 10);
        else headers[name] = value;
      }
      resolve({ status, headers, body: all.subarray(split + 4) });
    });
    child.stdin.end(req.body);
  });
}
