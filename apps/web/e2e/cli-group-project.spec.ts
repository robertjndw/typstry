import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { buildCli, Cli, gitEnv } from "./cli";
import {
  appendLine,
  createEntry,
  createProject,
  docText,
  downloadPdf,
  editor,
  expect,
  expectConverged,
  fileTree,
  firstPage,
  newFileIn,
  openElsewhere,
  openFile,
  preview,
  renameEntry,
  shareLink,
  tab,
  tagVersion,
  test,
  typeAtEnd,
  versions,
} from "./fixtures";
import { readPdf } from "./pdf";

const RED_PNG = path.join(import.meta.dirname, "files/red.png");

let binary = "";

test.beforeAll(async () => {
  // A cold build of the CLI takes a few minutes.
  test.setTimeout(10 * 60_000);
  binary = await buildCli();
});

test.use({ identity: { name: "Alice", color: "#be123c" } });

/** The text of a file on Dana's disk. */
function onDisk(dir: string, file: string) {
  return readFileSync(path.join(dir, file), "utf8");
}

function write(dir: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

function append(dir: string, file: string, text: string) {
  appendFileSync(path.join(dir, file), text);
}

function git(dir: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: gitEnv(),
  }).trim();
}

/** Polls a file that a running sync writes. */
function diskFile(dir: string, file: string) {
  return expect.poll(() =>
    existsSync(path.join(dir, file)) ? onDisk(dir, file) : null,
  );
}

function treeItem(page: Page, name: string) {
  return fileTree(page).getByRole("treeitem", { name, exact: true });
}

test("a browser group and a CLI user write one thesis together", async ({
  page: alice,
  browser,
}) => {
  test.setTimeout(5 * 60_000);

  const dana = new Cli(binary, "Dana");
  // Outside the checkout, or `clone --git` would find typstry's own repo.
  const work = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "typstry-cli-e2e-")),
  );
  const repo = path.join(work, "thesis");
  const viewer = path.join(work, "viewer");
  const exported = path.join(work, "export-supervisor");
  let trunk = "";
  let view = "";
  let bob!: Page;

  const commit = (message: string) => {
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", message);
  };

  try {
    await test.step("Alice starts the thesis and shares it", async () => {
      await createProject(alice, "Thesis");
      await createEntry(alice, "chapters", "folder");
      await newFileIn(alice, "chapters", "intro.typ");
      await typeAtEnd(alice, "Alice wrote the introduction.");
      await tab(alice, "main.typ").click();
      await appendLine(alice, '#include "chapters/intro.typ"');
      await expect(firstPage(alice)).toContainText(
        "Alice wrote the introduction.",
      );
      const edit = await shareLink(alice, "Can edit");
      view = await shareLink(alice, "Can view");

      bob = await openElsewhere(browser, edit, "Bob");
      await openFile(bob, "intro.typ");

      const cloned = await dana.ok(work, ["clone", "--git", edit, "thesis"]);
      expect(cloned.stdout).toContain('Cloned "Thesis"');
    });

    await test.step("Dana's clone matches the project and has its first commit", async () => {
      expect(onDisk(repo, "chapters/intro.typ")).toContain(
        "Alice wrote the introduction.",
      );
      expect(onDisk(repo, "main.typ")).toContain(
        '#include "chapters/intro.typ"',
      );
      // The key lives in .typstry, which must never end up in a commit.
      expect(git(repo, "ls-files").split("\n").sort()).toEqual([
        "chapters/intro.typ",
        "main.typ",
      ]);
      expect(git(repo, "log", "--format=%s")).toBe(
        "import from typstry: Thesis",
      );
      git(repo, "config", "user.name", "Dana");
      git(repo, "config", "user.email", "dana@example.com");
      trunk = git(repo, "branch", "--show-current");
      expect((await dana.ok(repo, ["status"])).stdout).toContain(
        "Everything up to date.",
      );
    });

    await test.step("Dana writes a chapter in her editor and pushes it", async () => {
      append(repo, "main.typ", "\nDana added a paragraph from her editor.\n");
      write(repo, "chapters/results.typ", "Dana measured the results.\n");
      copyFileSync(RED_PNG, path.join(repo, "red.png"));
      append(
        repo,
        "main.typ",
        '#include "chapters/results.typ"\n#image("red.png", width: 2cm)\n',
      );

      const pushed = (await dana.ok(repo, ["push"])).stdout;
      expect(pushed).toContain("\u2191 chapters/results.typ (new)");
      expect(pushed).toContain("\u2191 red.png (new)");
      expect(pushed).toContain("\u2191 main.typ");
      commit("add the results chapter");

      await expect(treeItem(alice, "results.typ")).toBeVisible();
      await expect(treeItem(alice, "red.png")).toBeVisible();
      await expect(firstPage(alice)).toContainText(
        "Dana measured the results.",
      );
      await expect(firstPage(alice)).toContainText(
        "Dana added a paragraph from her editor.",
      );
      await expect(firstPage(alice).locator("image")).toHaveCount(1);
    });

    await test.step("the history credits Dana as an author", async () => {
      await alice.getByRole("button", { name: "History", exact: true }).click();
      await expect(
        versions(alice).locator('[title="Dana"]').first(),
      ).toBeVisible();
      await alice.keyboard.press("Escape");
    });

    await test.step("Alice and Bob edit and Dana pulls it in", async () => {
      await appendLine(alice, "Alice reviewed the results.");
      await typeAtEnd(bob, " Bob added related work.");

      // Their edits take a moment to reach the server.
      await expect
        .poll(async () => {
          const { stdout } = await dana.ok(repo, ["status"]);
          return (
            stdout.includes("Remote changes") &&
            stdout.includes("M main.typ") &&
            stdout.includes("M chapters/intro.typ")
          );
        })
        .toBe(true);

      const pulled = (await dana.ok(repo, ["pull"])).stdout;
      expect(pulled).toContain("\u2193 main.typ");
      expect(pulled).toContain("\u2193 chapters/intro.typ");
      expect(onDisk(repo, "main.typ")).toContain("Alice reviewed the results.");
      expect(onDisk(repo, "chapters/intro.typ")).toContain(
        "Bob added related work.",
      );
      commit("pull in the review");
    });

    await test.step("Dana and Alice edit the same file at once and push merges them", async () => {
      await appendLine(alice, "AliceConcurrent");
      append(repo, "main.typ", "DanaConcurrent\n");
      await expect
        .poll(async () => (await dana.ok(repo, ["status"])).stdout)
        .toContain("Remote changes");

      const pushed = (await dana.ok(repo, ["push"])).stdout;
      expect(pushed).toContain("Changed on both sides and merged");
      expect(onDisk(repo, "main.typ")).toContain("AliceConcurrent");
      expect(onDisk(repo, "main.typ")).toContain("DanaConcurrent");
      await expectConverged([alice], ["AliceConcurrent", "DanaConcurrent"]);
      commit("merge the concurrent edits");
    });

    await test.step("with sync running, edits go both ways", async () => {
      const sync = await dana.sync(repo);

      append(repo, "chapters/results.typ", "DanaSavedLive\n");
      await expect(firstPage(alice)).toContainText("DanaSavedLive");

      await appendLine(alice, "AliceTypedLive");
      await typeAtEnd(bob, " BobTypedLive");
      await diskFile(repo, "main.typ").toContain("AliceTypedLive");
      await diskFile(repo, "chapters/intro.typ").toContain("BobTypedLive");

      write(repo, "appendix.typ", "Dana's appendix.\n");
      await expect(treeItem(alice, "appendix.typ")).toBeVisible();
      await renameEntry(alice, "appendix.typ", "appendix-a.typ");
      await expect(treeItem(alice, "appendix-a.typ")).toBeVisible();
      await expect
        .poll(() => [
          existsSync(path.join(repo, "appendix.typ")),
          existsSync(path.join(repo, "appendix-a.typ")),
        ])
        .toEqual([false, true]);
      expect(onDisk(repo, "appendix-a.typ")).toBe("Dana's appendix.\n");

      rmSync(path.join(repo, "appendix-a.typ"));
      await expect(treeItem(alice, "appendix-a.typ")).toBeHidden();

      const output = await sync.stop();
      expect(output).toContain("sync: stopping");
      commit("keep the live edits");
    });

    await test.step("a draft branch stays private until she is back on the thesis", async () => {
      git(repo, "checkout", "--quiet", "-b", "draft");
      append(repo, "main.typ", "DraftOnlyIdea\n");
      commit("try another opening");

      const refusal = await dana.refused(repo, ["push"]);
      expect(refusal).toContain(`on branch draft, typstry tracks ${trunk}`);
      expect(refusal).toContain("--force");
      expect((await dana.ok(repo, ["status"])).stdout).toContain(
        "pull and push are paused",
      );

      await appendLine(alice, "AliceWhileDanaDrafts");
      await expect(editor(alice)).not.toContainText("DraftOnlyIdea");
      expect(await dana.refused(repo, ["pull"])).toContain("typstry tracks");
      expect(onDisk(repo, "main.typ")).not.toContain("AliceWhileDanaDrafts");

      git(repo, "checkout", "--quiet", trunk);
      expect(onDisk(repo, "main.typ")).not.toContain("DraftOnlyIdea");
      await expect
        .poll(async () => {
          await dana.ok(repo, ["pull"]);
          return onDisk(repo, "main.typ");
        })
        .toContain("AliceWhileDanaDrafts");
      // None of the draft went out.
      expect((await dana.ok(repo, ["push"])).stdout).toContain(
        "Everything up to date.",
      );
      commit("pull in alice's edit");
    });

    await test.step("a version named from the CLI shows up in the history", async () => {
      append(repo, "main.typ", "DanaPolished\n");
      const saved = (
        await dana.ok(repo, ["version", "save", "Draft for supervisor"])
      ).stdout;
      expect(saved).toContain("Saved version #");
      expect(saved).toContain('"Draft for supervisor"');
      commit("polish before the supervisor");

      await alice.getByRole("button", { name: "History", exact: true }).click();
      await expect(
        versions(alice).getByText("Draft for supervisor", { exact: true }),
      ).toBeVisible();
      await alice.keyboard.press("Escape");
    });

    await test.step("a browser tag shows up in the CLI and an old version can be exported", async () => {
      await expect(editor(alice)).toContainText("DanaPolished");
      await appendLine(alice, "AfterTheDraft");
      await tagVersion(alice, "Alice milestone");

      await expect
        .poll(async () => (await dana.ok(repo, ["version", "list"])).stdout)
        .toContain("Alice milestone");
      const list = (await dana.ok(repo, ["version", "list"])).stdout;
      expect(list).toMatch(/Draft for supervisor\s+\(Dana\)/);

      const result = await dana.ok(repo, [
        "export",
        "--at",
        "Draft for supervisor",
        exported,
      ]);
      expect(result.stdout).toContain("Draft for supervisor");
      expect(onDisk(exported, "main.typ")).toContain("DanaPolished");
      expect(onDisk(exported, "main.typ")).not.toContain("AfterTheDraft");
      expect(onDisk(exported, "chapters/results.typ")).toContain(
        "DanaSavedLive",
      );
      expect(existsSync(path.join(exported, "appendix-a.typ"))).toBe(false);
      expect(readFileSync(path.join(exported, "red.png"))).toEqual(
        readFileSync(RED_PNG),
      );
    });

    await test.step("a clone of the view link can pull but not push", async () => {
      const cloned = await dana.ok(work, ["clone", view, "viewer"]);
      expect(cloned.stdout).toContain("view-only");
      expect(onDisk(viewer, "main.typ")).toContain("AfterTheDraft");
      // The draft was never published, so a fresh clone can't have it.
      expect(onDisk(viewer, "main.typ")).not.toContain("DraftOnlyIdea");

      const original = onDisk(viewer, "main.typ");
      append(viewer, "main.typ", "Vandalism\n");
      expect(await dana.refused(viewer, ["push"])).toContain("view-only");
      expect(await dana.refused(viewer, ["version", "save", "Nope"])).toContain(
        "view-only",
      );
      await expect(editor(alice)).not.toContainText("Vandalism");

      write(viewer, "main.typ", original);
      await appendLine(alice, "AfterTheViewerClone");
      await expect
        .poll(async () => {
          await dana.ok(viewer, ["pull"]);
          return onDisk(viewer, "main.typ");
        })
        .toContain("AfterTheViewerClone");
    });

    await test.step("the hand-in PDF and Dana's disk both have everyone's work", async () => {
      await dana.ok(repo, ["pull"]);
      await expect(preview(alice).getByLabel("Up to date")).toBeVisible();

      const { name, bytes } = await downloadPdf(
        alice,
        alice.getByRole("button", { name: "Download PDF" }),
      );
      expect(name).toMatch(/^Thesis.*\.pdf$/);
      const pdf = readPdf(bytes);
      expect(pdf.images).toBe(1);
      for (const text of [
        "Alice wrote the introduction.",
        "Bob added related work.",
        "BobTypedLive",
        "Dana added a paragraph from her editor.",
        "Dana measured the results.",
        "DanaSavedLive",
        "DanaConcurrent",
        "AliceConcurrent",
        "AliceTypedLive",
        "DanaPolished",
        "AfterTheViewerClone",
      ]) {
        expect(pdf.text).toContain(text);
      }
      for (const text of ["DraftOnlyIdea", "Vandalism"]) {
        expect(pdf.text).not.toContain(text);
      }

      // What the browser shows for each file is what Dana has on disk.
      for (const file of [
        "main.typ",
        "chapters/intro.typ",
        "chapters/results.typ",
      ]) {
        await openFile(alice, path.basename(file));
        const shown = await docText(alice);
        expect(shown.trimEnd()).toBe(onDisk(repo, file).trimEnd());
      }
      expect(existsSync(path.join(repo, "appendix-a.typ"))).toBe(false);
      await expect(treeItem(alice, "appendix-a.typ")).toBeHidden();
      expect((await dana.ok(repo, ["status"])).stdout).toContain(
        "Everything up to date.",
      );
    });
  } finally {
    await dana.dispose();
    rmSync(work, { recursive: true, force: true });
    await bob?.context().close();
  }
});
