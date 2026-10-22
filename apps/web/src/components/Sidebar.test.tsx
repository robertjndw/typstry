import { act, fireEvent, render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { useSidebarTab, type SidebarTab } from "@/hooks/use-sidebar-tab";
import { ProjectProvider } from "@/project/ProjectProvider";

import { Sidebar } from "./Sidebar";

const KEY = "typstry:sidebar-tab";

function Harness({
  panels,
}: {
  panels: Partial<Record<"outline" | "search" | "comments", string>>;
}) {
  const available: SidebarTab[] = ["files", ...(Object.keys(panels) as never)];
  const [tab, setTab] = useSidebarTab(available);
  return (
    <Sidebar
      tab={tab}
      onTabChange={setTab}
      outline={panels.outline && <p>outline panel</p>}
      search={panels.search && <p>search panel</p>}
      comments={panels.comments && <p>comments panel</p>}
    />
  );
}

function renderSidebar(panels: Parameters<typeof Harness>[0]["panels"]) {
  const project = initProject(newProject(1), { title: "Test" });
  return render(
    <TooltipProvider>
      <ProjectProvider doc={project}>
        <Harness panels={panels} />
      </ProjectProvider>
    </TooltipProvider>,
  );
}

const tab = (name: string) => screen.queryByRole("tab", { name });

describe("Sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("shows no tab bar while only the file tree exists", () => {
    renderSidebar({});
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("tree")).toBeInTheDocument();
  });

  it("only offers tabs whose panel is given", () => {
    renderSidebar({ search: "x" });
    expect(tab("Files")).toBeInTheDocument();
    expect(tab("Search")).toBeInTheDocument();
    expect(tab("Outline")).toBeNull();
    expect(tab("Comments")).toBeNull();
  });

  it("remembers the active tab", () => {
    const first = renderSidebar({ search: "x", outline: "x" });
    fireEvent.mouseDown(tab("Search")!);
    fireEvent.focus(tab("Search")!);
    expect(screen.getByText("search panel")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe('"search"');
    first.unmount();

    renderSidebar({ search: "x", outline: "x" });
    expect(tab("Search")).toHaveAttribute("aria-selected", "true");
  });

  it("marks the active tab for its indicator, even with a tooltip", () => {
    renderSidebar({ search: "x" });
    expect(tab("Files")).toHaveAttribute("data-state", "active");
    fireEvent.mouseDown(tab("Search")!);
    expect(tab("Search")).toHaveAttribute("data-state", "active");
    expect(tab("Files")).toHaveAttribute("data-state", "inactive");
  });

  it("falls back to files when the stored tab is unavailable", () => {
    localStorage.setItem(KEY, '"comments"');
    renderSidebar({ search: "x" });
    expect(tab("Files")).toHaveAttribute("aria-selected", "true");
    // Kept, so the tab comes back once its panel does.
    expect(localStorage.getItem(KEY)).toBe('"comments"');
  });

  it("ignores a stored value that is not a tab", () => {
    localStorage.setItem(KEY, "garbage");
    act(() => void renderSidebar({ search: "x" }));
    expect(tab("Files")).toHaveAttribute("aria-selected", "true");
  });

  it("shows a tab's badge count in its name", () => {
    const project = initProject(newProject(1), { title: "Test" });
    const view = (count: number) => (
      <TooltipProvider>
        <ProjectProvider doc={project}>
          <Sidebar
            tab="files"
            onTabChange={() => {}}
            comments={<p>comments panel</p>}
            badges={{ comments: count }}
          />
        </ProjectProvider>
      </TooltipProvider>
    );
    const { rerender } = render(view(3));
    expect(tab("Comments (3)")).toHaveTextContent("3");
    rerender(view(0));
    expect(tab("Comments")).not.toHaveTextContent(/\d/);
  });
});
