import type { Page } from "@playwright/test";

import {
  createProject,
  expect,
  openElsewhere,
  shareLink,
  syncStatus,
  test,
} from "./fixtures";
import {
  connectAsNew,
  newDevice,
  pairNewDevice,
  showCode,
} from "./pair-helpers";

/** Whether the relay still takes a guest on the channel of `code`. */
async function channelIsClosed(page: Page, code: string): Promise<boolean> {
  const channel = code.split("-")[0];
  return page.evaluate(
    (n) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(
          `${location.origin.replace("http", "ws")}/ws/relay?protocol=1&channel=${n}`,
        );
        socket.onclose = (event) => resolve(event.code === 1008);
        socket.onopen = () => setTimeout(() => resolve(false), 1000);
      }),
    channel,
  );
}

test("a new device pairs with a code, gets the projects and is one person", async ({
  page,
  browser,
}) => {
  await createProject(page, "Shared thesis");
  await page.goto("/");
  const code = await showCode(page);
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();

  const other = await newDevice(browser);
  await connectAsNew(other, code);

  const approval = page.getByRole("dialog", {
    name: "Work laptop wants to join as you",
  });
  // The holder can check the key against what the new device shows itself.
  const ownFingerprint = (
    await other.getByLabel("This device's fingerprint").textContent()
  )?.trim();
  expect(ownFingerprint).toBeTruthy();
  await expect(
    approval.getByLabel("Fingerprint of the joining device"),
  ).toHaveText(ownFingerprint!);
  await approval.getByRole("button", { name: "Approve" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Add a device" })
      .getByText("Device added"),
  ).toBeVisible();

  const received = other.getByRole("list", { name: "Projects received" });
  await expect(
    received.getByRole("link", { name: "Shared thesis" }),
  ).toBeVisible();

  // The project is in the recent list and opens with the key it was given.
  await other.goto("/");
  await other.getByRole("link", { name: /Shared thesis/ }).click();
  await expect(syncStatus(other)).toHaveText("Connected");

  await page.goto("/");
  await page.getByRole("link", { name: /Shared thesis/ }).click();
  await expect(syncStatus(page)).toHaveText("Connected");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const members = page
    .getByRole("dialog", { name: "Share project" })
    .getByRole("list", { name: "Members" })
    .getByRole("listitem");
  await expect(members).toHaveCount(1);
  await expect(members).toContainText("2 devices");

  await other.context().close();
});

test("the paired device is the owner and can remove a member", async ({
  page,
  browser,
}) => {
  const projectUrl = await createProject(page, "Owned");
  const editLink = await shareLink(page, "Can edit");
  await page.goto("/");
  const code = await showCode(page);

  const other = await newDevice(browser);
  await connectAsNew(other, code);
  await page
    .getByRole("dialog", { name: "Work laptop wants to join as you" })
    .getByRole("button", { name: "Approve" })
    .click();
  await other
    .getByRole("list", { name: "Projects received" })
    .getByRole("link", { name: "Owned" })
    .click();
  await expect(syncStatus(other)).toHaveText("Connected");

  const third = await openElsewhere(browser, editLink, "Third Tester");

  const share = async () => {
    await other.getByRole("button", { name: "Share", exact: true }).click();
    return other.getByRole("dialog", { name: "Share project" });
  };
  const dialog = await share();
  const list = dialog.getByRole("list", { name: "Members" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("Owner");
  // The owner key only reaches the new device from one that holds it, and
  // the holder has not had the project open since the new device joined.
  const remove = dialog.getByRole("button", { name: "Remove Third Tester" });
  await expect(
    dialog.getByText(/does not have the project's owner key yet/),
  ).toBeVisible();
  await expect(remove).toBeDisabled();
  await page.goto(projectUrl);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(remove).toBeEnabled();
  await remove.click();
  const confirm = other.getByRole("dialog", { name: "Remove Third Tester?" });
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toBeHidden();

  await expect(
    third.getByRole("heading", { name: "You were removed from this project" }),
  ).toBeVisible();

  await third.context().close();
  await other.context().close();
});

test("a device with projects waits for a click before using a link", async ({
  page,
  browser,
}) => {
  await createProject(page, "Mine");
  await page.goto("/");
  const code = await showCode(page);

  const other = await newDevice(browser);
  await createProject(other, "Theirs");
  await other.goto(`/pair#${code}`);
  await expect(
    other.getByText(/add another device to your account/),
  ).toBeVisible();
  // Nothing reached the holder: no one is asking to join.
  await expect(
    page.getByRole("dialog", { name: /wants to join as you/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();

  await other
    .getByRole("button", { name: "Connect to the other device" })
    .click();
  await expect(other.getByRole("alert")).toContainText("Pairing failed");

  await other.context().close();
});

test("the holder can reject the new device", async ({ page, browser }) => {
  await createProject(page, "Private");
  await page.goto("/");
  const code = await showCode(page);

  const other = await newDevice(browser);
  await connectAsNew(other, code);
  await page
    .getByRole("dialog", { name: "Work laptop wants to join as you" })
    .getByRole("button", { name: "Reject" })
    .click();

  await expect(other.getByText("did not approve")).toBeVisible();
  await other.context().close();
});

test("a wrong code fails on both devices and closes the channel", async ({
  page,
  browser,
}) => {
  await createProject(page, "Guarded");
  await page.goto("/");
  const code = await showCode(page);
  const [channel, first] = code.split("-");
  const wrong = `${channel}-${first === "acorn" ? "amber" : "acorn"}-amber`;

  const other = await newDevice(browser);
  await connectAsNew(other, wrong);

  await expect(other.getByRole("alert")).toContainText("Pairing failed");
  await expect(
    page.getByRole("dialog", { name: "Add a device" }).getByRole("alert"),
  ).toContainText("Pairing failed");
  expect(await channelIsClosed(page, code)).toBe(true);

  await other.context().close();
});

test("revoking a device from the other one removes it from a shared project", async ({
  page,
  browser,
}) => {
  await createProject(page, "Revokable");
  await page.goto("/");
  const other = await pairNewDevice(page, browser);
  await other
    .getByRole("list", { name: "Projects received" })
    .getByRole("link", { name: "Revokable" })
    .click();
  await expect(syncStatus(other)).toHaveText("Connected");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^You are / }).click();
  await page.getByRole("menuitem", { name: "Your devices…" }).click();
  const devices = page.getByRole("dialog", { name: "Your devices" });
  await expect(devices.getByText("(this device)")).toBeVisible();
  await devices.getByRole("button", { name: "Revoke Work laptop" }).click();
  await page
    .getByRole("dialog", { name: "Revoke Work laptop?" })
    .getByRole("button", { name: "Revoke" })
    .click();

  await expect(devices.getByText("Work laptop was revoked.")).toBeVisible();
  await expect(devices.getByText("Removed from 1 of 1 project.")).toBeVisible();
  await expect(devices.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(
    other.getByRole("heading", { name: "You were removed from this project" }),
  ).toBeVisible();

  await other.context().close();
});
