import { createProject, expect, test } from "./fixtures";
import { pairNewDevice } from "./pair-helpers";

test("the project list follows a person across paired devices", async ({
  page,
  browser,
}) => {
  // A browser is only a person, and so only able to add a device, once it
  // has made or opened a project.
  await createProject(page, "First");
  await page.goto("/");
  const other = await pairNewDevice(page, browser);
  await other.goto("/");
  const mine = page.getByRole("region", { name: "Your projects" });
  const theirs = other.getByRole("region", { name: "Your projects" });

  // The project A had before pairing was in its directory already.
  await expect(theirs.getByRole("link", { name: /First/ })).toBeVisible();

  // A new project on A shows up on B without a reload.
  await createProject(page, "Synced thesis");
  await page.goto("/");
  await expect(
    theirs.getByRole("link", { name: /Synced thesis/ }),
  ).toBeVisible();

  // So does a rename.
  await page.getByRole("link", { name: /Synced thesis/ }).click();
  await page
    .getByRole("button", { name: /Project title: Synced thesis/ })
    .click();
  const input = page.getByRole("textbox", { name: "Project title" });
  await input.fill("Renamed thesis");
  await input.press("Enter");
  await page.getByRole("link", { name: "All projects" }).click();
  await expect(
    theirs.getByRole("link", { name: /Renamed thesis/ }),
  ).toBeVisible();
  await expect(
    theirs.getByRole("link", { name: /Synced thesis/ }),
  ).toBeHidden();

  // Removing it on A removes it from B's list too.
  await mine.getByRole("button", { name: "Delete Renamed thesis" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(mine.getByRole("link", { name: /Renamed thesis/ })).toBeHidden();
  await expect(
    theirs.getByRole("link", { name: /Renamed thesis/ }),
  ).toBeHidden();
});
