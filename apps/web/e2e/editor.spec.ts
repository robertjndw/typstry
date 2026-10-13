import {
  appendLine,
  createEntry,
  createProject,
  editor,
  expect,
  firstPage,
  preview,
  tab,
  test,
} from "./fixtures";

test("a new project opens with the starter file compiled", async ({ page }) => {
  await createProject(page, "Starter");

  await expect(page).toHaveTitle("Starter · typstry");
  await expect(tab(page, "main.typ")).toHaveAttribute("aria-selected", "true");
  await expect(editor(page)).toContainText("Hello, Typst!");
  const page1 = firstPage(page);
  await expect(page1).toContainText("Starter");
  await expect(page1).toContainText("Hello, Typst!");
});

test("edits show up in the preview and survive a reload", async ({ page }) => {
  await createProject(page, "Edits");

  await appendLine(page, "Written by Playwright");
  await expect(firstPage(page)).toContainText("Written by Playwright");

  await page.reload();
  await expect(editor(page)).toContainText("Written by Playwright");
});

test.describe(() => {
  // Chrome checks the CSP as soon as DOMParser meets the handler attribute,
  // before the sanitizer gets to remove it. Nothing runs either way.
  test.use({ expectedCspViolations: [/Executing inline event handler/] });

  test("links in a document cannot run script in the app", async ({ page }) => {
    await createProject(page, "Links");

    // typst.ts puts `@typst:` link targets into an onclick verbatim.
    await appendLine(
      page,
      '#link("@typst:window.pwned=1")[#block(width: 100%, height: 40pt)[Trap]]',
    );
    const trap = firstPage(page).locator("a").last();
    await expect(firstPage(page)).toContainText("Trap");
    await trap.hover();
    await trap.click({ force: true });
    expect(await page.evaluate(() => "pwned" in window)).toBe(false);
    await expect(trap).not.toHaveAttribute("onclick");
  });
});

test("compile errors are listed and jump to the source", async ({ page }) => {
  await createProject(page, "Errors");

  await appendLine(page, "#undefinedthing");
  const diagnostics = preview(page).getByLabel("Diagnostics");
  const error = diagnostics.getByRole("button", {
    name: /main\.typ:\d+:\d+ unknown variable: undefinedthing/,
  });
  await expect(error).toBeVisible();
  await expect(preview(page).getByText("1 error")).toBeVisible();

  // Clicking the error puts the cursor on the offending line.
  await error.click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Delete");
  await expect(diagnostics).toBeHidden();
  await expect(preview(page).getByLabel("Up to date")).toBeVisible();
});

test("the project can be renamed", async ({ page }) => {
  await createProject(page, "Old name");

  await page.getByRole("button", { name: /Project title: Old name/ }).click();
  const input = page.getByRole("textbox", { name: "Project title" });
  await input.fill("New name");
  await input.press("Enter");

  await expect(page).toHaveTitle("New name · typstry");
  await page.getByRole("link", { name: "All projects" }).click();
  await expect(page.getByRole("link", { name: /New name/ })).toBeVisible();
});

test("an error in another file opens it at the offending line", async ({
  page,
}) => {
  await createProject(page, "Cross-file errors");

  await createEntry(page, "chapter.typ");
  await editor(page).click();
  await page.keyboard.type("First line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("#undefinedthing");

  await tab(page, "main.typ").click();
  await appendLine(page, '#include "chapter.typ"');
  const error = preview(page)
    .getByLabel("Diagnostics")
    .getByRole("button", {
      name: /chapter\.typ:2:\d+ unknown variable: undefinedthing/,
    });
  await expect(error).toBeVisible();

  // The click swaps the editor to chapter.typ and must still land on line 2
  // of the new file, not get lost with main.typ's editor.
  await error.click();
  await expect(tab(page, "chapter.typ")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Delete");
  await expect(editor(page)).not.toContainText("undefinedthing");
  await expect(editor(page)).toContainText("First line");
});
