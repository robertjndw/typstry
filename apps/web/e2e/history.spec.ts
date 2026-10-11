import {
  appendLine,
  createProject,
  downloadPdf,
  editor,
  expect,
  firstPage,
  openVersion,
  tab,
  tagVersion,
  test,
  versionRow,
  versions,
} from "./fixtures";

test("tagged versions can be browsed and show their changes", async ({
  page,
}) => {
  await createProject(page, "History");
  await tagVersion(page, "First draft");
  await appendLine(page, "Second thoughts");
  await tagVersion(page, "Second draft");

  await openVersion(page, "Second draft");
  await expect(
    page
      .getByRole("region", { name: "Changes in this version" })
      .getByRole("button", { name: /main\.typ/ }),
  ).toBeVisible();

  // Versions are compared with the last edit session before them, and in a
  // test everything lands in one session, so the whole file counts as new.
  await page.getByRole("button", { name: "Show changes" }).click();
  const diff = page
    .getByRole("region", { name: "Editor" })
    .getByLabel("Changes");
  await expect(
    diff.getByRole("insertion").filter({ hasText: "Second thoughts" }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Back to live", exact: true }).click();
  await openVersion(page, "First draft");
  await expect(editor(page)).toContainText("Hello, Typst!");
  await expect(editor(page)).not.toContainText("Second thoughts");
});

test("restoring a version rolls the project back", async ({ page }) => {
  await createProject(page, "Restore");
  await tagVersion(page, "Clean");
  await appendLine(page, "A mistake");
  await expect(editor(page)).toContainText("A mistake");

  await openVersion(page, "Clean");
  await expect(editor(page)).not.toContainText("A mistake");
  await page.getByRole("button", { name: "Restore this version" }).click();
  await page
    .getByRole("dialog", { name: "Restore this version?" })
    .getByRole("button", { name: "Restore" })
    .click();

  await expect(page.getByText('Restored "Clean"')).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to live" })).toBeHidden();
  await expect(editor(page)).toContainText("Hello, Typst!");
  await expect(editor(page)).not.toContainText("A mistake");
});

test("versions can be previewed, diffed and untagged from the history", async ({
  page,
}) => {
  await createProject(page, "Shortcuts");
  await tagVersion(page, "First draft");
  await appendLine(page, "Second thoughts");
  await tagVersion(page, "Second draft");

  await page.getByRole("button", { name: "History", exact: true }).click();
  await versionRow(page, "First draft")
    .getByRole("button", { name: "Preview" })
    .click();
  const preview = page.getByRole("dialog", { name: "First draft" });
  await expect(preview.getByRole("img", { name: "Page 1" })).toContainText(
    "Hello, Typst!",
  );
  await expect(preview.getByRole("img", { name: "Page 1" })).not.toContainText(
    "Second thoughts",
  );
  const { name } = await downloadPdf(
    page,
    preview.getByRole("button", { name: "Download PDF" }),
  );
  expect(name).toMatch(/First.draft.*\.pdf$/);

  // Stepping to the newer version recompiles the same preview in place.
  await page.keyboard.press("ArrowRight");
  const newer = page.getByRole("dialog", { name: "Second draft" });
  await expect(newer.getByRole("img", { name: "Page 1" })).toContainText(
    "Second thoughts",
  );
  await newer.getByRole("button", { name: "Older version" }).click();
  await expect(preview.getByRole("img", { name: "Page 1" })).not.toContainText(
    "Second thoughts",
  );

  // Closing the preview goes back to the list, not to the project.
  await page.keyboard.press("Escape");
  await expect(versions(page)).toBeVisible();

  await page.getByRole("button", { name: "Tagged only" }).click();
  await expect(versions(page).getByRole("listitem")).toHaveCount(2);
  await versions(page)
    .getByRole("button", { name: "Remove tag First draft" })
    .click();
  await expect(versions(page).getByText("First draft")).toHaveCount(0);
  await expect(versions(page).getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Tagged only" }).click();

  await versionRow(page, "Second draft")
    .getByRole("button", { name: "Show changes" })
    .click();
  await expect(page.getByText("Viewing Second draft")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Editor" })
      .getByLabel("Changes")
      .getByRole("insertion")
      .filter({ hasText: "Second thoughts" }),
  ).toHaveCount(1);
});

test("stepping between version previews does not flash errors", async ({
  page,
}) => {
  await createProject(page, "Stepping");
  await tagVersion(page, "Alone");
  // The next version adds a file and includes it, so going back removes
  // both in one step.
  await page.getByRole("button", { name: "New file" }).click();
  await page.getByLabel("New file name").fill("summary.typ");
  await page.getByLabel("New file name").press("Enter");
  await expect(tab(page, "summary.typ")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await editor(page).click();
  await page.keyboard.type("Summary text");
  await tab(page, "main.typ").click();
  await appendLine(page, '#include "summary.typ"');
  await expect(firstPage(page)).toContainText("Summary text");
  await tagVersion(page, "With summary");

  await page.getByRole("button", { name: "History", exact: true }).click();
  await versionRow(page, "With summary")
    .getByRole("button", { name: "Preview" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: "Page 1" })).toContainText(
    "Summary text",
  );
  // Catches the diagnostics panel even if it only shows for one frame.
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { seenProblems: seen });
    new MutationObserver(() => {
      const panel = document.querySelector(
        '[role="dialog"] [aria-label="Diagnostics"]',
      );
      if (panel?.textContent) seen.push(panel.textContent);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  // Wait for an idle compiler: a busy one skips the in-between request,
  // and the test would pass without the flash ever having a chance.
  await expect(dialog.getByLabel("Compiling")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("img", { name: "Page 1" })).not.toContainText(
    "Summary text",
  );
  await expect(dialog.getByLabel("Compiling")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("img", { name: "Page 1" })).toContainText(
    "Summary text",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { seenProblems: string[] }).seenProblems,
    ),
  ).toEqual([]);
});
