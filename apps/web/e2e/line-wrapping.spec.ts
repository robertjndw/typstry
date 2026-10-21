import { appendLine, createProject, editor, expect, test } from "./fixtures";

const LONG_LINE = "word ".repeat(120).trim();

async function setWrapping(page: import("@playwright/test").Page, on: boolean) {
  await page.getByRole("button", { name: "More actions" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Wrap lines" });
  if ((await item.getAttribute("aria-checked")) !== String(on)) {
    await item.click();
  } else {
    await page.keyboard.press("Escape");
  }
}

test("lines can be wrapped, and the choice is remembered", async ({ page }) => {
  await createProject(page, "Wrapping");
  await appendLine(page, LONG_LINE);
  const line = editor(page).locator(".cm-line", { hasText: "word word" });
  const unwrapped = (await line.boundingBox())!.height;

  await setWrapping(page, true);
  await expect
    .poll(async () => (await line.boundingBox())!.height)
    .toBeGreaterThan(unwrapped * 2);

  await page.reload();
  const reloaded = editor(page).locator(".cm-line", { hasText: "word word" });
  await expect
    .poll(async () => (await reloaded.boundingBox())!.height)
    .toBeGreaterThan(unwrapped * 2);

  await setWrapping(page, false);
  await expect
    .poll(async () => (await reloaded.boundingBox())!.height)
    .toBeLessThan(unwrapped * 1.5);
});
