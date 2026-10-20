import path from "node:path";

import {
  createProject,
  expect,
  fileTree,
  firstPage,
  preview,
  test,
} from "./fixtures";
import {
  addPackage,
  dialog,
  diagnostics,
  openDialog,
  setMain,
} from "./fonts-packages-helpers";

// OFL-licensed, the license text sits next to it.
const FONT = path.join(import.meta.dirname, "files/InriaSans-Regular.ttf");
const FAMILY = "Inria Sans";

test("an uploaded font is stored in fonts/ and Typst resolves it", async ({
  page,
}) => {
  await createProject(page, "Fonts");
  await openDialog(page);

  await dialog(page)
    .getByLabel("Choose fonts", { exact: true })
    .setInputFiles(FONT);
  await expect(
    dialog(page).getByRole("list", { name: "Fonts in this project" }),
  ).toContainText(FAMILY);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "fonts", exact: true }),
  ).toBeVisible();
  await expect(
    fileTree(page).getByRole("treeitem", { name: "InriaSans-Regular.ttf" }),
  ).toBeVisible();

  await setMain(page, [`#set text(font: "${FAMILY}")`, "Typeset in Inria"]);
  await expect(firstPage(page)).toContainText("Typeset in Inria");
  await expect(preview(page).getByLabel("Up to date")).toBeVisible();
  await expect(diagnostics(page).getByText(/unknown font family/)).toHaveCount(
    0,
  );
});

test("a local package is added, imported and replaced", async ({ page }) => {
  await createProject(page, "Packages");
  await openDialog(page);
  await addPackage(page, "Hello from package");

  const review = dialog(page).getByRole("form", { name: "Review package" });
  await expect(review.getByLabel("Namespace")).toHaveValue("local");
  await review.getByRole("button", { name: "Add package" }).click();

  const row = dialog(page).getByRole("listitem", {
    name: "@local/hello:0.1.0",
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText('#import "@local/hello:0.1.0": *');

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await setMain(page, ['#import "@local/hello:0.1.0": hello', "#hello"]);
  await expect(firstPage(page)).toContainText("Hello from package");

  // The compiler caches packages by spec, so a replacement only shows up if
  // the compiler is rebuilt.
  await openDialog(page);
  await dialog(page)
    .getByRole("tab", { name: /Packages/ })
    .click();
  await addPackage(page, "Hello again");
  await dialog(page)
    .getByRole("form", { name: "Review package" })
    .getByRole("button", { name: "Add package" })
    .click();
  await page
    .getByRole("dialog", { name: "Replace @local/hello:0.1.0?" })
    .getByRole("button", { name: "Replace" })
    .click();
  // Escape would go to the confirm dialog while it is still animating out,
  // and the outer dialog counts as hidden for as long as it is inert.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(firstPage(page)).toContainText("Hello again");
});

test("a missing package offers to add it", async ({ page }) => {
  await createProject(page, "Missing");
  await setMain(page, ['#import "@local/nope:0.1.0": *']);

  await diagnostics(page).getByRole("button", { name: "Add package…" }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole("tab", { name: /Packages/ }),
  ).toHaveAttribute("aria-selected", "true");
});
