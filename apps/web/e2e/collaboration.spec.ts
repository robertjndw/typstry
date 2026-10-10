import {
  appendLine,
  createProject,
  editor,
  expect,
  firstPage,
  openElsewhere,
  shareLink,
  test,
  versions,
} from "./fixtures";

test("edits sync live between two browsers", async ({ page, browser }) => {
  await createProject(page, "Together");
  const other = await openElsewhere(browser, await shareLink(page, "Can edit"));

  await expect(editor(other)).toContainText("Hello, Typst!");

  await appendLine(page, "From the first browser");
  await expect(editor(other)).toContainText("From the first browser");

  await appendLine(other, "From the second browser");
  await expect(editor(page)).toContainText("From the second browser");
  await expect(firstPage(page)).toContainText("From the second browser");

  await other.context().close();
});

test("collaborators see each other and each other's cursors", async ({
  page,
  browser,
}) => {
  await createProject(page, "Presence");
  const other = await openElsewhere(browser, await shareLink(page, "Can edit"));

  const people = page.getByRole("list", { name: "People in this project" });
  await expect(
    people.getByRole("listitem", { name: /^Second Tester/ }),
  ).toBeVisible();
  await expect(
    other
      .getByRole("list", { name: "People in this project" })
      .getByRole("listitem", { name: /^E2E Tester/ }),
  ).toBeVisible();

  await editor(other).click();
  await expect(
    people.getByRole("listitem", { name: /^Second Tester/ }),
  ).toHaveAccessibleName("Second Tester, in main.typ");
  await expect(editor(page).locator(".cm-remote-caret")).toHaveCount(1);
  await expect(editor(page).locator(".cm-remote-label")).toHaveText(
    "Second Tester",
  );

  // Closing the tab (with its pagehide) takes the avatar away right away,
  // rather than after the presence timeout.
  await other.close({ runBeforeUnload: true });
  await expect(people).toBeHidden();
  await other.context().close();
});

test("the view link opens the project read-only", async ({ page, browser }) => {
  await createProject(page, "Read only");
  const viewer = await openElsewhere(
    browser,
    await shareLink(page, "Can view"),
  );

  await expect(
    viewer
      .getByRole("region", { name: "Editor" })
      .getByText("Read only", { exact: true }),
  ).toBeVisible();
  await expect(editor(viewer)).toHaveAttribute("contenteditable", "false");
  for (const name of ["New file", "New folder", "Upload files"]) {
    await expect(viewer.getByRole("button", { name })).toBeHidden();
  }

  await appendLine(page, "Visible to viewers");
  await expect(editor(viewer)).toContainText("Visible to viewers");

  // History can be browsed, but nothing in it can be changed.
  await viewer.getByRole("button", { name: "History" }).click();
  await expect(versions(viewer)).toBeVisible();
  await expect(
    viewer
      .getByRole("dialog", { name: "History" })
      .getByRole("button", { name: "Save version" }),
  ).toBeHidden();
  await versions(viewer).getByRole("button").first().click();
  await expect(
    viewer.getByRole("button", { name: "Back to live" }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "Restore this version" }),
  ).toBeHidden();

  await viewer.context().close();
});
