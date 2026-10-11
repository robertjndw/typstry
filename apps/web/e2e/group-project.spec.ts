import path from "node:path";
import type { Locator, Page } from "@playwright/test";

import {
  appendLine,
  createEntry,
  createProject,
  downloadPdf,
  editor,
  expect,
  expectConverged,
  fileTree,
  firstPage,
  newFileIn,
  openFile,
  openElsewhere,
  openVersion,
  preview,
  renameEntry,
  shareLink,
  syncStatus,
  tab,
  tagVersion,
  test,
  typeAtEnd,
  versionRow,
  versions,
} from "./fixtures";
import { readPdf } from "./pdf";

const RED_PNG = path.join(import.meta.dirname, "files/red.png");

function people(page: Page) {
  return page.getByRole("list", { name: "People in this project" });
}

function avatars(page: Page, name: string) {
  return people(page).getByRole("listitem", { name: new RegExp(`^${name}`) });
}

// First match only: a tab closed while offline never says goodbye, so its
// avatar lingers next to the new one until the presence timeout.
function person(page: Page, name: string) {
  return avatars(page, name).first();
}

function problems(page: Page, message: RegExp) {
  return preview(page)
    .getByLabel("Diagnostics")
    .getByRole("button", { name: message });
}

async function exportPdf(page: Page, button: Locator) {
  const { name, bytes } = await downloadPdf(page, button);
  return { name, pdf: readPdf(bytes) };
}

test.use({ identity: { name: "Alice", color: "#be123c" } });

test("a thesis group works together from the first file to the hand-in", async ({
  page: alice,
  browser,
}) => {
  test.setTimeout(4 * 60_000);

  let bob!: Page;
  let carol!: Page;
  let vera!: Page;
  let edit = "";
  // A function because Bob and Carol get new pages when they come back.
  const cast = () => ({ Alice: alice, Bob: bob, Carol: carol, Vera: vera });
  const everyone = () => Object.values(cast());

  await test.step("Alice sets up the project structure", async () => {
    await createProject(alice, "Thesis");
    await createEntry(alice, "chapters", "folder");
    await newFileIn(alice, "chapters", "intro.typ");
    await newFileIn(alice, "chapters", "method.typ");
    await tab(alice, "main.typ").click();
    await appendLine(alice, '#include "chapters/intro.typ"');
    await appendLine(alice, '#include "chapters/method.typ"');
    await expect(preview(alice).getByLabel("Up to date")).toBeVisible();
  });

  await test.step("the project is shared with editors and a viewer", async () => {
    edit = await shareLink(alice, "Can edit");
    const view = await shareLink(alice, "Can view");
    expect(edit).not.toEqual(view);

    [bob, carol, vera] = await Promise.all([
      openElsewhere(browser, edit, "Bob"),
      openElsewhere(browser, edit, "Carol"),
      openElsewhere(browser, view, "Vera"),
    ]);

    // Everyone sees the other three, and never themselves.
    for (const [self, viewer] of Object.entries(cast())) {
      for (const name of Object.keys(cast())) {
        if (name !== self) await expect(person(viewer, name)).toBeVisible();
      }
      await expect(people(viewer).getByRole("listitem")).toHaveCount(3);
    }
    await expect(person(alice, "Bob")).toHaveAccessibleName("Bob, in main.typ");
    await expect(editor(vera)).toHaveAttribute("contenteditable", "false");
    await expect(
      fileTree(vera).getByRole("treeitem", { name: "chapters" }),
    ).toBeVisible();
  });

  await test.step("Bob and Carol write different chapters at once", async () => {
    await Promise.all([
      openFile(bob, "intro.typ"),
      openFile(carol, "method.typ"),
    ]);
    await expect(person(alice, "Bob")).toHaveAccessibleName(
      "Bob, in chapters/intro.typ",
    );
    await Promise.all([
      typeAtEnd(bob, "Bob drafted the introduction. "),
      typeAtEnd(carol, "Carol described the method. "),
    ]);

    for (const reader of everyone()) {
      await expect(firstPage(reader)).toContainText(
        "Bob drafted the introduction.",
      );
      await expect(firstPage(reader)).toContainText(
        "Carol described the method.",
      );
    }
    // Vera only has the view link.
    await editor(vera).click({ force: true });
    await vera.keyboard.type("Vera was here");
    await expect(editor(vera)).not.toContainText("Vera was here");
  });

  await test.step("three people type into the same line", async () => {
    await Promise.all([
      tab(bob, "main.typ").click(),
      tab(carol, "main.typ").click(),
    ]);
    await appendLine(alice, "Abstract:");
    await expectConverged(everyone(), ["Abstract:"]);

    await Promise.all([
      typeAtEnd(alice, " AliceWroteThis"),
      typeAtEnd(bob, " BobWroteThis"),
      typeAtEnd(carol, " CarolWroteThis"),
    ]);
    await expectConverged(everyone(), [
      "AliceWroteThis",
      "BobWroteThis",
      "CarolWroteThis",
    ]);
  });

  await test.step("undo only takes back your own edit", async () => {
    // Edits within about a second merge into one undo step.
    await alice.waitForTimeout(1500);
    await appendLine(alice, "AliceOops");
    await expectConverged(everyone(), ["AliceOops"]);
    await appendLine(bob, "BobStays");
    await expectConverged(everyone(), ["AliceOops", "BobStays"]);

    await editor(alice).click();
    await alice.keyboard.press("ControlOrMeta+z");
    await expectConverged(everyone(), ["BobStays"]);
    for (const reader of everyone()) {
      await expect(editor(reader)).not.toContainText("AliceOops");
    }
  });

  await test.step("Bob breaks the document and Carol repairs it", async () => {
    await appendLine(bob, "#nosuchthing");
    for (const reader of everyone()) {
      await expect(problems(reader, /unknown variable/)).toBeVisible();
      await expect(reader.locator(".cm-lintRange-error")).not.toHaveCount(0);
    }

    await editor(carol).click();
    await carol.keyboard.press("ControlOrMeta+End");
    await carol.keyboard.press("Shift+Home");
    await carol.keyboard.press("Backspace");
    await expectConverged(everyone());
    for (const reader of everyone()) {
      await expect(
        reader.getByRole("region", { name: "Diagnostics" }),
      ).toBeHidden();
      await expect(preview(reader).getByLabel("Up to date")).toBeVisible();
    }
  });

  await test.step("a renamed chapter keeps Carol's tab and text", async () => {
    await openFile(carol, "method.typ");
    await typeAtEnd(carol, "BeforeRename ");

    await renameEntry(alice, "chapters/method.typ", "methods.typ");

    await expect(tab(carol, "methods.typ")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tab(carol, "method.typ")).toBeHidden();
    // No click in between: the cursor must still be in the renamed file.
    await carol.keyboard.type("AfterRename");
    await carol.keyboard.press("Escape");

    await openFile(alice, "methods.typ");
    await expectConverged(
      [alice, carol],
      ["Carol described the method.", "BeforeRename", "AfterRename"],
    );

    // Includes are not rewritten, so the project is broken until fixed.
    for (const reader of everyone()) {
      await expect(problems(reader, /file not found/)).toBeVisible();
    }
    await tab(carol, "main.typ").click();
    await carol
      .locator(".cm-line")
      .filter({ hasText: "chapters/method.typ" })
      .click();
    await carol.keyboard.press("End");
    // Back over `.typ"` so only the file name changes.
    await carol.keyboard.press("ArrowLeft");
    for (let i = 0; i < 4; i++) await carol.keyboard.press("Backspace");
    await carol.keyboard.type("s.typ");
    await carol.keyboard.press("Escape");
    await tab(alice, "main.typ").click();
    await tab(bob, "main.typ").click();
    for (const reader of everyone()) {
      await expect(preview(reader).getByLabel("Up to date")).toBeVisible();
      await expect(firstPage(reader)).toContainText("AfterRename");
    }
    await expectConverged(everyone(), ['chapters/methods.typ"']);
  });

  await test.step("Bob adds the figure", async () => {
    await bob.getByLabel("Files to upload").setInputFiles(RED_PNG);
    await expect(
      fileTree(bob).getByRole("treeitem", { name: "red.png" }),
    ).toBeVisible();
    await tab(bob, "main.typ").click();
    await appendLine(bob, '#image("red.png", width: 2cm)');
    for (const reader of everyone()) {
      await expect(firstPage(reader).locator("image")).toHaveCount(1);
    }
    await expectConverged(everyone(), ["red.png"]);
  });

  await test.step("Carol works offline while Bob leaves", async () => {
    const carolContext = carol.context();
    // Keeps the context alive so it can still be taken back online.
    const spare = await carolContext.newPage();
    await carolContext.setOffline(true);
    await expect(syncStatus(carol)).toHaveText("Offline");

    await appendLine(carol, "CarolWroteOffline");
    await expect(firstPage(carol)).toContainText("CarolWroteOffline");
    // The shortcut is Control+s even on a Mac, see offline.spec.ts.
    await carol.keyboard.press("Control+s");
    await expect(carol.getByText(/saved on this device/)).toBeVisible();
    await carol.close();

    await appendLine(bob, "BobWroteMeanwhile");
    await expectConverged([alice, vera], ["BobWroteMeanwhile"]);
    await bob.close({ runBeforeUnload: true });
    await expect(avatars(alice, "Bob")).toHaveCount(0);
    await expect(avatars(vera, "Bob")).toHaveCount(0);

    carol = spare;
  });

  await test.step("Carol and Bob come back and everything merges", async () => {
    await carol.context().setOffline(false);
    await carol.goto("/");
    await carol
      .getByRole("region", { name: "Recent projects" })
      .getByRole("link", { name: /^Thesis/ })
      .click();
    await expect(syncStatus(carol)).toHaveText("Connected");

    // Same context as before, so no name prompt this time.
    bob = await bob.context().newPage();
    await bob.goto(edit);
    await expect(syncStatus(bob)).toHaveText("Connected");

    await expectConverged(
      everyone(),
      ["CarolWroteOffline", "BobWroteMeanwhile", "red.png"],
      30_000,
    );
    for (const reader of [alice, vera]) {
      await expect(person(reader, "Bob")).toBeVisible();
      await expect(person(reader, "Carol")).toBeVisible();
    }
    await expect(person(bob, "Carol")).toBeVisible();
    await expect(person(carol, "Bob")).toBeVisible();
  });

  await test.step("a tagged milestone can be restored", async () => {
    await vera.getByRole("button", { name: "History", exact: true }).click();
    await expect(versions(vera)).toBeVisible();
    await tagVersion(alice, "Sent to supervisor");
    await expect(
      versions(vera).getByText("Sent to supervisor", { exact: true }),
    ).toBeVisible();
    await vera.keyboard.press("Escape");

    await appendLine(bob, "BadEditAfterTag");
    await expectConverged(everyone(), ["BadEditAfterTag"]);

    await openVersion(alice, "Sent to supervisor");
    await alice.getByRole("button", { name: "Restore this version" }).click();
    await alice
      .getByRole("dialog", { name: "Restore this version?" })
      .getByRole("button", { name: "Restore" })
      .click();
    await expect(
      alice.getByText('Restored "Sent to supervisor"'),
    ).toBeVisible();

    for (const reader of [bob, carol, vera]) {
      await expect(editor(reader)).not.toContainText("BadEditAfterTag");
    }
    await expectConverged(everyone(), [
      "CarolWroteOffline",
      "BobWroteMeanwhile",
    ]);
  });

  await test.step("a latecomer gets the whole project", async () => {
    const dave = await openElsewhere(browser, edit, "Dave");
    await expect(
      fileTree(dave).getByRole("treeitem", { name: "red.png" }),
    ).toBeVisible();
    await expect(
      fileTree(dave).getByRole("treeitem", { name: "chapters" }),
    ).toBeVisible();
    await expectConverged([alice, dave], ["CarolWroteOffline"]);
    await expect(firstPage(dave).locator("image")).toHaveCount(1);
    await expect(firstPage(dave)).toContainText("AfterRename");
    await expect(firstPage(dave)).toContainText(
      "Bob drafted the introduction.",
    );

    await dave.context().close();
  });

  await test.step("the hand-in PDF has everyone's work in it", async () => {
    await expect(preview(vera).getByLabel("Up to date")).toBeVisible();
    const live = await exportPdf(
      vera,
      vera.getByRole("button", { name: "Download PDF" }),
    );
    expect(live.name).toMatch(/^Thesis.*\.pdf$/);
    expect(live.pdf.pages).toBe(1);
    expect(live.pdf.images).toBe(1);
    for (const text of [
      "Bob drafted the introduction.",
      "Carol described the method.",
      "BeforeRename AfterRename",
      "AliceWroteThis",
      "BobWroteThis",
      "CarolWroteThis",
      "BobStays",
      "CarolWroteOffline",
      "BobWroteMeanwhile",
    ]) {
      expect(live.pdf.text).toContain(text);
    }
    // Undone, fixed or restored away, so none of these may reach the PDF.
    for (const text of ["AliceOops", "nosuchthing", "BadEditAfterTag"]) {
      expect(live.pdf.text).not.toContain(text);
    }

    // The milestone compiles from history on its own, and since the project
    // was just restored to it, it has to match the live export.
    await alice.getByRole("button", { name: "History", exact: true }).click();
    await versionRow(alice, "Sent to supervisor")
      .getByRole("button", { name: "Preview" })
      .click();
    const milestone = alice.getByRole("dialog", { name: "Sent to supervisor" });
    await expect(milestone.getByRole("img", { name: "Page 1" })).toContainText(
      "CarolWroteOffline",
    );
    const tagged = await exportPdf(
      alice,
      milestone.getByRole("button", { name: "Download PDF" }),
    );
    expect(tagged.name).toMatch(/Sent.to.supervisor.*\.pdf$/);
    expect(tagged.pdf).toEqual(live.pdf);

    await Promise.all(
      [bob, carol, vera].map((other) => other.context().close()),
    );
  });
});
