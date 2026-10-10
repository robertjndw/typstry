import {
  appendLine,
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
