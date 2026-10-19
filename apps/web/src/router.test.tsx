import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { seedProject, token } from "@/directory/test-utils";
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

  it("renders the home page with a new project button and the project list", async () => {
    await seedProject("p1", 1, { title: "Thesis" });
    renderAt("/");
    expect(
      screen.getByRole("button", { name: /new project/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /thesis/i }),
    ).toHaveAttribute("href", expect.stringMatching(`^/p/${token(1)}#.+`));
  });

  it("shows a not-found page for unknown share tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    renderAt("/p/abc123");
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
  });

  it("registers pairing and recovery with a server", () => {
    const paths = routes.map((r) => r.path);
    expect(paths).toContain("/pair");
    expect(paths).toContain("/recover");
  });
});
