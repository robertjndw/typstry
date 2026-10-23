import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { makeFixture, serve, type Fixture } from "../../e2e/git-backend";
import {
  fetchSnapshot,
  listRefs,
  parseGitUrl,
  readGit,
  repoName,
  type GitDeps,
} from "./git";
import { ImportError } from "./import";

vi.mock("./import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./import")>()),
  MAX_IMPORT_ENTRIES: 5,
}));

describe("parseGitUrl", () => {
  const repo = "https://github.com/typst/templates.git";

  it("takes plain clone URLs with or without .git and a slash", () => {
    for (const input of [
      "https://github.com/typst/templates",
      "https://github.com/typst/templates/",
      "https://github.com/typst/templates.git",
      "  github.com/typst/templates  ",
    ]) {
      expect(parseGitUrl(input)).toEqual({
        url: repo,
        ref: undefined,
        path: undefined,
      });
    }
  });

  it("reads the ref and folder of a GitHub or Gitea tree URL", () => {
    expect(
      parseGitUrl("https://github.com/typst/templates/tree/main/charged-ieee/"),
    ).toEqual({ url: repo, ref: "main", path: "charged-ieee" });
    expect(
      parseGitUrl("https://gitea.example/o/r/tree/v1.2/a/b"),
    ).toMatchObject({ ref: "v1.2", path: "a/b" });
    expect(parseGitUrl("https://github.com/o/r/tree/dev")).toMatchObject({
      ref: "dev",
      path: undefined,
    });
  });

  it("takes the folder of a file link", () => {
    expect(
      parseGitUrl("https://github.com/o/r/blob/main/paper/main.typ"),
    ).toMatchObject({ ref: "main", path: "paper" });
  });

  it("reads GitLab URLs, subgroups included", () => {
    expect(
      parseGitUrl("https://gitlab.com/group/sub/repo/-/tree/main/docs"),
    ).toEqual({
      url: "https://gitlab.com/group/sub/repo.git",
      ref: "main",
      path: "docs",
    });
  });

  it("takes the first segment as the ref when it has slashes", () => {
    expect(parseGitUrl("https://github.com/o/r/tree/feat/x/dir")).toMatchObject(
      { ref: "feat", path: "x/dir" },
    );
  });

  it("drops credentials and the query", () => {
    expect(parseGitUrl("https://me:pw@github.com/o/r?tab=readme").url).toBe(
      "https://github.com/o/r.git",
    );
  });

  it("rejects other schemes and non-repositories", () => {
    for (const input of [
      "",
      "http://github.com/o/r",
      "git://github.com/o/r",
      "ssh://git@github.com/o/r",
      "https://github.com/o",
      "https://",
    ]) {
      expect(() => parseGitUrl(input), input).toThrow(ImportError);
    }
  });
});

describe("readGit", () => {
  let fixture: Fixture;
  let deps: GitDeps;
  const url = "https://git.test/o/repo.git";
  let requests = 0;

  beforeAll(() => {
    fixture = makeFixture({
      files: {
        "main.typ": "= Root\n",
        "letter/main.typ": "= Letter\n",
        "letter/notes/a.typ": "a\n",
        "node_modules/x/index.js": "junk\n",
      },
      links: { "letter/link": "../main.typ" },
      branch: { name: "dev", files: { "dev.typ": "dev\n" } },
      tag: "v1",
    });
    deps = {
      corsProxy: "",
      http: {
        async request(req: {
          url: string;
          method?: string;
          headers?: Record<string, string>;
          body?: AsyncIterable<Uint8Array>;
        }) {
          requests++;
          const chunks: Uint8Array[] = [];
          for await (const c of req.body ?? []) chunks.push(c);
          const reply = await serve(fixture, {
            method: req.method ?? "GET",
            url: req.url.replace("https://git.test", ""),
            headers: req.headers ?? {},
            body: Buffer.concat(chunks),
          });
          return {
            url: req.url,
            method: req.method,
            headers: reply.headers,
            statusCode: reply.status,
            statusMessage: "",
            body: [new Uint8Array(reply.body)],
          };
        },
      },
    };
  });

  afterAll(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const text = (source: { files: Map<string, Uint8Array> }, path: string) =>
    new TextDecoder().decode(source.files.get(path));

  it("reads the default branch of a repository", async () => {
    const source = await readGit(
      { url, path: "letter/notes" },
      undefined,
      deps,
    );
    expect(source.name).toBe("notes");
    expect([...source.files.keys()]).toEqual(["a.typ"]);
  });

  it("keeps a folder's contents at the root, skips links and junk", async () => {
    const progress: string[] = [];
    const source = await readGit(
      { url, path: "letter" },
      (phase) => progress.push(phase),
      deps,
    );
    expect(source.name).toBe("letter");
    expect([...source.files.keys()].sort()).toEqual([
      "main.typ",
      "notes/a.typ",
    ]);
    expect(text(source, "main.typ")).toBe("= Letter\n");
    expect(source.skipped).toEqual(["link"]);
    expect(progress.length).toBeGreaterThan(0);
  });

  it("names the project after the repository without a folder", async () => {
    const source = await readGit(
      { url: "https://git.test/o/repo" },
      undefined,
      deps,
    );
    expect(source.name).toBe("repo");
    expect(source.files.has("main.typ")).toBe(true);
    expect(source.files.has("node_modules/x/index.js")).toBe(false);
  });

  it("reads a branch or a tag", async () => {
    const branch = await readGit({ url, ref: "dev" }, undefined, deps);
    expect(branch.files.has("dev.typ")).toBe(true);
    const tag = await readGit({ url, ref: "v1" }, undefined, deps);
    expect(tag.files.has("dev.typ")).toBe(false);
    expect(tag.files.has("main.typ")).toBe(true);
  });

  it("lets the form fields win over the URL", async () => {
    const source = await readGit(
      {
        url: `${url.replace(".git", "")}/tree/main/letter`,
        ref: "dev",
        path: "",
      },
      undefined,
      deps,
    );
    // An empty field falls back to the URL's folder.
    expect(source.name).toBe("letter");
    expect(source.files.has("dev.typ")).toBe(false);
  });

  it("explains a missing folder or ref", async () => {
    await expect(
      readGit({ url, path: "nope" }, undefined, deps),
    ).rejects.toThrow('The folder "nope" is not in the repository');
    await expect(
      readGit({ url, ref: "ghost" }, undefined, deps),
    ).rejects.toThrow('The branch or tag "ghost" was not found');
  });

  it("stops past the entry cap", async () => {
    const big = makeFixture({
      files: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`f${i}.typ`, "x"]),
      ),
    });
    const original = fixture;
    try {
      fixture = big;
      await expect(readGit({ url }, undefined, deps)).rejects.toThrow(
        /more than \d+ files/,
      );
    } finally {
      fixture = original;
      const { rmSync } = await import("node:fs");
      rmSync(big.root, { recursive: true, force: true });
    }
  });

  it("lists branches and tags from info/refs alone", async () => {
    const refs = await listRefs("git.test/o/repo", deps);
    expect(refs).toEqual({
      url,
      defaultBranch: "main",
      branches: ["main", "dev"],
      tags: ["v1"],
    });
  });

  it("lists every folder of a snapshot without reading blobs", async () => {
    const snapshot = await fetchSnapshot(url, undefined, undefined, deps);
    expect(snapshot.ref).toBeUndefined();
    expect(snapshot.folders).toEqual([
      { path: "", files: 3, typst: true, manifest: false },
      { path: "letter", files: 2, typst: true, manifest: false },
      { path: "letter/notes", files: 1, typst: true, manifest: false },
    ]);
  });

  it("flags manifests and counts plain files", async () => {
    const other = makeFixture({
      files: { "pkg/typst.toml": "x", "pkg/lib.typ": "x", "docs/a.md": "x" },
    });
    const original = fixture;
    try {
      fixture = other;
      const { folders } = await fetchSnapshot(url, undefined, undefined, deps);
      expect(folders.find((f) => f.path === "pkg")).toEqual({
        path: "pkg",
        files: 2,
        typst: true,
        manifest: true,
      });
      expect(folders.find((f) => f.path === "docs")).toMatchObject({
        typst: false,
        manifest: false,
      });
    } finally {
      fixture = original;
      const { rmSync } = await import("node:fs");
      rmSync(other.root, { recursive: true, force: true });
    }
  });

  it("reads folders from a snapshot without fetching again", async () => {
    const snapshot = await fetchSnapshot(url, "dev", undefined, deps);
    const before = requests;
    const sub = await snapshot.read("letter/");
    const all = await snapshot.read("");
    expect(requests).toBe(before);
    expect(sub.name).toBe("letter");
    expect([...sub.files.keys()].sort()).toEqual(["main.typ", "notes/a.typ"]);
    expect(all.name).toBe("repo");
    expect(all.files.has("dev.typ")).toBe(true);
    await expect(snapshot.read("nope")).rejects.toThrow(
      'The folder "nope" is not in the repository',
    );
  });

  it("names a repository by its last segment", () => {
    expect(repoName("https://git.test/o/repo.git")).toBe("repo");
    expect(repoName("https://git.test/g/sub/thing")).toBe("thing");
  });

  it("maps relay statuses to messages", async () => {
    const failing = (statusCode: number): GitDeps => ({
      corsProxy: "",
      http: {
        request: async (req: { url: string }) => ({
          url: req.url,
          statusCode,
          statusMessage: "x",
          headers: {},
          body: [new Uint8Array()],
        }),
      },
    });
    await expect(readGit({ url }, undefined, failing(404))).rejects.toThrow(
      /not found, or it is not public/,
    );
    await expect(readGit({ url }, undefined, failing(403))).rejects.toThrow(
      /does not allow/,
    );
    await expect(readGit({ url }, undefined, failing(413))).rejects.toThrow(
      /too large/,
    );
    await expect(listRefs(url, failing(404))).rejects.toThrow(
      /not found, or it is not public/,
    );
  });
});
