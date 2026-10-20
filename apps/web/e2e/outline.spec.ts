import {
  appendLine,
  createEntry,
  createProject,
  editor,
  expect,
  tab,
  test,
} from "./fixtures";

test("the outline jumps to a heading in an included file", async ({ page }) => {
  await createProject(page, "Outline");

  await createEntry(page, "chapter.typ");
  await editor(page).click();
  await page.keyboard.type("= Chapter heading");

  await tab(page, "main.typ").click();
  await appendLine(page, '#include "chapter.typ"');

  await page.getByRole("tab", { name: "Outline" }).click();
  const tree = page.getByRole("tree", { name: "Outline" });
  await expect(
    tree.getByRole("treeitem", { name: "Chapter heading" }),
  ).toBeVisible();

  await tree.getByRole("treeitem", { name: "Chapter heading" }).click();
  await expect(tab(page, "chapter.typ")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editor(page).locator(".cm-activeLine")).toHaveText(
    "= Chapter heading",
  );
});
