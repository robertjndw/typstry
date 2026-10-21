import type { Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

import { editor, expect, preview, tab } from "./fixtures";

export function packageZip(text: string) {
  return {
    name: "hello.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      zipSync({
        "typst.toml": strToU8(
          '[package]\nname = "hello"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n',
        ),
        "lib.typ": strToU8(`#let hello = [${text}]\n`),
      }),
    ),
  };
}

export function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Fonts & Packages" });
}

export async function openDialog(page: Page) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Fonts & packages/ }).click();
  await expect(dialog(page)).toBeVisible();
}

export function diagnostics(page: Page) {
  return preview(page).getByLabel("Diagnostics");
}

/** Replaces the whole main.typ, going through the editor like a user. */
export async function setMain(page: Page, lines: string[]) {
  await tab(page, "main.typ").click();
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(line);
    // Keeps tinymist's completion popup from swallowing the next Enter.
    await page.keyboard.press("Escape");
  }
}

export async function addPackage(page: Page, text: string) {
  await dialog(page)
    .getByRole("tab", { name: /Packages/ })
    .click();
  await dialog(page)
    .getByLabel("Choose archive", { exact: true })
    .setInputFiles(packageZip(text));
}
