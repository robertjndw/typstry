import {
  appendLine,
  createProject,
  editor,
  expect,
  firstPage,
  preview,
  test,
} from "./fixtures";

test("double-clicking the preview puts the cursor on that line", async ({
  page,
}) => {
  await createProject(page, "Jump back");
  await appendLine(page, "Somewhere quite unusual");
  await expect(firstPage(page)).toContainText("Somewhere quite unusual");

  // Away from the line, so the jump has somewhere to go.
  await page.keyboard.press("ControlOrMeta+Home");
  const activeLine = page.locator(".cm-activeLine");
  await expect(activeLine).not.toContainText("Somewhere");

  await firstPage(page).getByText("unusual").dblclick();
  await expect(activeLine).toHaveText("Somewhere quite unusual");
  await expect(editor(page)).toBeFocused();
});

test("the jump shortcut scrolls the preview to the cursor", async ({
  page,
}) => {
  await createProject(page, "Jump ahead");
  await appendLine(page, "#pagebreak()");
  await appendLine(page, "= Far heading");
  const secondPage = preview(page).getByRole("img", { name: "Page 2" });
  await expect(secondPage).toContainText("Far heading");

  // Typing followed the edit down; start from the top once that is over.
  const viewport = page.getByTestId("preview-viewport");
  await page.waitForTimeout(1000);
  await viewport.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await expect(firstPage(page)).toBeInViewport();
  await expect(secondPage).not.toBeInViewport();

  await page.locator(".cm-line", { hasText: "= Far heading" }).click();
  // Mod is Ctrl under the Desktop Chrome user agent the suite runs with.
  await page.keyboard.press("Control+Alt+J");
  await expect(secondPage).toBeInViewport();
});
