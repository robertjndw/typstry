import { createProject, expect, shareLink, syncStatus, test } from "./fixtures";
import { newDevice } from "./pair-helpers";

test("a recovery key brings a new browser back with every project and revokes the old device", async ({
  page,
  browser,
}) => {
  await createProject(page, "Lost and found");
  const editLink = await shareLink(page, "Can edit");
  await page.keyboard.press("Escape");

  // A second project, open in its own tab so both stay live on the old device.
  const second = await page.context().newPage();
  await createProject(second, "Second project");

  await page.getByRole("button", { name: /^You are / }).click();
  await page.getByRole("menuitem", { name: "Recovery key…" }).click();
  const dialog = page.getByRole("dialog", { name: "Recovery key" });
  await dialog.getByRole("button", { name: "Create recovery key" }).click();
  const words = (await dialog.getByLabel("Recovery words").textContent())!;
  expect(words.trim().split(/\s+/)).toHaveLength(17);
  await expect(dialog.getByRole("button", { name: "Done" })).toBeDisabled();
  // Opening the projects puts the personal space link into their leaves,
  // which is all the recovery has to go on.
  await expect(dialog.getByRole("status")).toHaveText(
    "Your projects are up to date.",
    { timeout: 60_000 },
  );
  await dialog.getByLabel("I have stored it").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  const fresh = await newDevice(browser, "Fresh");
  await fresh.goto("/recover");
  await fresh.getByLabel("Recovery words").fill(words);
  await fresh.getByLabel("Project link").fill(editLink);
  await fresh.getByRole("button", { name: "Recover" }).click();
  await expect(fresh.getByRole("status")).toContainText("2 projects");
  await fresh.getByRole("button", { name: "Open project" }).click();

  await expect(syncStatus(fresh)).toHaveText("Connected");
  await fresh.getByRole("button", { name: "Share", exact: true }).click();
  const members = fresh
    .getByRole("dialog", { name: "Share project" })
    .getByRole("list", { name: "Members" })
    .getByRole("listitem");
  await expect(members.first()).toContainText("Owner");
  await fresh.keyboard.press("Escape");

  await fresh.getByRole("button", { name: /^You are / }).click();
  await fresh.getByRole("menuitem", { name: "Your devices…" }).click();
  const devices = fresh.getByRole("dialog", { name: "Your devices" });
  await expect(devices.getByText("(this device)")).toBeVisible();
  await expect(devices.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(devices.getByText("Recovery", { exact: true })).toBeVisible();

  // The old browser lost its place in the project: the recovery key opened
  // the owner key, which lets the new browser remove it and rotate.
  await expect(
    page.getByRole("heading", { name: "You were removed from this project" }),
  ).toBeVisible({ timeout: 30_000 });
  await fresh.keyboard.press("Escape");
  await fresh.getByRole("button", { name: "Share", exact: true }).click();
  await expect(members).toHaveCount(1);
  await expect(
    fresh
      .getByRole("dialog", { name: "Share project" })
      .getByRole("button", { name: "Reset links" }),
  ).toBeEnabled();

  await expect(
    second.getByRole("heading", { name: "You were removed from this project" }),
  ).toBeVisible({ timeout: 30_000 });

  // The directory came along, so the other project is listed here too.
  await fresh.goto("/");
  const list = fresh.getByRole("region", { name: "Your projects" });
  await expect(
    list.getByRole("link", { name: /Lost and found/ }),
  ).toBeVisible();
  await expect(
    list.getByRole("link", { name: /Second project/ }),
  ).toBeVisible();

  await fresh.context().close();
});
