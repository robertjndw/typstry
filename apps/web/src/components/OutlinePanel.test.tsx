import { act, fireEvent, render, screen } from "@testing-library/react";
import type { TreeID } from "loro-crdt";

import { getText } from "@/doc/fs-ops";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { ProjectProvider } from "@/project/ProjectProvider";
import { RevealContext } from "@/project/reveal-context";

import { OutlinePanel } from "./OutlinePanel";

function renderPanel(main: string) {
  const project = initProject(newProject(1), { title: "Test" });
  getText(project, project.mainFile!).update(main);
  project.doc.commit();
  const reveal = vi.fn();
  render(
    <ProjectProvider doc={project}>
      <RevealContext value={reveal}>
        <OutlinePanel />
      </RevealContext>
    </ProjectProvider>,
  );
  return { project, reveal };
}

const SOURCE = "= One <one>\n== Sub\n#figure(caption: [Pic])\n= Two\n";

describe("OutlinePanel", () => {
  it("lists headings and figures nested by depth with labels", () => {
    renderPanel(SOURCE);
    const items = screen.getAllByRole("treeitem");
    expect(items.map((i) => i.getAttribute("aria-level"))).toEqual([
      "1",
      "2",
      "3",
      "1",
    ]);
    expect(items[0]).toHaveTextContent("One");
    expect(items[0]).toHaveTextContent("one");
    expect(items[2]).toHaveTextContent("Pic");
  });

  it("filters entries", () => {
    renderPanel(SOURCE);
    fireEvent.change(screen.getByLabelText("Filter outline"), {
      target: { value: "two" },
    });
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Filter outline"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matching entries")).toBeInTheDocument();
  });

  it("reveals the heading on click and on Enter", () => {
    const { project, reveal } = renderPanel(SOURCE);
    fireEvent.click(screen.getByRole("treeitem", { name: /Sub/ }));
    expect(reveal).toHaveBeenCalledWith(project.mainFile as TreeID, {
      kind: "offset",
      from: SOURCE.indexOf("== Sub"),
      to: SOURCE.indexOf("== Sub"),
    });
    fireEvent.keyDown(screen.getByRole("treeitem", { name: /Two/ }), {
      key: "Enter",
    });
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it("moves between rows with the arrow keys", () => {
    renderPanel(SOURCE);
    const [first, second] = screen.getAllByRole("treeitem");
    first!.focus();
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(second).toHaveFocus();
  });

  it("explains an outline without headings", () => {
    renderPanel("just text");
    expect(
      screen.getByText("Add a heading with = to see it here."),
    ).toBeInTheDocument();
  });

  it("updates after the source changes", async () => {
    vi.useFakeTimers();
    const { project } = renderPanel("= A\n");
    act(() => {
      getText(project, project.mainFile!).insert(0, "= Z\n");
      project.doc.commit();
      vi.advanceTimersByTime(300);
    });
    expect(screen.getAllByRole("treeitem")[0]).toHaveTextContent("Z");
    vi.useRealTimers();
  });
});
