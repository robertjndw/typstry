import type { Page } from "@playwright/test";

import { expect, test as base } from "../e2e/fixtures";

export * from "../e2e/fixtures";

/**
 * The static build has no server, so any request to one means a feature
 * that should have been switched off is still wired up. Aborting it makes
 * the feature fail visibly; the list makes the test fail even if the app
 * swallows the error.
 */
export const test = base.extend<{ serverRequests: string[] }>({
  serverRequests: [
    async ({ context }, use) => {
      const seen: string[] = [];
      await context.route(
        (url) => /^\/(typstry\/)?(api|ws)(\/|$)/.test(url.pathname),
        (route) => {
          seen.push(route.request().url());
          return route.abort();
        },
      );
      await use(seen);
      expect(seen).toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * Creates a project from the start page and waits for the workspace. There
 * is no connection to wait for and no key in the link, unlike the server
 * build's `createProject`.
 */
export async function createStandaloneProject(page: Page, title: string) {
  await page.goto("./");
  await page.getByLabel("Project title").fill(title);
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(page.locator(".cm-content")).toBeVisible();
  return page.url();
}

/**
 * Edits are written to IndexedDB after a typing pause, and a reload before
 * that drops them, so tests wait it out before reloading or opening the
 * project elsewhere.
 */
export async function waitForLocalSave(page: Page) {
  await page.waitForTimeout(2_000);
}
