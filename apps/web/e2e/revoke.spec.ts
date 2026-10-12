import { createProject, expect, test } from "./fixtures";
import { pairNewDevice } from "./pair-helpers";

test("a revoked device loses the project and stops hearing of new ones", async ({
  page: a,
  browser,
}) => {
  await createProject(a, "Seed");
  await a.goto("/");
  const b = await pairNewDevice(a, browser);

  // A made this after pairing, so B only knows it from the directory.
  await createProject(a, "Owned by A");
  const home = await a.context().newPage();
  await home.goto("/");
  await b.goto("/");
  await b
    .getByRole("region", { name: "Your projects" })
    .getByRole("link", { name: /Owned by A/ })
    .click();
  // A has the project open, so it sees B's leaf and hands over the owner key.
  await b.getByRole("button", { name: "Share" }).click();
  const share = b.getByRole("dialog", { name: "Share project" });
  await expect(share.getByRole("list", { name: "Members" })).toBeVisible();
  await expect(share.getByText(/owner key yet/)).toBeHidden();
  await b.keyboard.press("Escape");

  // B only learns of this one from the directory, owner key included.
  const never = await a.context().newPage();
  await createProject(never, "Never opened by B");

  // Control: before the revoke A hears of what B makes.
  await createProject(b, "Before revoke");
  await b.goto("/");
  await expect(
    b
      .getByRole("region", { name: "Your projects" })
      .getByRole("link", { name: /Never opened by B/ }),
  ).toBeVisible();
  await expect(
    home
      .getByRole("region", { name: "Your projects" })
      .getByRole("link", { name: /Before revoke/ }),
  ).toBeVisible();

  await b.goto("/");
  await b.getByRole("button", { name: /^You are / }).click();
  await b.getByRole("menuitem", { name: "Your devices…" }).click();
  const devices = b.getByRole("dialog", { name: "Your devices" });
  await devices.getByRole("button", { name: /^Revoke / }).click();
  await b
    .getByRole("dialog", { name: /^Revoke / })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(devices.getByText(/ was revoked\./)).toBeVisible();
  await expect(devices.getByText(/Removed from \d+ of/)).toBeVisible();

  // The project's old links stopped working for A.
  await expect(
    a.getByRole("heading", { name: "You were removed from this project" }),
  ).toBeVisible({ timeout: 30_000 });

  // So did the one B never opened: its owner key came through the directory.
  await expect(
    never.getByRole("heading", { name: "You were removed from this project" }),
  ).toBeVisible({ timeout: 30_000 });

  // And A no longer hears of what B makes next.
  await b.keyboard.press("Escape");
  await createProject(b, "After revoke");
  await b.goto("/");
  await expect(
    b
      .getByRole("region", { name: "Your projects" })
      .getByRole("link", { name: /After revoke/ }),
  ).toBeVisible();
  // Control for the negative wait below: a device that is still the
  // person's does hear of it right now, so silence on `home` is not just
  // sync being down.
  await b.goto("/");
  const trusted = await pairNewDevice(b, browser, {
    deviceName: "Control laptop",
  });
  await trusted.goto("/");
  await expect(
    trusted
      .getByRole("region", { name: "Your projects" })
      .getByRole("link", { name: /After revoke/ }),
  ).toBeVisible({ timeout: 30_000 });

  await home.reload();
  const list = home.getByRole("region", { name: "Your projects" });
  await expect(list.getByRole("link", { name: /Seed/ })).toBeVisible();
  await home.waitForTimeout(5_000);
  await expect(list.getByRole("link", { name: /After revoke/ })).toBeHidden();

  await trusted.context().close();
  await b.context().close();
});
