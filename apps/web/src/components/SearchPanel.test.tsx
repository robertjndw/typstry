import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createFile, getText } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { ProjectProvider } from "@/project/ProjectProvider";
import { RevealContext, type RevealFn } from "@/project/reveal-context";
import { resetSearchState } from "@/search/search-state";

import { SearchPanel } from "./SearchPanel";

function setup({ readOnly = false } = {}) {
  const project = initProject(newProject(1), { title: "T" });
  getText(project, project.mainFile!).insert(0, "foo main");
  project.doc.commit();
  const chapter = createFile(project, null, "chapter.typ", "text", "x foo foo");
  const reveal = vi.fn<RevealFn>();
  render(
    <TooltipProvider>
      <ProjectProvider doc={project} readOnly={readOnly}>
        <RevealContext value={reveal}>
          <SearchPanel />
        </RevealContext>
      </ProjectProvider>
      <Toaster />
    </TooltipProvider>,
  );
  return { project, chapter, reveal };
}

async function search(text: string) {
  fireEvent.change(screen.getByLabelText("Search query"), {
    target: { value: text },
  });
  await act(() => vi.advanceTimersByTimeAsync(200));
}

const text = (p: ProjectDoc, name: string) => {
  const id = [...p.fs.getNodes({ withDeleted: false })].find(
    (n) => n.data.get("name") === name,
  )!.id;
  return getText(p, id).toString();
};

describe("SearchPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetSearchState();
  });
  afterEach(() => vi.useRealTimers());

  it("lists results grouped by file", async () => {
    setup();
    await search("foo");
    expect(screen.getByRole("status")).toHaveTextContent(
      "3 results in 2 files",
    );
    expect(screen.getByRole("button", { name: "chapter.typ" })).toBeVisible();
    expect(screen.getByRole("button", { name: "main.typ" })).toBeVisible();
  });

  it("toggles options with aria-pressed", async () => {
    setup();
    await search("FOO");
    expect(screen.getByRole("status")).toHaveTextContent("3 results");
    const aa = screen.getByRole("button", { name: "Match case" });
    expect(aa).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(aa);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(aa).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("No results");
  });

  it("shows a regex error", async () => {
    setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Use regular expression" }),
    );
    await search("(");
    expect(screen.getByRole("status").firstChild).toHaveClass(
      "text-destructive",
    );
  });

  it("reveals the match range on click", async () => {
    const { chapter, reveal } = setup();
    await search("foo");
    const group = screen.getByRole("button", { name: "chapter.typ" });
    const rows = within(group.closest("[data-slot=collapsible]")!).getAllByText(
      "foo",
    );
    fireEvent.click(rows[1]!);
    expect(reveal).toHaveBeenCalledWith(chapter, {
      kind: "offset",
      from: 6,
      to: 9,
    });
  });

  it("hides replace controls when read only", async () => {
    setup({ readOnly: true });
    await search("foo");
    expect(screen.queryByLabelText("Replacement")).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace all" })).toBeNull();
  });

  it("replaces all and reports it", async () => {
    const { project } = setup();
    await search("foo");
    fireEvent.change(screen.getByLabelText("Replacement"), {
      target: { value: "bar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(text(project, "main.typ")).toMatch(/^bar main/);
    expect(text(project, "chapter.typ")).toBe("x bar bar");
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByText("Replaced 3 matches")).toBeInTheDocument();
  });

  it("clears the query on Escape", async () => {
    setup();
    await search("foo");
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Escape" });
    expect(screen.getByLabelText("Search query")).toHaveValue("");
  });
});
