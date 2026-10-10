import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createFile, getText } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { listVersions, saveVersion } from "@/doc/versions";
import { IS_MAC } from "@/lib/platform";
import { ProjectProvider } from "@/project/ProjectProvider";
import type { SyncNowResult } from "@/sync/connection";

import { ProjectWorkspace } from "./ProjectWorkspace";
import { VersionView } from "./VersionView";

function renderWorkspace(
  project: ProjectDoc,
  readOnly = false,
  onSyncNow?: () => Promise<SyncNowResult>,
) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ProjectProvider doc={project} readOnly={readOnly}>
          <ProjectWorkspace documentTitle onSyncNow={onSyncNow} />
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
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The "Tagged only" filter is remembered per browser.
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("tags the current version, views it with changes and restores it", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    const main = project.mainFile!;
    renderWorkspace(project);

    expect(
      screen.queryByRole("button", { name: "Tag current version" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Tag current version" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Tag current version" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Tag name" }),
      { target: { value: "First draft" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Tag" }));
    expect(listVersions(project).map((v) => v.name)).toEqual(["First draft"]);
    const saved = await screen.findByRole("list", { name: "Versions" });
    expect(await within(saved).findByText("First draft")).toBeInTheDocument();
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
    fireEvent.click(
      within(rowWith(list, "First draft")).getAllByRole("button")[0]!,
    );

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

  it("opens a version straight into its diff", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    renderWorkspace(project);
    act(() => {
      createFile(project, null, "notes.typ", "text", "Draft notes");
    });

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    fireEvent.click(
      within(list).getAllByRole("button", { name: "Show changes" })[0]!,
    );

    expect(screen.getByText(/Viewing/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show changes" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Changes")).toBeInTheDocument();
  });

  it("previews versions on top of the history and steps through them", async () => {
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const project = initProject(newProject(1), { title: "Paper" });
    saveVersion(project, "First");
    vi.setSystemTime(new Date("2026-10-10T11:00:00Z"));
    getText(project, project.mainFile!).insert(0, "Later\n");
    project.doc.commit();
    renderWorkspace(project);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    fireEvent.click(
      within(list).getAllByRole("button", { name: "Preview" })[0]!,
    );

    // The newest version first: nothing newer, one older.
    const preview = screen.getByRole("dialog", { name: /ago|just now/ });
    expect(
      within(preview).getByRole("button", { name: "Older version" }),
    ).toBeEnabled();
    expect(
      within(preview).getByRole("button", { name: "Newer version" }),
    ).toBeDisabled();
    expect(
      within(preview).getByRole("button", { name: "Download PDF" }),
    ).toBeInTheDocument();
    // Only a preview: the live project stays open and the history with it.
    expect(screen.queryByText(/Viewing/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Versions", hidden: true }),
    ).toBeInTheDocument();

    fireEvent.keyDown(preview, {
      key: "ArrowLeft",
    });
    expect(screen.getByRole("dialog", { name: "First" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Older version" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Newer version" }));
    expect(
      screen.getByRole("dialog", { name: /ago|just now/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open version" }));
    expect(screen.getByText(/Viewing/)).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "History" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("picks a changed file when the main file did not change", () => {
    const project = initProject(newProject(1), { title: "Paper" });
    project.doc.commit();
    const before = project.doc.oplogFrontiers();
    createFile(project, null, "notes.typ", "text", "Draft notes");
    project.doc.commit();
    render(
      <MemoryRouter>
        <TooltipProvider>
          <VersionView
            project={project}
            target={{
              key: "v",
              label: "Notes added",
              time: null,
              frontiers: project.doc.oplogFrontiers(),
              previous: before,
            }}
            assets={null}
            canRestore={false}
            onClose={() => {}}
            showChangesOnOpen
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Changes")).toHaveTextContent("Draft notes");
  });

  it("untags a version, with undo", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    saveVersion(project, "Keep me");
    saveVersion(project, "Drop me");
    renderWorkspace(project);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    // Both tags name the same state, so they share one row.
    expect(rowWith(list, "Drop me")).toBe(rowWith(list, "Keep me"));
    fireEvent.click(
      within(list).getByRole("button", { name: "Remove tag Drop me" }),
    );
    expect(listVersions(project).map((v) => v.name)).toEqual(["Keep me"]);
    expect(within(list).queryByText("Drop me")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(listVersions(project).map((v) => v.name)).toEqual([
      "Keep me",
      "Drop me",
    ]);
    expect(await within(list).findByText("Drop me")).toBeInTheDocument();
  });

  it("tags an older version from its row", async () => {
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const project = initProject(newProject(1), { title: "Paper" });
    const older = project.doc.oplogFrontiers();
    vi.setSystemTime(new Date("2026-10-10T11:00:00Z"));
    getText(project, project.mainFile!).insert(0, "Later\n");
    project.doc.commit();
    renderWorkspace(project);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    fireEvent.click(
      within(rows[1]!).getByRole("button", { name: "Tag this version" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Tag this version" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Tag name" }),
      { target: { value: "Before" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Tag" }));

    const [tag] = listVersions(project);
    expect(tag!.name).toBe("Before");
    expect(project.doc.cmpFrontiers(tag!.frontiers, older)).toBe(0);
    await vi.waitFor(() =>
      expect(rowWith(list, "Before")).toBe(
        within(list).getAllByRole("listitem")[1],
      ),
    );
  });

  it("tags each version only once", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    saveVersion(project, "Only tag");
    renderWorkspace(project);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    expect(
      within(rowWith(list, "Only tag")).queryByRole("button", {
        name: "Tag this version",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tag current version" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Current version is tagged .Only tag./),
    ).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    // The menu does not know; the dialog says so instead of tagging twice.
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Tag current version/ }),
    );
    expect(
      screen.getByRole("dialog", { name: "Already tagged" }),
    ).toHaveTextContent("Only tag");
    expect(
      screen.queryByRole("textbox", { name: "Tag name" }),
    ).not.toBeInTheDocument();
  });

  it("filters the history down to tagged versions", async () => {
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const project = initProject(newProject(1), { title: "Paper" });
    vi.setSystemTime(new Date("2026-10-10T11:00:00Z"));
    getText(project, project.mainFile!).insert(0, "Later\n");
    project.doc.commit();
    renderWorkspace(project);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Tagged only" }));
    expect(screen.getByText("No tagged versions yet")).toBeInTheDocument();

    act(() => {
      saveVersion(project, "Now");
    });
    await vi.waitFor(() => {
      const rows = within(
        screen.getByRole("list", { name: "Versions" }),
      ).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("Now");
    });
  });

  it("offers no restore or save with a view link", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    renderWorkspace(project, true);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    for (const name of [
      "Tag current version",
      "Tag this version",
      /^Remove tag/,
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    fireEvent.click(within(list).getAllByRole("button")[0]!);
    expect(screen.getByText(/Viewing/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore this version" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    expect(screen.queryByText(/Viewing/)).not.toBeInTheDocument();
  });
});

/** The history row that shows `text`, e.g. one of its tags. */
function rowWith(list: HTMLElement, text: string): HTMLElement {
  return within(list).getByText(text).closest("li")!;
}

function pressMod(key: string) {
  fireEvent.keyDown(document.body, {
    key,
    [IS_MAC ? "metaKey" : "ctrlKey"]: true,
  });
}

describe("workspace shortcuts", () => {
  it("syncs with Mod+S, also from the editor", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    const onSyncNow = vi.fn(async (): Promise<SyncNowResult> => "synced");
    renderWorkspace(project, false, onSyncNow);
    const editor = document.querySelector(".cm-content")!;
    const event = new KeyboardEvent("keydown", {
      key: "s",
      [IS_MAC ? "metaKey" : "ctrlKey"]: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onSyncNow).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("All changes synced")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains when the server is unreachable", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    renderWorkspace(project, false, async () => "offline");
    pressMod("s");
    expect(
      await screen.findByText(/Your changes are saved on this device/),
    ).toBeInTheDocument();
  });

  it("ignores Mod+S while a sync is still running", async () => {
    const project = initProject(newProject(1), { title: "Paper" });
    let finish!: (result: SyncNowResult) => void;
    const onSyncNow = vi.fn(
      () => new Promise<SyncNowResult>((resolve) => (finish = resolve)),
    );
    renderWorkspace(project, false, onSyncNow);
    pressMod("s");
    pressMod("s");
    expect(onSyncNow).toHaveBeenCalledTimes(1);
    await act(async () => finish("synced"));
    pressMod("s");
    expect(onSyncNow).toHaveBeenCalledTimes(2);
  });

  it("finds and opens a file with Mod+P", () => {
    const project = initProject(newProject(1), { title: "Paper" });
    act(() => {
      createFile(project, null, "chapter-intro.typ", "text", "x");
      createFile(project, null, "figures", "dir");
    });
    renderWorkspace(project);
    pressMod("p");
    const input = screen.getByRole("combobox", { name: "File name" });
    const list = screen.getByRole("listbox", { name: "Files" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).not.toContain("figures");

    fireEvent.change(input, { target: { value: "chint" } });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: "chapter-intro.typ" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("keeps the less used actions in the more menu", () => {
    const project = initProject(newProject(1), { title: "Paper" });
    renderWorkspace(project, false, async () => "synced");
    expect(
      screen.getByRole("banner").querySelector("[title*=zip]"),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    const menu = screen.getByRole("menu");
    for (const name of [
      /Sync now/,
      "Download as zip",
      "History",
      /Tag current version/,
    ]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
  });
});

describe("phone layout", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows one view at a time and jumps to the editor on opening a file", () => {
    const project = initProject(newProject(1), { title: "Paper" });
    act(() => {
      createFile(project, null, "notes.typ", "text", "x");
    });
    renderWorkspace(project);
    const views = screen.getByRole("navigation", { name: "Workspace views" });
    const files = within(views).getByRole("button", { name: "Files" });
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    expect(screen.getByRole("region", { name: "Editor" })).toBeVisible();

    fireEvent.click(files);
    expect(files).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Editor" })).toBeNull();
    fireEvent.click(screen.getByRole("treeitem", { name: "notes.typ" }));
    expect(screen.getByRole("region", { name: "Editor" })).toBeVisible();
    expect(
      within(views).getByRole("button", { name: "Editor" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
