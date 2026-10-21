import {
  appendLine,
  createProject,
  editor,
  expect,
  firstPage,
  preview,
  test,
} from "./fixtures";

// Mod is Ctrl under the Desktop Chrome user agent the suite runs with.
const MOD_CLICK = { modifiers: ["Control" as const] };

test("Mod+Click in the preview puts the cursor on that line", async ({
  page,
}) => {
  await createProject(page, "Jump back");
  await appendLine(page, "Somewhere quite unusual");
  await expect(firstPage(page)).toContainText("Somewhere quite unusual");

  // Away from the line, so the jump has somewhere to go.
  await page.keyboard.press("ControlOrMeta+Home");
  const activeLine = page.locator(".cm-activeLine");
  await expect(activeLine).not.toContainText("Somewhere");

  await firstPage(page).getByText("unusual").click(MOD_CLICK);
  await expect(activeLine).toHaveText("Somewhere quite unusual");
  await expect(editor(page)).toBeFocused();
  // Marked for a moment, so it is easy to spot where the jump landed.
  await expect(page.locator(".cm-flash")).toHaveText("Somewhere quite unusual");
  await expect(page.locator(".cm-flash")).toHaveCount(0);
});

test("Mod+Click in the editor scrolls the preview there", async ({ page }) => {
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

  await page
    .locator(".cm-line", { hasText: "= Far heading" })
    .getByText("Far heading")
    .click(MOD_CLICK);
  await expect(secondPage).toBeInViewport();
});

test("Mod+Click on a name goes to its definition", async ({ page }) => {
  await createProject(page, "Jump to definition");
  await appendLine(page, "#let greeting = [Hello there]");
  await appendLine(page, "#pagebreak()");
  // Alone on its line, so a click in the middle of the line lands on it.
  await appendLine(page, "#greeting");
  await expect(
    preview(page).getByRole("img", { name: "Page 2" }),
  ).toContainText("Hello there");

  const activeLine = page.locator(".cm-activeLine");
  const use = page.locator(".cm-line", { hasText: /^#greeting$/ });
  // tinymist may still be starting, in which case the click lands in the
  // preview instead; trying again once it answers is what a user would do.
  await expect(async () => {
    await use.click(MOD_CLICK);
    await expect(activeLine).toHaveText("#let greeting = [Hello there]", {
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator(".cm-flash")).toHaveText(
    "#let greeting = [Hello there]",
  );
});
