import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { directory } from "@/directory/store";
import { seedProject, token } from "@/directory/test-utils";
import { routes } from "@/router";

// The dialog looks repositories up as soon as it has a URL; these stand in
// for the network so the tests can check where it lands.
vi.mock("@/import/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/import/git")>()),
  listRefs: vi.fn(async (url: string) => ({
    url,
    defaultBranch: "main",
    branches: ["main"],
    tags: ["v2"],
  })),
  fetchSnapshot: vi.fn(async (url: string, ref: string) => ({
    url,
    ref,
    folders: [
      { path: "", files: 3, typst: false, manifest: false },
      { path: "letter", files: 2, typst: true, manifest: true },
    ],
    read: vi.fn(),
  })),
}));

function renderHome() {
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster />
    </TooltipProvider>,
  );
}

async function list() {
  return within(await screen.findByRole("region", { name: "Your projects" }));
}

describe("Home project list", () => {
  it("lists every project, most recently opened first", async () => {
    for (let n = 1; n <= 15; n++) await seedProject(`p${n}`, n);
    renderHome();
    const projects = await list();
    const links = projects.getAllByRole("link");
    expect(links).toHaveLength(15);
    expect(links[0]).toHaveAttribute(
      "href",
      expect.stringMatching(`^/p/${token(15)}#.+`),
    );
    expect(links[0]).toHaveTextContent("p15");
    expect(links[14]).toHaveTextContent("p1");
  });

  it("explains a project that cannot be opened any more", async () => {
    await seedProject("removed", 1, { title: "Kicked" });
    await seedProject("gone", 2, { title: "Replaced" });
    await seedProject("fine", 3, { title: "Fine" });
    const dir = await directory();
    dir.setStatus("removed", "removed", 9, token(1));
    dir.setStatus("gone", "gone", 9, token(2));
    renderHome();
    const projects = await list();
    expect(projects.getByRole("link", { name: /Kicked/ })).toHaveTextContent(
      "You were removed",
    );
    expect(projects.getByRole("link", { name: /Replaced/ })).toHaveTextContent(
      "Link no longer works",
    );
    expect(projects.getByRole("link", { name: /Fine/ })).not.toHaveTextContent(
      /removed|no longer/,
    );
    // Still removable.
    expect(
      projects.getByRole("button", { name: "Delete Kicked" }),
    ).toBeInTheDocument();
  });

  it("hides a forgotten project and follows a rename", async () => {
    await seedProject("a", 1, { title: "Old name" });
    await seedProject("b", 2, { title: "Hidden" });
    (await directory()).setStatus("b", "forgotten", 9);
    renderHome();
    const projects = await list();
    expect(projects.queryByText("Hidden")).toBeNull();
    expect(projects.getByText("Old name")).toBeInTheDocument();

    await act(async () => {
      (await directory()).setTitle("a", "New name");
    });
    expect(await projects.findByText("New name")).toBeInTheDocument();
  });

  it("removing a project forgets it in the directory", async () => {
    await seedProject("a", 1, { title: "Doomed" });
    renderHome();
    const projects = await list();
    fireEvent.click(projects.getByRole("button", { name: "Delete Doomed" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await screen.findByText(/Projects you create or open/);
    expect(await screen.findByText('Deleted "Doomed"')).toBeInTheDocument();
    expect((await directory()).list(Date.now())).toMatchObject([
      { projectId: "a", state: "forgotten" },
    ]);
  });

  it("says so when a project could not be deleted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedProject("a", 1, { title: "Stuck" });
    const dir = await directory();
    // A newer layout is never written, so forgetting fails.
    dir.doc.getMap("meta").set("schema", 99);
    dir.doc.commit();
    renderHome();
    const projects = await list();
    fireEvent.click(projects.getByRole("button", { name: "Delete Stuck" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(
      await screen.findByText('Could not delete "Stuck"'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Deleted "Stuck"')).toBeNull();
    error.mockRestore();
  });
});

describe("Home start from Git", () => {
  function offer(body: unknown, ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok
          ? new Response(JSON.stringify(body))
          : new Response("", { status: 500 }),
      ),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it("offers nothing when the server has Git import off", async () => {
    offer({ gitImport: false, templates: [] });
    renderHome();
    await screen.findByRole("button", { name: "Files or zip" });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Git/ })).toBeNull();
  });

  it("offers nothing when the server cannot be asked", async () => {
    offer({}, false);
    renderHome();
    await screen.findByRole("button", { name: "Files or zip" });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Git/ })).toBeNull();
  });

  it("opens a dialog with the URL field", async () => {
    offer({ gitImport: true, templates: [] });
    renderHome();
    fireEvent.click(
      await screen.findByRole("button", { name: "Git repository" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Start from a Git repository",
    });
    expect(within(dialog).getByLabelText("Repository URL")).toBeInTheDocument();
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("fills the fields from a template", async () => {
    offer({
      gitImport: true,
      templates: [
        {
          name: "Letter",
          description: "A plain letter",
          url: "https://github.com/o/r.git",
          ref: "v2",
          path: "letter",
        },
      ],
    });
    renderHome();
    fireEvent.click(
      await screen.findByRole("button", { name: "Template or Git" }),
    );
    const letter = await screen.findByRole("radio", { name: /Letter/ });
    fireEvent.click(letter);
    expect(letter).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Repository URL")).toHaveValue(
      "https://github.com/o/r.git",
    );
    // An empty title falls back to the template's name, and says so.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(/Project title/)).toHaveAttribute(
      "placeholder",
      "Letter",
    );
    // Once the repository is looked up, the template's ref and folder are
    // picked, and the folder is described.
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Folder")).toHaveTextContent(
        "letter",
      ),
    );
    expect(within(dialog).getByLabelText("Branch or tag")).toHaveTextContent(
      "v2",
    );
    expect(dialog).toHaveTextContent("2 files, a Typst template or package");
    expect(
      within(dialog).getByRole("button", { name: "Create project" }),
    ).toBeEnabled();
  });
});
