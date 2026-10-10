import {
  expect,
  test as base,
  type Browser,
  type Page,
} from "@playwright/test";

export { expect };

export const test = base.extend<{ expectedCspViolations: RegExp[] }>({
  // Without a stored identity, opening a project asks for a name first and
  // the dialog covers the workspace.
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      localStorage.setItem(
        "typstry:identity",
        JSON.stringify({ name: "E2E Tester", color: "#1d4ed8" }),
      );
    });
    await use(context);
  },
  expectedCspViolations: [[], { option: true }],
  // The server's CSP is strict; whatever it blocks is a feature broken in
  // production, so every test doubles as a check of the policy.
  page: async ({ page, expectedCspViolations }, use) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (
        text.includes("Content Security Policy") &&
        !expectedCspViolations.some((re) => re.test(text))
      ) {
        violations.push(text);
      }
    });
    await use(page);
    expect(violations).toEqual([]);
  },
});

/** Creates a project from the start page and waits for the workspace. */
export async function createProject(page: Page, title: string) {
  await page.goto("/");
  await page.getByLabel("Project title").fill(title);
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  return page.url();
}

/**
 * The sync indicator in the toolbar. While connected it shows only a dot,
 * with the label kept for screen readers, so check its text rather than
 * the label's visibility.
 */
export function syncStatus(page: Page) {
  return page.getByRole("banner").getByRole("status");
}

export function editor(page: Page) {
  return page.locator(".cm-content");
}

export function preview(page: Page) {
  return page.getByRole("region", { name: "Preview" });
}

export function firstPage(page: Page) {
  return preview(page).getByRole("img", { name: "Page 1" });
}

export function tab(page: Page, name: string) {
  return page
    .getByRole("tablist", { name: "Open files" })
    .getByRole("tab", { name });
}

/** Puts the cursor on a new, empty line at the end of the open file. */
export async function startLine(page: Page) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
}

/** Adds a line at the end of the open file. */
export async function appendLine(page: Page, text: string) {
  await startLine(page);
  // Typed rather than filled so it goes through CodeMirror like real input.
  // Newlines are left out on purpose: an Enter while tinymist's completion
  // popup is open would accept a suggestion.
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

/**
 * Opens a link in a second browser with its own storage, so everything it
 * sees had to come through the server (and the encryption key through the
 * link).
 */
export async function openElsewhere(
  browser: Browser,
  url: string,
  name = "Second Tester",
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  // No stored identity here, so the name prompt comes up first.
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(syncStatus(page)).toHaveText("Connected");
  return page;
}

export async function shareLink(page: Page, label: "Can edit" | "Can view") {
  await page.getByRole("button", { name: "Share" }).click();
  const url = await page.getByRole("textbox", { name: label }).inputValue();
  await page.keyboard.press("Escape");
  return url;
}

/** Creates a file (or folder) at the top level through the tree toolbar. */
export async function createEntry(
  page: Page,
  name: string,
  kind: "file" | "folder" = "file",
) {
  await page.getByRole("button", { name: `New ${kind}` }).click();
  const input = page.getByLabel(`New ${kind} name`);
  await input.fill(name);
  await input.press("Enter");
}

export function fileTree(page: Page) {
  return page.getByRole("tree", { name: "Project files" });
}

export async function contextMenu(page: Page, entry: string, item: string) {
  await fileTree(page)
    .getByRole("treeitem", { name: entry })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
}

export function versions(page: Page) {
  return page
    .getByRole("dialog", { name: "History" })
    .getByRole("list", { name: "Versions" });
}
