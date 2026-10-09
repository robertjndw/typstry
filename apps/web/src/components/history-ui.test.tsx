import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createFile, getText } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { listVersions } from "@/doc/versions";
import { ProjectProvider } from "@/project/ProjectProvider";

import { ProjectWorkspace } from "./ProjectWorkspace";

function renderWorkspace(project: ProjectDoc, readOnly = false) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ProjectProvider doc={project} readOnly={readOnly}>
          <ProjectWorkspace documentTitle />
        </ProjectProvider>
        <Toaster />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("project title", () => {
  it("renames inline on Enter and mirrors the tab title", () => {
    const project = initProject(newProject(1), { title: "Old" });
    renderWorkspace(project);
    expect(document.title).toBe("Old · typstry");

    fireEvent.click(screen.getByRole("button", { name: /Project title: Old/ }));
    const input = screen.getByRole("textbox", { name: "Project title" });
    fireEvent.change(input, { target: { value: "  Thesis  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(project.title).toBe("Thesis");
    expect(
      screen.getByRole("button", { name: /Project title: Thesis/ }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Thesis · typstry");
  });

  it("cancels on Escape and rejects an empty title", () => {
    const project = initProject(newProject(1), { title: "Keep" });
    renderWorkspace(project);
    fireEvent.click(screen.getByRole("button", { name: /Project title/ }));
    let input = screen.getByRole("textbox", { name: "Project title" });
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(project.title).toBe("Keep");

    fireEvent.click(screen.getByRole("button", { name: /Project title/ }));
    input = screen.getByRole("textbox", { name: "Project title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(project.title).toBe("Keep");
  });

  it("follows remote renames and is not editable read-only", () => {
    const project = initProject(newProject(1), { title: "Shared" });
    renderWorkspace(project, true);
    expect(
      screen.queryByRole("button", { name: /Project title/ }),
    ).not.toBeInTheDocument();
    act(() => {
      project.meta.set("title", "Renamed elsewhere");
      project.doc.commit();
    });
    expect(screen.getByText("Renamed elsewhere")).toBeInTheDocument();
  });
});

describe("history", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("saves a version, views it with changes and restores it", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    const main = project.mainFile!;
    renderWorkspace(project);

    expect(
      screen.queryByRole("button", { name: "Save version" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    const dialog = screen.getByRole("dialog", { name: "Save version" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Version name" }),
      { target: { value: "First draft" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(listVersions(project).map((v) => v.name)).toEqual(["First draft"]);
    const saved = await screen.findByRole("list", { name: "Versions" });
    expect(
      await within(saved).findByRole("button", { name: /First draft/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    act(() => {
      getText(project, main).insert(0, "Later edit\n");
      project.doc.commit();
      createFile(project, null, "extra.typ", "text", "x");
    });

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    const entry = within(list).getByRole("button", { name: /First draft/ });
    fireEvent.click(entry);

    expect(screen.getByText(/Viewing/)).toHaveTextContent(
      "Viewing First draft",
    );
    // The old version has no extra.typ, and the live doc is untouched.
    expect(
      screen.queryByRole("treeitem", { name: "extra.typ" }),
    ).not.toBeInTheDocument();
    expect(buildPathIndex(project).byPath.has("extra.typ")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(
      screen.getByRole("button", { name: "Show changes" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    const confirm = screen.getByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Restore" }));

    expect(getText(project, main).toString()).not.toMatch(/Later edit/);
    expect(buildPathIndex(project).byPath.has("extra.typ")).toBe(false);
    expect(screen.queryByText(/Viewing/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: "main.typ" }),
    ).toBeInTheDocument();
  });

  it("offers no restore or save with a view link", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    renderWorkspace(project, true);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    expect(
      screen.queryByRole("button", { name: "Save version" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(list).getAllByRole("button")[0]!);
    expect(screen.getByText(/Viewing/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore this version" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    expect(screen.queryByText(/Viewing/)).not.toBeInTheDocument();
  });
});
