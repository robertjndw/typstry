import { readFile } from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { Page } from "@playwright/test";

import {
  createProject,
  expect,
  fileTree,
  firstPage,
  openElsewhere,
  shareLink,
  syncStatus,
  test,
} from "./fixtures";
import { makeFixture, serve as serveRepo } from "./git-backend";

test("created projects are listed and can be removed", async ({ page }) => {
  await createProject(page, "Listed");
  await page.getByRole("link", { name: "All projects" }).click();

  const recent = page.getByRole("region", { name: "Your projects" });
  await expect(recent.getByRole("link", { name: /Listed/ })).toBeVisible();

  await recent.getByRole("button", { name: "Delete Listed" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(recent).toBeHidden();
  // The list hides the project before the delete is saved; reloading
  // before the toast could bring it back.
  await expect(page.getByText('Deleted "Listed"')).toBeVisible();

  await page.reload();
  await expect(page.getByRole("link", { name: /Listed/ })).toBeHidden();
});

test("every project is listed, past the old limit of twelve", async ({
  page,
}) => {
  const count = 13;
  for (let n = 1; n <= count; n++) await createProject(page, `Many ${n}`);
  await page.goto("/");
  const projects = page.getByRole("region", { name: "Your projects" });
  await expect(projects.getByRole("link")).toHaveCount(count);
  // Most recently opened first.
  await expect(projects.getByRole("link").first()).toContainText(
    `Many ${count}`,
  );
});

test("a project renamed inside shows its new title on the start page", async ({
  page,
}) => {
  await createProject(page, "Before");
  await page.getByRole("button", { name: /Project title: Before/ }).click();
  const input = page.getByRole("textbox", { name: "Project title" });
  await input.fill("After");
  await input.press("Enter");
  await page.getByRole("link", { name: "All projects" }).click();
  const projects = page.getByRole("region", { name: "Your projects" });
  await expect(projects.getByRole("link", { name: /After/ })).toBeVisible();
  await expect(projects.getByRole("link", { name: /Before/ })).toBeHidden();
});

test("a link without the key explains what is missing", async ({ page }) => {
  const url = await createProject(page, "Keyless");

  // A fresh browser has no stored key for this project.
  const other = await page.context().browser()!.newPage();
  await other.goto(url.split("#")[0]!);
  await expect(
    other.getByRole("heading", { name: "This link is incomplete" }),
  ).toBeVisible();
  await other.close();
});

test("an unknown token shows not found", async ({ page }) => {
  await page.goto("/p/doesnotexist#somekey");
  await expect(
    page.getByRole("heading", { name: "Project not found" }),
  ).toBeVisible();
});

test("a zip imports as a new project, assets included", async ({
  page,
  browser,
}) => {
  const png = await readFile(path.join(import.meta.dirname, "files/red.png"));
  const zip = zipSync({
    "thesis/main.typ": strToU8('#image("figures/red.png", width: 2cm)\n'),
    "thesis/figures/red.png": png,
    "thesis/.DS_Store": new Uint8Array([0]),
  });

  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Files or zip" }).click();
  await (
    await chooser
  ).setFiles({
    name: "export.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });

  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(
    page.getByRole("button", { name: /Project title: thesis\./ }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "main.typ" }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: ".DS_Store" }),
  ).toBeHidden();
  await expect(firstPage(page).locator("image")).toHaveCount(1);

  // A collaborator only gets the image from the server, so this checks the
  // upload actually happened.
  const other = await openElsewhere(browser, await shareLink(page, "Can edit"));
  await expect(firstPage(other).locator("image")).toHaveCount(1);
  await other.context().close();
});

test("dropping a zip on the start page imports it", async ({ page }) => {
  const zip = zipSync({ "paper/main.typ": strToU8("= Dropped\n") });

  await page.goto("/");
  const data = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(bytes)], "paper.zip", {
        type: "application/zip",
      }),
    );
    return transfer;
  }, Array.from(zip));
  await page.dispatchEvent("main", "dragenter", { dataTransfer: data });
  await expect(page.getByText("Drop to import")).toBeVisible();
  await page.dispatchEvent("main", "drop", { dataTransfer: data });

  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(
    page.getByRole("button", { name: /Project title: paper\./ }),
  ).toBeVisible();
  await expect(firstPage(page)).toBeVisible();
});

/**
 * Offers Git import and relays `/api/git` to a real `git http-backend` over a
 * fixture repo, so the browser speaks actual smart HTTP to it.
 */
async function serveGit(page: Page, root: string, status?: number) {
  await page.route("**/api/templates", (route) =>
    route.fulfill({
      json: {
        gitImport: true,
        templates: [
          {
            name: "Letter",
            description: "A plain letter",
            url: "https://git.example/o/repo",
            path: "letter",
          },
        ],
      },
    }),
  );
  await page.route("**/api/git/**", async (route) => {
    const request = route.request();
    if (status) return route.fulfill({ status, body: "" });
    const url = new URL(request.url());
    const reply = await serveRepo(
      { root },
      {
        method: request.method(),
        url: url.pathname.replace("/api/git/git.example", "") + url.search,
        headers: request.headers(),
        body: request.postDataBuffer() ?? undefined,
      },
    );
    await route.fulfill({
      status: reply.status,
      headers: reply.headers,
      body: reply.body,
    });
  });
}

test("a template from Git imports as a new project", async ({ page }) => {
  const fixture = makeFixture({
    files: {
      "README.md": "not part of the template\n",
      "letter/main.typ": "= Dear reader\n",
      "letter/parts/body.typ": "Hello\n",
    },
  });
  await serveGit(page, fixture.root);

  await page.goto("/");
  await page.getByRole("button", { name: "Template or Git" }).click();
  await page.getByRole("radio", { name: /Letter/ }).click();
  await expect(page.getByLabel("Repository URL")).toHaveValue(
    "https://git.example/o/repo",
  );
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(
    page.getByRole("button", { name: /Project title: Letter\./ }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "main.typ" }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "README.md" }),
  ).toBeHidden();
  await expect(firstPage(page)).toBeVisible();
});

test("a repository the relay cannot find says so", async ({ page }) => {
  await serveGit(page, "", 404);

  await page.goto("/");
  await page.getByRole("button", { name: "Template or Git" }).click();
  await page.getByLabel("Repository URL").fill("git.example/o/missing");

  // The lookup fails before anything is created, right under the field.
  await expect(
    page.getByText("The repository was not found, or it is not public"),
  ).toBeVisible();
  await expect(page.getByLabel("Repository URL")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Create project" }),
  ).toBeDisabled();
  await expect(page).toHaveURL("/");
});

test("a name changed on the start page shows up in a project", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^You are E2E Tester/ }).click();
  await page.getByRole("menuitem", { name: "Name and color…" }).click();
  await page.getByRole("textbox", { name: "Your name" }).fill("Renamed Tester");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("button", { name: /^You are Renamed Tester/ }),
  ).toBeVisible();

  // The fixture seeds the identity on every navigation, so create the
  // project without a reload, the way createProject would after its goto.
  await page.getByLabel("Project title").fill("Named");
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page).toHaveURL(/\/p\/[^/#]+#.+/);
  await expect(syncStatus(page)).toHaveText("Connected");
  await expect(
    page.getByRole("banner").getByRole("button", {
      name: /^You are Renamed Tester/,
    }),
  ).toBeVisible();
});
