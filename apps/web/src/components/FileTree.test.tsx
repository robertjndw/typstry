import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createFile } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";
import { ProjectProvider } from "@/project/ProjectProvider";

import { FileTree } from "./FileTree";

function renderTree(project: ProjectDoc) {
  return render(
    <TooltipProvider>
      <ProjectProvider doc={project}>
        <FileTree />
      </ProjectProvider>
      <Toaster />
    </TooltipProvider>,
  );
}

function setup() {
  const project = initProject(newProject(1), { title: "Test" });
  renderTree(project);
  return project;
}

const item = (name: string) => screen.getByRole("treeitem", { name });

function typeAndEnter(label: string, value: string) {
  const input = screen.getByRole("textbox", { name: label });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function paths(project: ProjectDoc) {
  return [...buildPathIndex(project).byPath.keys()].sort();
}

describe("FileTree", () => {
  it("creates a file from the toolbar and opens it", () => {
    const project = setup();
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    typeAndEnter("New file name", "chapter.typ");

    expect(paths(project)).toEqual(["chapter.typ", "main.typ"]);
    expect(item("chapter.typ")).toHaveAttribute("aria-current", "page");
  });

  it("creates files inside the selected folder", () => {
    const project = setup();
    act(() => void createFile(project, null, "chapters", "dir"));
    fireEvent.click(item("chapters"));
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    typeAndEnter("New file name", "intro.typ");

    expect(paths(project)).toContain("chapters/intro.typ");
  });

  it("collapses all folders, and is disabled when none are open", () => {
    const project = setup();
    const collapseAll = screen.getByRole("button", { name: "Collapse all" });
    expect(collapseAll).toBeDisabled();

    act(() => {
      const dir = createFile(project, null, "chapters", "dir");
      createFile(project, dir, "intro.typ", "text");
    });
    expect(item("chapters")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(collapseAll);
    expect(item("chapters")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "intro.typ" })).toBeNull();
    expect(collapseAll).toBeDisabled();
  });

  it("disables collapse all when open folders are hidden in a closed one", () => {
    const project = setup();
    act(() => {
      const dir = createFile(project, null, "chapters", "dir");
      createFile(project, dir, "drafts", "dir");
    });
    expect(item("drafts")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(item("chapters"));
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeDisabled();
  });

  it("renames inline with F2", () => {
    const project = setup();
    fireEvent.keyDown(item("main.typ"), { key: "F2" });
    typeAndEnter("Rename main.typ", "index.typ");

    expect(paths(project)).toEqual(["index.typ"]);
    expect(item("index.typ")).toBeInTheDocument();
  });

  it("deletes after confirmation", () => {
    const project = setup();
    fireEvent.keyDown(item("main.typ"), { key: "Delete" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("main.typ");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(paths(project)).toEqual([]);
    expect(screen.queryByRole("treeitem")).toBeNull();
  });

  it("sets the main file from the context menu", async () => {
    const project = setup();
    let other;
    act(() => {
      other = createFile(project, null, "other.typ", "text");
    });

    expect(within(item("main.typ")).getByText("main")).toBeInTheDocument();
    fireEvent.contextMenu(item("other.typ"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Set as main file" }),
    );

    expect(project.mainFile).toBe(other);
    expect(within(item("other.typ")).getByText("main")).toBeInTheDocument();
    expect(within(item("main.typ")).queryByText("main")).toBeNull();
  });

  it("reports fs errors as toasts", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    typeAndEnter("New file name", "main.typ");

    expect(
      await screen.findByText('"main.typ" already exists in this folder'),
    ).toBeInTheDocument();
  });

  it("flags the loser of a concurrent same-name create", () => {
    const a = initProject(newProject(1), { title: "Test" });
    const b = fork(a, 2);
    createFile(a, null, "notes.typ", "text");
    createFile(b, null, "notes.typ", "text");
    sync(a, b);
    renderTree(a);

    const items = screen
      .getAllByRole("treeitem")
      .filter((el) => el.getAttribute("aria-label")?.startsWith("notes"));
    expect(items).toHaveLength(2);
    const flagged = items.filter(
      (el) => within(el).queryByLabelText("Name conflict") !== null,
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toHaveAccessibleName(/^notes~\d+@\d+\.typ$/);
  });
});

describe("FileTree read-only", () => {
  it("offers no way to change files", () => {
    const project = initProject(newProject(1), { title: "Test" });
    render(
      <TooltipProvider>
        <ProjectProvider doc={project} readOnly>
          <FileTree />
        </ProjectProvider>
      </TooltipProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "New file" }),
    ).not.toBeInTheDocument();
    const main = screen.getByRole("treeitem", { name: "main.typ" });
    expect(main).toHaveAttribute("draggable", "false");
    fireEvent.keyDown(main, { key: "F2" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.keyDown(main, { key: "Delete" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
