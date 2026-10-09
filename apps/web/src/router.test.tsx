import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { RECENT_KEY } from "@/project/recent";
import { routes } from "@/router";

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
}

describe("routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders the home page with a new project button and recent projects", () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([
        { projectId: "p1", token: "tok1", title: "Thesis", visitedAt: 1 },
      ]),
    );
    renderAt("/");
    expect(
      screen.getByRole("button", { name: /new project/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /thesis/i })).toHaveAttribute(
      "href",
      "/p/tok1",
    );
  });

  it("shows a not-found page for unknown share tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    renderAt("/p/abc123");
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
  });
});
