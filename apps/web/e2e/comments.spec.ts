import type { Page } from "@playwright/test";

import {
  appendLine,
  createProject,
  editor,
  expect,
  expectConverged,
  openElsewhere,
  shareLink,
  test,
} from "./fixtures";

const PHRASE = "Needs a citation here";

function thread(page: Page) {
  return page.getByRole("article", { name: /^Comment by / });
}

function highlights(page: Page) {
  return editor(page).locator(".cm-comment");
}

async function openComments(page: Page) {
  // Its name carries the count of open threads.
  await page.getByRole("tab", { name: /^Comments/ }).click();
}

test("editors comment, reply and resolve; viewers only read", async ({
  page,
  browser,
}) => {
  await createProject(page, "Comments");
  await appendLine(page, PHRASE);
  await page.keyboard.press("Shift+Home");

  // The app's Mod is Ctrl under Playwright's Desktop Chrome user agent.
  await page.keyboard.press("Control+Alt+M");
  const composer = page.getByRole("form", { name: "New comment" });
  await expect(composer).toContainText(PHRASE);
  await composer.getByRole("textbox", { name: "Comment" }).fill("Which one?");
  await composer.getByRole("button", { name: "Comment" }).click();
  await expect(thread(page)).toContainText("Which one?");
  await expect(highlights(page).first()).toBeVisible();

  const other = await openElsewhere(browser, await shareLink(page, "Can edit"));
  await expectConverged([page, other], [PHRASE]);
  await expect(highlights(other).first()).toBeVisible();
  await expect(other.getByRole("tab", { name: "Comments (1)" })).toBeVisible();
  await openComments(other);
  await expect(thread(other)).toContainText("Which one?");
  await thread(other).getByRole("textbox", { name: "Reply" }).fill("Smith");
  await thread(other).getByRole("button", { name: "Reply" }).click();
  await expect(thread(page)).toContainText("Smith");

  const viewer = await openElsewhere(
    browser,
    await shareLink(page, "Can view"),
    "Watcher",
  );
  await openComments(viewer);
  await expect(thread(viewer)).toContainText("Which one?");
  await expect(thread(viewer)).toContainText("Smith");
  await expect(viewer.getByRole("textbox", { name: "Reply" })).toHaveCount(0);
  await expect(
    viewer.getByRole("button", { name: "Resolve", exact: true }),
  ).toHaveCount(0);
  await editor(viewer).click();
  await viewer.keyboard.press("ControlOrMeta+A");
  await expect(viewer.getByRole("button", { name: "New comment" })).toHaveCount(
    0,
  );
  await viewer.keyboard.press("Control+Alt+M");
  await expect(viewer.getByRole("form", { name: "New comment" })).toHaveCount(
    0,
  );

  await thread(page).getByRole("button", { name: "Resolve" }).click();
  await expect(thread(other)).toHaveCount(0);
  await expect(highlights(other)).toHaveCount(0);
  await other.getByRole("button", { name: "Show resolved" }).click();
  await expect(
    thread(other).getByRole("button", { name: "Reopen" }),
  ).toBeVisible();

  for (const p of [other, viewer]) await p.context().close();
});
