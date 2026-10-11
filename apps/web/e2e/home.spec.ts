import { readFile } from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

import {
  createProject,
  expect,
  fileTree,
  firstPage,
  openElsewhere,
  shareLink,
  syncStatus,
  test,
} from "./fixtures";

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

test("a zip imports as a new project, assets included", async ({
  page,
  browser,
}) => {
  const png = await readFile(path.join(import.meta.dirname, "files/red.png"));
  const zip = zipSync({
    "thesis/main.typ": strToU8('#image("figures/red.png", width: 2cm)\n'),
    "thesis/figures/red.png": png,
    "thesis/.DS_Store": new Uint8Array([0]),
  });

  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import" }).click();
  await (
    await chooser
  ).setFiles({
    name: "export.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });

  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(
    page.getByRole("button", { name: /Project title: thesis\./ }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "main.typ" }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: ".DS_Store" }),
  ).toBeHidden();
  await expect(firstPage(page).locator("image")).toHaveCount(1);

  // A collaborator only gets the image from the server, so this checks the
  // upload actually happened.
  const other = await openElsewhere(browser, await shareLink(page, "Can edit"));
  await expect(firstPage(other).locator("image")).toHaveCount(1);
  await other.context().close();
});

test("dropping a zip on the start page imports it", async ({ page }) => {
  const zip = zipSync({ "paper/main.typ": strToU8("= Dropped\n") });

  await page.goto("/");
  const data = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(bytes)], "paper.zip", {
        type: "application/zip",
      }),
    );
    return transfer;
  }, Array.from(zip));
  await page.dispatchEvent("main", "dragenter", { dataTransfer: data });
  await expect(page.getByText("Drop to import")).toBeVisible();
  await page.dispatchEvent("main", "drop", { dataTransfer: data });

  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(
    page.getByRole("button", { name: /Project title: paper\./ }),
  ).toBeVisible();
  await expect(firstPage(page)).toBeVisible();
});

test("a name changed on the start page shows up in a project", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^You are E2E Tester/ }).click();
  await page.getByRole("menuitem", { name: "Name and color…" }).click();
  await page.getByRole("textbox", { name: "Your name" }).fill("Renamed Tester");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("button", { name: /^You are Renamed Tester/ }),
  ).toBeVisible();

  // The fixture seeds the identity on every navigation, so create the
  // project without a reload, the way createProject would after its goto.
  await page.getByLabel("Project title").fill("Named");
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(
    page.getByRole("banner").getByRole("button", {
      name: /^You are Renamed Tester/,
    }),
  ).toBeVisible();
});
