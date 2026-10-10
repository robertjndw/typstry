import type { Page } from "@playwright/test";

import {
  appendLine,
  createProject,
  editor,
  expect,
  test,
  versions,
} from "./fixtures";

async function saveVersion(page: Page, name: string) {
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Save version" }).click();
  await page.getByLabel("Version name").fill(name);
  await page.getByLabel("Version name").press("Enter");
  await expect(versions(page).getByRole("button", { name })).toBeVisible();
  await page.keyboard.press("Escape");
}

async function openVersion(page: Page, name: string) {
  await page.getByRole("button", { name: "History", exact: true }).click();
  await versions(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByText(`Viewing ${name}`)).toBeVisible();
}

test("saved versions can be browsed and show their changes", async ({
  page,
}) => {
  await createProject(page, "History");
  await saveVersion(page, "First draft");
  await appendLine(page, "Second thoughts");
  await saveVersion(page, "Second draft");

  await openVersion(page, "Second draft");
  await expect(
    page
      .getByRole("region", { name: "Changes in this version" })
      .getByRole("button", { name: /main\.typ/ }),
  ).toBeVisible();

  // Versions are compared with the last edit session before them, and in a
  // test everything lands in one session, so the whole file counts as new.
  await page.getByRole("button", { name: "Show changes" }).click();
  const diff = page
    .getByRole("region", { name: "Editor" })
    .getByLabel("Changes");
  await expect(
    diff.getByRole("insertion").filter({ hasText: "Second thoughts" }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Back to live", exact: true }).click();
  await openVersion(page, "First draft");
  await expect(editor(page)).toContainText("Hello, Typst!");
  await expect(editor(page)).not.toContainText("Second thoughts");
});

test("restoring a version rolls the project back", async ({ page }) => {
  await createProject(page, "Restore");
  await saveVersion(page, "Clean");
  await appendLine(page, "A mistake");
  await expect(editor(page)).toContainText("A mistake");

  await openVersion(page, "Clean");
  await expect(editor(page)).not.toContainText("A mistake");
  await page.getByRole("button", { name: "Restore this version" }).click();
  await page
    .getByRole("dialog", { name: "Restore this version?" })
    .getByRole("button", { name: "Restore" })
    .click();

  await expect(page.getByText('Restored "Clean"')).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to live" })).toBeHidden();
  await expect(editor(page)).toContainText("Hello, Typst!");
  await expect(editor(page)).not.toContainText("A mistake");
});
