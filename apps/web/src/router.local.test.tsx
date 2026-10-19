import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { routes } from "@/router";

vi.mock("@/mode", () => ({ LOCAL_ONLY: true }));

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
}

describe("routes in local-only mode", () => {
  it("leaves out the routes that need a server", () => {
    const paths = routes.map((r) => r.path);
    expect(paths).not.toContain("/pair");
    expect(paths).not.toContain("/recover");
  });

  it("opens a project from the browser's own store, never the server", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderAt("/p/abcdefghijklmnopqrstuv");
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("words the start page for a browser-only app", () => {
    renderAt("/");
    expect(screen.getByText(/Stored in this browser/)).toBeInTheDocument();
    expect(screen.queryByText(/collaboration/i)).not.toBeInTheDocument();
  });
});
