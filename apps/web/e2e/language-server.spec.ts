import type { Page } from "@playwright/test";

import {
  createEntry,
  createProject,
  editor,
  expect,
  startLine,
  tab,
  test,
} from "./fixtures";

/**
 * Waits for a completion option and returns it. tinymist boots in its own
 * worker after the editor is already usable, so text typed early gets no
 * server completions; reopening the popup asks again.
 */
async function completion(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The accessible name is the label followed by the detail, if any.
  const option = page
    .getByRole("listbox", { name: "Completions" })
    .getByRole("option", { name: new RegExp(`^${escaped}(\\s|$)`) })
    .first();
  await expect(async () => {
    if (!(await option.isVisible())) await page.keyboard.press("Control+Space");
    await expect(option).toBeVisible({ timeout: 2_000 });
  }).toPass();
  return option;
}

test("built-in functions are completed", async ({ page }) => {
  await createProject(page, "Builtins");

  await startLine(page);
  await page.keyboard.type("#tab");
  await (await completion(page, "table")).click();

  await expect(editor(page).locator(".cm-line").last()).toHaveText(/^#table/);
});

test("functions defined in the project are completed", async ({ page }) => {
  await createProject(page, "Own functions");

  await startLine(page);
  await page.keyboard.type("#let greet(name) = [Hello, #name!]");
  await page.keyboard.press("Escape");
  await startLine(page);
  await page.keyboard.type("#gre");
  await (await completion(page, "greet")).click();

  await expect(editor(page).locator(".cm-line").last()).toHaveText(/^#greet/);
});

test("calls get signature help and parameter completion", async ({ page }) => {
  await createProject(page, "Signatures");

  await startLine(page);
  await page.keyboard.type("#tab");
  await (await completion(page, "table")).click();
  await page.keyboard.press("End");
  await page.keyboard.type("(");

  const signature = page.locator(".cm-lsp-signature-tooltip");
  await expect(signature).toContainText("table(");
  await expect(signature).toContainText("columns");

  await page.keyboard.type("col");
  await expect(await completion(page, "columns")).toBeVisible();
});

test("hovering a function shows its docs", async ({ page }) => {
  await createProject(page, "Hover");

  const name = editor(page)
    .locator(".cm-line", { hasText: "#set page" })
    .getByText("page", { exact: true });
  const tooltip = page.locator(".cm-tooltip-hover");
  await expect(async () => {
    // Moving away first so the next hover starts a fresh request.
    await page.mouse.move(0, 0);
    await name.hover();
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(tooltip).toContainText("paper");
});

test("file paths are completed from the project", async ({ page }) => {
  await createProject(page, "Paths");

  await createEntry(page, "chapter.typ");
  await tab(page, "main.typ").click();

  await startLine(page);
  await page.keyboard.type('#include "');
  await (await completion(page, "chapter.typ")).click();

  await expect(editor(page).locator(".cm-line").last()).toHaveText(
    '#include "chapter.typ"',
  );
});
