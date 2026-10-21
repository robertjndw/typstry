import path from "node:path";

import {
  appendLine,
  createStandaloneProject,
  editor,
  expect,
  fileTree,
  firstPage,
  tab,
  test,
  waitForLocalSave,
} from "./fixtures";
import {
  addPackage,
  dialog,
  openDialog,
  setMain,
} from "../e2e/fonts-packages-helpers";

const RED_PNG = path.join(import.meta.dirname, "../e2e/files/red.png");

test("a project is created, edited and survives a reload", async ({ page }) => {
  await createStandaloneProject(page, "Local");
  await expect(firstPage(page)).toBeVisible();

  await appendLine(page, "Hello static world");
  await expect(firstPage(page)).toContainText("Hello static world");

  await waitForLocalSave(page);
  await page.reload();
  await expect(editor(page)).toContainText("Hello static world");
  await expect(firstPage(page)).toContainText("Hello static world");
});

test("an uploaded image still renders after a reload", async ({ page }) => {
  await createStandaloneProject(page, "Images");
  await page.getByLabel("Files to upload").setInputFiles(RED_PNG);
  await expect(
    fileTree(page).getByRole("treeitem", { name: "red.png" }),
  ).toBeVisible();

  await tab(page, "main.typ").click();
  await appendLine(page, '#image("red.png", width: 2cm)');
  await expect(firstPage(page).locator("image")).toHaveCount(1);

  await waitForLocalSave(page);
  await page.reload();
  await expect(editor(page)).toContainText("red.png");
  await expect(firstPage(page).locator("image")).toHaveCount(1);
});

test("a deep link opens the project in a fresh page", async ({
  page,
  browser,
}) => {
  const url = await createStandaloneProject(page, "Deep");
  await appendLine(page, "Deep content");
  await expect(firstPage(page)).toContainText("Deep content");
  await waitForLocalSave(page);

  // Same storage, new page: no service worker control yet on the first
  // load, so this goes through the host's 404 fallback.
  const other = await page.context().newPage();
  await other.goto(url);
  await expect(editor(other)).toContainText("Deep content");

  // A browser without the project says so instead of hanging.
  const stranger = await browser.newContext();
  const lost = await stranger.newPage();
  await lost.goto(url);
  await expect(
    lost.getByRole("heading", { name: "Project not found" }),
  ).toBeVisible();
  await stranger.close();
});

test("the account menu offers no pairing or recovery", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: /account menu/i }).click();
  await expect(
    page.getByRole("menuitem", { name: "Name and color…" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /device/i })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /key/i })).toHaveCount(0);
});

test("the service worker serves the editor offline", async ({
  page,
  context,
}) => {
  // Precaching the compiler and tinymist wasm takes a while on a cold cache.
  test.setTimeout(180_000);
  const url = await createStandaloneProject(page, "Offline");
  await appendLine(page, "Still here offline");
  await waitForLocalSave(page);

  await page.evaluate(() => navigator.serviceWorker.ready);
  // `ready` resolves on activation, but the page only gets controlled by a
  // reload, and that reload is what the offline one is compared against.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {
      timeout: 120_000,
    })
    .toBe(true);

  await context.setOffline(true);
  await page.goto(url);
  await expect(editor(page)).toContainText("Still here offline");
  await expect(firstPage(page)).toContainText("Still here offline");
});

test("an uploaded package imports and survives a reload", async ({ page }) => {
  await createStandaloneProject(page, "Packages");
  await openDialog(page);
  await addPackage(page, "Hello from package");
  await dialog(page)
    .getByRole("form", { name: "Review package" })
    .getByRole("button", { name: "Add package" })
    .click();
  await expect(
    dialog(page).getByRole("listitem", { name: "@local/hello:0.1.0" }),
  ).toBeVisible();
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await expect(dialog(page)).toBeHidden();

  await setMain(page, ['#import "@local/hello:0.1.0": hello', "#hello"]);
  await expect(firstPage(page)).toContainText("Hello from package");

  await waitForLocalSave(page);
  await page.reload();
  await expect(firstPage(page)).toContainText("Hello from package");
});
