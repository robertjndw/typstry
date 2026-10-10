import type { Page } from "@playwright/test";

import {
  appendLine,
  createProject,
  editor,
  expect,
  firstPage,
  openElsewhere,
  preview,
  shareLink,
  syncStatus,
  test,
} from "./fixtures";

// The app picks Cmd or Ctrl from the user agent, and the "Desktop Chrome"
// device reports Windows even on a Mac host, so ControlOrMeta would send
// Cmd there and miss.
function syncNow(page: Page) {
  return page.keyboard.press("Control+s");
}

test("edits made offline sync once back online", async ({
  page,
  context,
  browser,
}) => {
  await createProject(page, "Offline");
  const other = await openElsewhere(browser, await shareLink(page, "Can edit"));
  // Losing the renderer download is its own test below; here the preview
  // should already be up.
  await expect(firstPage(page)).toBeVisible();

  await context.setOffline(true);
  await expect(syncStatus(page)).toHaveText("Offline");

  // Compiling happens in the browser, so the preview keeps working.
  await appendLine(page, "Written offline");
  await expect(firstPage(page)).toContainText("Written offline");
  await appendLine(other, "Written meanwhile");

  // Used to stay "Offline" for good: loro-websocket closed the socket with
  // a code browsers reject, so it never noticed it had to reconnect. Patched
  // locally until the upstream fix ships, see patches/README.md.
  await context.setOffline(false);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(editor(other)).toContainText("Written offline");
  await expect(editor(page)).toContainText("Written meanwhile");

  await other.context().close();
});

test("a project opens from local storage without the server", async ({
  page,
  context,
}) => {
  await createProject(page, "Local");
  await appendLine(page, "Kept in this browser");
  await expect(editor(page)).toContainText("Kept in this browser");
  // Syncing by hand writes IndexedDB before it reports back, so there is no
  // need to wait out LocalDocStore's debounce.
  await syncNow(page);
  await expect(page.getByText("All changes synced")).toBeVisible();

  // The page itself still loads, but the API and sync socket are gone, as
  // if the server were down.
  await context.route("**/api/**", (route) => route.abort());
  await context.routeWebSocket("**/ws", (ws) => ws.close());
  await page.reload();

  await expect(editor(page)).toContainText("Kept in this browser");
  await expect(syncStatus(page)).not.toHaveText("Connected");
  await expect(firstPage(page)).toContainText("Kept in this browser");
});

test("Mod+S syncs right away and says when the server is unreachable", async ({
  page,
  context,
}) => {
  await createProject(page, "Sync now");
  await appendLine(page, "Pushed by hand");
  await syncNow(page);
  await expect(page.getByText("All changes synced")).toBeVisible();

  await context.setOffline(true);
  await expect(syncStatus(page)).toHaveText("Offline");
  await syncNow(page);
  await expect(page.getByText(/saved on this device/)).toBeVisible();
});

test("the preview recovers if its renderer failed to load", async ({
  page,
  context,
}) => {
  // As if the connection dropped right after the page loaded, before the
  // renderer was fetched.
  const renderer = /wasm-pack-shim|typst_ts_renderer_bg/;
  await context.route(renderer, (route) => route.abort());
  await createProject(page, "Late preview");
  await expect(
    preview(page).getByText(/Could not load the preview/),
  ).toBeVisible();

  await context.unroute(renderer);
  // Toggling fires the online event the preview waits for.
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(firstPage(page)).toContainText("Late preview");
});
