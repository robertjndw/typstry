import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { unzipSync } from "fflate";

import {
  appendLine,
  createProject,
  editor,
  expect,
  fileTree,
  firstPage,
  openElsewhere,
  preview,
  shareLink,
  tab,
  test,
} from "./fixtures";

const RED_PNG = path.join(import.meta.dirname, "files/red.png");

async function upload(page: Page, file: string) {
  await page.getByLabel("Files to upload").setInputFiles(file);
  await expect(
    fileTree(page).getByRole("treeitem", { name: path.basename(file) }),
  ).toBeVisible();
}

function renderedImages(page: Page) {
  return firstPage(page).locator("image");
}

test("uploaded images render, also for collaborators", async ({
  page,
  browser,
}) => {
  await createProject(page, "Images");
  await upload(page, RED_PNG);

  await tab(page, "main.typ").click();
  await appendLine(page, '#image("red.png", width: 2cm)');
  await expect(renderedImages(page)).toHaveCount(1);

  // The blob is stored encrypted, so this checks the round trip through the
  // server and the key from the link.
  const other = await openElsewhere(browser, await shareLink(page, "Can edit"));
  await expect(renderedImages(other)).toHaveCount(1);
  await other.context().close();
});

test("pasting an image uploads it and inserts the markup", async ({ page }) => {
  await createProject(page, "Paste");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");

  const png = (await readFile(RED_PNG)).toString("base64");
  await editor(page).evaluate((target, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png);

  await expect(
    fileTree(page).getByRole("treeitem", { name: "pasted.png" }),
  ).toBeVisible();
  await expect(editor(page)).toContainText('#image("pasted.png")');
  await expect(renderedImages(page)).toHaveCount(1);
});

test("the project downloads as a zip with every file", async ({ page }) => {
  await createProject(page, "Zipped");
  await upload(page, RED_PNG);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const file = await (await download).path();

  const entries = unzipSync(await readFile(file));
  expect(Object.keys(entries).sort()).toEqual(["main.typ", "red.png"]);
  expect(new TextDecoder().decode(entries["main.typ"])).toContain(
    "Hello, Typst!",
  );
  expect(Buffer.from(entries["red.png"]!)).toEqual(await readFile(RED_PNG));
});

test("the compiled document downloads as a PDF", async ({ page }) => {
  await createProject(page, "Printed");
  await expect(preview(page).getByLabel("Up to date")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  const pdf = await readFile(await file.path());
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
});
