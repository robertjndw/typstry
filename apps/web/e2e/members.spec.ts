import type { Locator, Page } from "@playwright/test";

import {
  appendLine,
  createProject,
  editor,
  expect,
  openElsewhere,
  shareLink,
  syncStatus,
  test,
} from "./fixtures";

function tokenOf(page: Page): string {
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function openShare(page: Page) {
  await page.getByRole("button", { name: "Share" }).click();
  return page.getByRole("dialog", { name: "Share project" });
}

function members(dialog: Locator) {
  return dialog.getByRole("list", { name: "Members" }).getByRole("listitem");
}

async function closeShare(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Share project" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function removeMember(page: Page, name: string) {
  const dialog = await openShare(page);
  await dialog.getByRole("button", { name: `Remove ${name}` }).click();
  const confirm = page.getByRole("dialog", { name: `Remove ${name}?` });
  await expect(confirm).toContainText("links change");
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toBeHidden();
  await closeShare(page);
}

async function resetLinks(page: Page) {
  const dialog = await openShare(page);
  await dialog.getByRole("button", { name: "Reset links" }).click();
  const confirm = page.getByRole("dialog", { name: "Reset the links?" });
  await confirm.getByRole("button", { name: "Reset links" }).click();
  await expect(confirm).toBeHidden();
  await closeShare(page);
}

/** Waits until the page moved to a different token on its own. */
async function expectNewToken(page: Page, before: string) {
  await expect.poll(() => tokenOf(page)).not.toBe(before);
  await expect(syncStatus(page)).toHaveText("Connected");
}

test("members who join with the edit link are listed with their names", async ({
  page,
  browser,
}) => {
  await createProject(page, "Members");
  const other = await openElsewhere(
    browser,
    await shareLink(page, "Can edit"),
    "Second Tester",
  );

  // The name is typed after the join, so it reaches the roster as a profile
  // update; both sides end up with the same list.
  for (const [viewer, self, peer] of [
    [page, "E2E Tester", "Second Tester"],
    [other, "Second Tester", "E2E Tester"],
  ] as const) {
    const list = members(await openShare(viewer));
    await expect(list).toHaveCount(2);
    await expect(list.filter({ hasText: self })).toContainText("you");
    await expect(list.filter({ hasText: peer })).toContainText("Editor");
    await closeShare(viewer);
  }

  await other.context().close();
});

test("the view link joins as a viewer who cannot change members", async ({
  page,
  browser,
}) => {
  await createProject(page, "Roles");
  const viewer = await openElsewhere(
    browser,
    await shareLink(page, "Can view"),
    "Watcher",
  );

  const owner = await openShare(page);
  await expect(members(owner).filter({ hasText: "Watcher" })).toContainText(
    "Viewer",
  );
  await expect(
    owner.getByRole("button", { name: "Remove Watcher" }),
  ).toBeVisible();
  await closeShare(page);

  const theirs = await openShare(viewer);
  await expect(members(theirs)).toHaveCount(2);
  await expect(members(theirs).filter({ hasText: "Watcher" })).toContainText(
    "you",
  );
  await expect(theirs.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(theirs.getByRole("button", { name: "Reset links" })).toHaveCount(
    0,
  );

  await viewer.context().close();
});

test("removing a viewer cuts them off and moves the others to new links", async ({
  page,
  browser,
}) => {
  await createProject(page, "Removal");
  const second = await openElsewhere(
    browser,
    await shareLink(page, "Can edit"),
    "Second Tester",
  );
  const oldViewLink = await shareLink(page, "Can view");
  const watcher = await openElsewhere(browser, oldViewLink, "Watcher");
  await appendLine(page, "Before the removal");
  await expect(editor(watcher)).toContainText("Before the removal");

  const before = { first: tokenOf(page), second: tokenOf(second) };
  await removeMember(page, "Watcher");

  // Both editors follow to the new links without anyone doing anything.
  await expectNewToken(page, before.first);
  await expectNewToken(second, before.second);

  // The removed device is told so and does not get the new content.
  await expect(
    watcher.getByRole("heading", {
      name: "You were removed from this project",
    }),
  ).toBeVisible();
  await appendLine(page, "After the removal");
  await expect(editor(second)).toContainText("After the removal");
  await watcher.reload();
  await expect(
    watcher.getByRole("heading", {
      name: "You were removed from this project",
    }),
  ).toBeVisible();
  await expect(watcher.getByText("After the removal")).toHaveCount(0);

  // The old view link no longer opens anything for a newcomer.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(oldViewLink);
  await expect(stranger.getByText("This link was replaced")).toBeVisible();

  // Edits keep flowing between the members who remain.
  await appendLine(second, "From the second editor");
  await expect(editor(page)).toContainText("From the second editor");

  // The roster no longer lists the removed device.
  const dialog = await openShare(page);
  await expect(members(dialog)).toHaveCount(2);
  await expect(members(dialog).filter({ hasText: "Watcher" })).toHaveCount(0);

  for (const p of [second, watcher, stranger]) await p.context().close();
});

test("resetting the links replaces them for everyone who stays", async ({
  page,
  browser,
}) => {
  await createProject(page, "Reset");
  const oldEditLink = await shareLink(page, "Can edit");
  const second = await openElsewhere(browser, oldEditLink, "Second Tester");
  const before = { first: tokenOf(page), second: tokenOf(second) };

  const dialog = await openShare(page);
  await dialog.getByRole("button", { name: "Reset links" }).click();
  const confirm = page.getByRole("dialog", { name: "Reset the links?" });
  await confirm.getByRole("button", { name: "Reset links" }).click();
  await expect(confirm).toBeHidden();
  await closeShare(page);

  await expectNewToken(page, before.first);
  await expectNewToken(second, before.second);

  // The old link is dead for a newcomer, the new one works.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(oldEditLink);
  await expect(stranger.getByText("This link was replaced")).toBeVisible();

  const newEditLink = await shareLink(page, "Can edit");
  expect(newEditLink).not.toBe(oldEditLink);
  const fresh = await openElsewhere(browser, newEditLink, "Newcomer");
  await expect(editor(fresh)).toContainText("Hello, Typst!");
  await appendLine(fresh, "From the newcomer");
  await expect(editor(page)).toContainText("From the newcomer");
  await expect(editor(second)).toContainText("From the newcomer");

  for (const p of [second, stranger, fresh]) await p.context().close();
});

test("an editor who was offline follows a rotation when it reconnects", async ({
  page,
  browser,
}) => {
  await createProject(page, "Offline rotation");
  const second = await openElsewhere(
    browser,
    await shareLink(page, "Can edit"),
    "Second Tester",
  );
  const watcher = await openElsewhere(
    browser,
    await shareLink(page, "Can view"),
    "Watcher",
  );
  const before = tokenOf(second);

  await second.context().setOffline(true);
  await expect(syncStatus(second)).toHaveText("Offline");
  await removeMember(page, "Watcher");
  await appendLine(page, "While the second editor was away");

  await second.context().setOffline(false);
  await expectNewToken(second, before);
  await expect(editor(second)).toContainText(
    "While the second editor was away",
  );

  // And it can write under the new links.
  await appendLine(second, "Back again");
  await expect(editor(page)).toContainText("Back again");

  for (const p of [second, watcher]) await p.context().close();
});

test("an editor who was offline across several rotations hops to the current links", async ({
  page,
  browser,
}) => {
  await createProject(page, "Several rotations");
  const second = await openElsewhere(
    browser,
    await shareLink(page, "Can edit"),
    "Second Tester",
  );
  const first = tokenOf(page);
  const before = tokenOf(second);

  await second.context().setOffline(true);
  await expect(syncStatus(second)).toHaveText("Offline");
  await resetLinks(page);
  await expect.poll(() => tokenOf(page)).not.toBe(first);
  const middle = tokenOf(page);
  await resetLinks(page);
  await expect.poll(() => tokenOf(page)).not.toBe(middle);
  await appendLine(page, "Written under the third links");

  // Its token only reads up to the first rotation; each one it reads hands
  // it the token for the next.
  await second.context().setOffline(false);
  await expectNewToken(second, before);
  await expect.poll(() => tokenOf(second)).toBe(tokenOf(page));
  await expect(editor(second)).toContainText("Written under the third links");
  await appendLine(second, "Caught up");
  await expect(editor(page)).toContainText("Caught up");

  await second.context().close();
});
