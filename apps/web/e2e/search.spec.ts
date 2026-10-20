import {
  createEntry,
  createProject,
  docText,
  editor,
  expect,
  openFile,
  test,
} from "./fixtures";

test("search and replace across files undoes in one step", async ({ page }) => {
  await createProject(page, "Search");

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("foo here");
  await page.keyboard.press("Escape");

  await createEntry(page, "notes.typ");
  await editor(page).click();
  await page.keyboard.type("foo there");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Shift+F");
  const query = page.getByLabel("Search query");
  await expect(query).toBeFocused();
  await query.fill("foo");
  await expect(
    page.getByRole("status").filter({ hasText: "results" }),
  ).toHaveText("2 results in 2 files");

  await page.getByLabel("Replacement").fill("bar");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(page.getByText("Replaced 2 matches")).toBeVisible();
  await expect.poll(() => docText(page)).toContain("bar there");
  await expect.poll(() => docText(page)).not.toContain("foo");

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => docText(page)).toContain("foo there");

  // The other file came back with the same undo step.
  await page.getByRole("tab", { name: "Files" }).click();
  await openFile(page, "main.typ");
  await expect.poll(() => docText(page)).toContain("foo here");
});
