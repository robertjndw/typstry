import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { directory } from "@/directory/store";
import { seedProject, token } from "@/directory/test-utils";
import { routes } from "@/router";

function renderHome() {
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
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
    expect((await directory()).list(Date.now())).toMatchObject([
      { projectId: "a", state: "forgotten" },
    ]);
  });
});
