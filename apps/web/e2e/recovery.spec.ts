import { createProject, expect, shareLink, syncStatus, test } from "./fixtures";
import { newDevice } from "./pair-helpers";

test("a recovery key brings a new browser back as the owner and revokes the old device", async ({
  page,
  browser,
}) => {
  await createProject(page, "Lost and found");
  const editLink = await shareLink(page, "Can edit");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^You are / }).click();
  await page.getByRole("menuitem", { name: "Recovery key…" }).click();
  const dialog = page.getByRole("dialog", { name: "Recovery key" });
  await dialog.getByRole("button", { name: "Create recovery key" }).click();
  const words = (await dialog.getByLabel("Recovery words").textContent())!;
  expect(words.trim().split(/\s+/)).toHaveLength(17);
  await expect(dialog.getByRole("button", { name: "Done" })).toBeDisabled();
  await dialog.getByLabel("I have stored it").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  const fresh = await newDevice(browser, "Fresh");
  await fresh.goto("/recover");
  await fresh.getByLabel("Recovery words").fill(words);
  await fresh.getByLabel("Project link").fill(editLink);
  await fresh.getByRole("button", { name: "Recover" }).click();

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

  // The old browser lost its place in the project.
  await expect(
    page.getByRole("heading", { name: "You were removed from this project" }),
  ).toBeVisible({ timeout: 30_000 });

  await fresh.context().close();
});
