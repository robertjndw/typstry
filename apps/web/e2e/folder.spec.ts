import type { Page } from "@playwright/test";

import {
  createProject,
  docText,
  editor,
  expect,
  fileTree,
  syncStatus,
  test,
  typeAtEnd,
} from "./fixtures";

// The folder picker is a native dialog that Playwright cannot drive, so the
// page gets one that hands out a directory in the origin's private file
// system instead. It behaves like a real folder to the app.
test.beforeEach(async ({ page }, testInfo) => {
  const name = `pick-${testInfo.parallelIndex}-${testInfo.workerIndex}-${Date.now()}`;
  testInfo.annotations.push({ type: "folder", description: name });
  await page.addInitScript((folder) => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker =
      async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle(folder, {
          create: true,
        });
    // Sandboxed handles may not implement the permission methods; a real
    // folder always does, and a granted one is what these tests are about.
    const proto = FileSystemHandle.prototype as unknown as Record<
      string,
      unknown
    >;
    proto.queryPermission ??= async () => "granted";
    proto.requestPermission ??= async () => "granted";
  }, name);
  folderOf.set(page, name);
});

const folderOf = new WeakMap<Page, string>();

function folderName(page: Page): string {
  return folderOf.get(page)!;
}

/** Creates or replaces a file in the folder the picker hands out. */
async function writeFile(page: Page, path: string, content: string) {
  await page.evaluate(
    async ({ folder, path, content }) => {
      const segments = path.split("/");
      const file = segments.pop()!;
      let dir = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle(folder, { create: true });
      for (const name of segments) {
        dir = await dir.getDirectoryHandle(name, { create: true });
      }
      const handle = await dir.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
    },
    { folder: folderName(page), path, content },
  );
}

/** The file's text, or null when it does not exist. */
async function readFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ folder, path }) => {
      try {
        let dir = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle(folder);
        const segments = path.split("/");
        const file = segments.pop()!;
        for (const name of segments) dir = await dir.getDirectoryHandle(name);
        return await (await (await dir.getFileHandle(file)).getFile()).text();
      } catch {
        return null;
      }
    },
    { folder: folderName(page), path },
  );
}

/** What a user returning to the window does; the app syncs when it gets focus. */
async function focusWindow(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function openFolder(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open local folder" }).click();
  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
}

async function linkFolder(page: Page) {
  await page.getByRole("button", { name: "Files menu" }).click();
  await page.getByRole("menuitem", { name: "Link to local folder…" }).click();
  await expect(chip(page)).toBeVisible();
}

/** The folder's name heading the file tree, which opens its menu. */
function chip(page: Page) {
  return page.getByRole("button", { name: `Folder ${folderName(page)}:` });
}

test("opening a folder makes a project of its files", async ({ page }) => {
  await page.goto("/");
  await writeFile(page, "main.typ", "= From the folder\n");
  await writeFile(page, "chapters/intro.typ", "Intro text\n");
  await openFolder(page);

  await expect(
    page.getByRole("button", {
      name: new RegExp(`Project title: ${folderName(page)}`),
    }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "main.typ" }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "chapters" }),
  ).toBeVisible();
  await expect(editor(page)).toContainText("From the folder");
  await expect(chip(page)).toBeVisible();
});

test("an empty folder is refused", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open local folder" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "There is nothing to import",
  );
  await expect(page).toHaveURL("/");
});

test("typing in the editor updates the file in the folder", async ({
  page,
}) => {
  await page.goto("/");
  await writeFile(page, "main.typ", "= Title\n");
  await openFolder(page);
  await expect(editor(page)).toContainText("Title");

  await typeAtEnd(page, "typed in the browser");
  await expect
    .poll(() => readFile(page, "main.typ"), { timeout: 20_000 })
    .toContain("typed in the browser");
});

test("a file written to the folder shows up in the editor", async ({
  page,
}) => {
  await page.goto("/");
  await writeFile(page, "main.typ", "= Before\n");
  await openFolder(page);
  await expect(editor(page)).toContainText("Before");

  await writeFile(page, "main.typ", "= Changed on disk\n");
  await focusWindow(page);
  await expect
    .poll(() => docText(page), { timeout: 20_000 })
    .toContain("Changed on disk");

  await writeFile(page, "notes.typ", "new file\n");
  await focusWindow(page);
  await expect(
    fileTree(page).getByRole("treeitem", { name: "notes.typ" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("linking a project to an empty folder writes its files", async ({
  page,
}) => {
  await createProject(page, "Linked");
  await linkFolder(page);

  await expect
    .poll(() => readFile(page, "main.typ"), { timeout: 20_000 })
    .toContain("Hello, Typst!");
});

test("unlinking stops the sync and keeps the files", async ({ page }) => {
  await createProject(page, "Unlinked");
  await linkFolder(page);
  await expect
    .poll(() => readFile(page, "main.typ"), { timeout: 20_000 })
    .toContain("Hello, Typst!");

  await chip(page).click();
  await page
    .getByRole("menuitem", { name: `Unlink ${folderName(page)}` })
    .click();
  await expect(chip(page)).toBeHidden();
  // The menu hands focus back to its trigger as it closes, which would eat
  // keys typed into the editor meanwhile.
  await expect(page.getByRole("menu")).toBeHidden();

  await typeAtEnd(page, "after unlinking");
  await expect(editor(page)).toContainText("after unlinking");
  // Well past the debounce, so a sync that was still running would have
  // written by now.
  await page.waitForTimeout(3000);
  expect(await readFile(page, "main.typ")).not.toContain("after unlinking");
  expect(await readFile(page, "main.typ")).toContain("Hello, Typst!");

  await page.getByRole("button", { name: "Files menu" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Link to local folder…" }),
  ).toBeVisible();
});

test("a reload re-attaches the folder", async ({ page }) => {
  await createProject(page, "Reloaded");
  await linkFolder(page);
  await expect
    .poll(() => readFile(page, "main.typ"), { timeout: 20_000 })
    .toContain("Hello, Typst!");

  await page.reload();
  await expect(chip(page)).toBeVisible();

  await writeFile(page, "main.typ", "= Edited while closed\n");
  await focusWindow(page);
  await expect
    .poll(() => docText(page), { timeout: 20_000 })
    .toContain("Edited while closed");

  await typeAtEnd(page, "and typed after");
  await expect
    .poll(() => readFile(page, "main.typ"), { timeout: 20_000 })
    .toContain("and typed after");
});
