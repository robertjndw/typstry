import type { Page } from "@playwright/test";

import {
  appendLine,
  createProject,
  expect,
  firstPage,
  preview,
  startLine,
  test,
} from "./fixtures";

test("the preview scrolls to an edit on a later page", async ({ page }) => {
  await createProject(page, "Follow");

  await appendLine(page, "#for i in range(4) [Chapter #i #pagebreak()]");
  const lastPage = preview(page).getByRole("img", { name: "Page 5" });
  await expect(
    preview(page).getByRole("img", { name: "Page 4" }),
  ).toContainText("Chapter 3");
  await expect(lastPage).toBeAttached();
  await expect(firstPage(page)).toBeVisible();

  // Typing the loop followed it down the document; go back to the start,
  // once whatever scrolling that left behind is over.
  const viewport = page.getByTestId("preview-viewport");
  await page.waitForTimeout(1000);
  await viewport.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await expect(firstPage(page)).toBeInViewport();
  await expect(lastPage).not.toBeInViewport();

  await startLine(page);
  await page.keyboard.type("Written far below");
  await expect(lastPage).toContainText("Written far below");
  await expect(lastPage).toBeInViewport();
  await expect(firstPage(page)).not.toBeInViewport();
});

// Counts the animations the preview starts on its own page elements, since
// they are over in about 100 ms and a poll would miss them.
const countPreviewAnimations = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __previewAnimations?: number };
    w.__previewAnimations = 0;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args) {
      if (this.closest(".typst-preview") && this instanceof SVGElement)
        w.__previewAnimations!++;
      return original.apply(this, args);
    };
  });

const startedAnimations = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __previewAnimations?: number })
        .__previewAnimations ?? 0,
  );

test("typing animates the glyphs in the preview", async ({ page }) => {
  await createProject(page, "Typing animation");
  await appendLine(page, "Animated words in a line of text");
  await expect(firstPage(page)).toContainText("Animated words");

  await countPreviewAnimations(page);
  await page.keyboard.press("Home");
  await page.keyboard.type("New ");
  await expect(firstPage(page)).toContainText("New Animated");
  expect(await startedAnimations(page)).toBeGreaterThan(0);
});

test("typing does not animate with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createProject(page, "Reduced motion");
  await appendLine(page, "Still words in a line of text");
  await expect(firstPage(page)).toContainText("Still words");

  await countPreviewAnimations(page);
  await page.keyboard.press("Home");
  await page.keyboard.type("New ");
  await expect(firstPage(page)).toContainText("New Still");
  expect(await startedAnimations(page)).toBe(0);
});
