import type { Browser, Page } from "@playwright/test";

export const CODE = /^\d{1,4}-[a-z]+-[a-z]+$/;

/** A fresh browser that has a name already, so no prompt gets in the way. */
export async function newDevice(browser: Browser, name = "Laptop") {
  const context = await browser.newContext();
  await context.addInitScript((who) => {
    localStorage.setItem(
      "typstry:identity",
      JSON.stringify({ name: who, color: "#047857" }),
    );
  }, name);
  return context.newPage();
}

export async function showCode(page: Page): Promise<string> {
  await page.getByRole("button", { name: /^You are / }).click();
  await page.getByRole("menuitem", { name: "Add a device…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a device" });
  return (await dialog.getByText(CODE).textContent())!;
}

export async function connectAsNew(
  page: Page,
  code: string,
  deviceName = "Work laptop",
) {
  await page.goto(`/pair#${code}`);
  await page.getByLabel("Device name").fill(deviceName);
  await page.getByRole("button", { name: "Connect" }).click();
}

/**
 * Pairs a new browser with `holder`, which must be on a page with the
 * account menu. Returns the new device's page, on the done screen.
 */
export async function pairNewDevice(
  holder: Page,
  browser: Browser,
  opts: { name?: string; deviceName?: string } = {},
): Promise<Page> {
  const deviceName = opts.deviceName ?? "Work laptop";
  const code = await showCode(holder);
  const other = await newDevice(browser, opts.name);
  await connectAsNew(other, code, deviceName);
  await holder
    .getByRole("dialog", { name: `${deviceName} wants to join as you` })
    .getByRole("button", { name: "Approve" })
    .click();
  await other.getByText("This device is now yours").waitFor();
  return other;
}
