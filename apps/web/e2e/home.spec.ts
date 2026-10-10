import { createProject, expect, test } from "./fixtures";

test("created projects are listed and can be removed", async ({ page }) => {
  await createProject(page, "Listed");
  await page.getByRole("link", { name: "All projects" }).click();

  const recent = page.getByRole("region", { name: "Recent projects" });
  await expect(recent.getByRole("link", { name: /Listed/ })).toBeVisible();

  await recent.getByRole("button", { name: "Delete Listed" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(recent).toBeHidden();

  await page.reload();
  await expect(page.getByRole("link", { name: /Listed/ })).toBeHidden();
});

test("a link without the key explains what is missing", async ({ page }) => {
  const url = await createProject(page, "Keyless");

  // A fresh browser has no stored key for this project.
  const other = await page.context().browser()!.newPage();
  await other.goto(url.split("#")[0]!);
  await expect(
    other.getByRole("heading", { name: "This link is incomplete" }),
  ).toBeVisible();
  await other.close();
});

test("an unknown token shows not found", async ({ page }) => {
  await page.goto("/p/doesnotexist#somekey");
  await expect(
    page.getByRole("heading", { name: "Project not found" }),
  ).toBeVisible();
});
