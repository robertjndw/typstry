import {
  appendLine,
  contextMenu,
  createEntry,
  createProject,
  editor,
  expect,
  fileTree,
  firstPage,
  openTabs,
  preview,
  renameEntry,
  tab,
  test,
} from "./fixtures";

test("files can be created and included from main", async ({ page }) => {
  await createProject(page, "Files");

  await createEntry(page, "chapter.typ");
  await expect(
    fileTree(page).getByRole("treeitem", { name: "chapter.typ" }),
  ).toBeVisible();
  await expect(tab(page, "chapter.typ")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await editor(page).click();
  await page.keyboard.type("Text from the chapter");

  await tab(page, "main.typ").click();
  await appendLine(page, '#include "chapter.typ"');
  await expect(firstPage(page)).toContainText("Text from the chapter");
});

test("files in folders resolve by their path", async ({ page }) => {
  await createProject(page, "Folders");

  await createEntry(page, "chapters", "folder");
  await contextMenu(page, "chapters", "New file");
  await page.getByLabel("New file name").fill("intro.typ");
  await page.getByLabel("New file name").press("Enter");

  await expect(
    fileTree(page).getByRole("treeitem", { name: "intro.typ", level: 2 }),
  ).toBeVisible();
  await editor(page).click();
  await page.keyboard.type("Nested text");

  await tab(page, "main.typ").click();
  await appendLine(page, '#include "chapters/intro.typ"');
  await expect(firstPage(page)).toContainText("Nested text");
});

test("renaming a file updates its tab and breaks old references", async ({
  page,
}) => {
  await createProject(page, "Rename");
  await createEntry(page, "chapter.typ");
  await tab(page, "main.typ").click();
  await appendLine(page, '#include "chapter.typ"');
  await expect(preview(page).getByLabel("Up to date")).toBeVisible();

  await renameEntry(page, "chapter.typ", "intro.typ");

  await expect(
    fileTree(page).getByRole("treeitem", { name: "intro.typ" }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "chapter.typ" }),
  ).toBeHidden();
  await expect(tab(page, "intro.typ")).toBeVisible();
  await expect(
    preview(page)
      .getByLabel("Diagnostics")
      .getByRole("button", { name: /file not found/ }),
  ).toBeVisible();
});

test("deleting a file asks first and closes its tab", async ({ page }) => {
  await createProject(page, "Delete");
  await createEntry(page, "scratch.typ");
  await expect(tab(page, "scratch.typ")).toBeVisible();

  await contextMenu(page, "scratch.typ", "Delete");
  const confirm = page.getByRole("dialog", { name: "Delete file?" });
  await expect(confirm).toContainText("scratch.typ");
  await confirm.getByRole("button", { name: "Delete" }).click();

  await expect(
    fileTree(page).getByRole("treeitem", { name: "scratch.typ" }),
  ).toBeHidden();
  await expect(tab(page, "scratch.typ")).toBeHidden();
  await expect(tab(page, "main.typ")).toHaveAttribute("aria-selected", "true");
});

test("tabs close with their button and a middle click", async ({ page }) => {
  await createProject(page, "Tabs");
  await createEntry(page, "a.typ");
  await createEntry(page, "b.typ");
  await expect(openTabs(page)).toHaveCount(3);

  await page.getByRole("button", { name: "Close b.typ" }).click();
  await expect(tab(page, "b.typ")).toBeHidden();
  await expect(openTabs(page, { selected: true })).toHaveCount(1);

  await tab(page, "a.typ").click({ button: "middle" });
  await expect(tab(page, "a.typ")).toBeHidden();
  await expect(openTabs(page)).toHaveCount(1);

  // Closing a tab leaves the file itself alone.
  await expect(
    fileTree(page).getByRole("treeitem", { name: "a.typ" }),
  ).toBeVisible();
});

test("open tabs come back after a reload", async ({ page }) => {
  await createProject(page, "Reopened");
  await createEntry(page, "a.typ");
  await createEntry(page, "b.typ");
  await page.getByRole("button", { name: "Close b.typ" }).click();
  await tab(page, "a.typ").click();
  await expect(openTabs(page)).toHaveCount(2);

  await page.reload();
  await expect(openTabs(page)).toHaveText(["main.typ", "a.typ"]);
  await expect(tab(page, "a.typ")).toHaveAttribute("aria-selected", "true");
});
