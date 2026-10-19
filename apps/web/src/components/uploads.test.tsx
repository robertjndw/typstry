import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ProjectAssets } from "@/assets/project-assets";

import { EditorPane } from "@/components/EditorPane";
import { FileTree } from "@/components/FileTree";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createAsset, createFile } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { ProjectProvider } from "@/project/ProjectProvider";

const uploadFiles = vi.hoisted(() => vi.fn());
vi.mock("@/assets/upload", () => ({ uploadFiles }));

const uploadTreeReporting = vi.hoisted(() => vi.fn());
vi.mock("@/project/tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/project/tree")>()),
  uploadTreeReporting,
}));

// jsdom has no DataTransfer items, so the drop readers are stubbed.
const isTreeDrop = vi.hoisted(() => vi.fn(() => false));
const readDrop = vi.hoisted(() => vi.fn());
vi.mock("@/import/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/import/sources")>()),
  isTreeDrop,
  readDrop,
}));

function fakeAssets(): ProjectAssets {
  return {
    load: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    store: vi.fn(),
  };
}

function renderWorkspace(project: ProjectDoc, assets?: ProjectAssets) {
  return render(
    <TooltipProvider>
      <ProjectProvider doc={project} assets={assets}>
        <FileTree />
        <EditorPane />
      </ProjectProvider>
      <Toaster />
    </TooltipProvider>,
  );
}

describe("uploads and assets", () => {
  beforeEach(() => {
    uploadFiles.mockReset();
    uploadTreeReporting.mockReset();
    uploadTreeReporting.mockResolvedValue(null);
    isTreeDrop.mockReset();
    isTreeDrop.mockReturnValue(false);
    readDrop.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uploads dropped OS files into the folder and opens the first text file", async () => {
    const project = initProject(newProject(1), { title: "T" });
    const dir = createFile(project, null, "img", "dir");
    uploadFiles.mockImplementation(
      async (p: ProjectDoc, _assets: ProjectAssets, files: File[], parent) => {
        const id = createFile(p, parent, files[0]!.name, "text");
        return {
          created: [{ id, name: files[0]!.name, kind: "text" }],
          errors: [{ name: "big.png", error: new Error("File too large") }],
        };
      },
    );
    const assets = fakeAssets();
    renderWorkspace(project, assets);

    const file = new File(["@book{}"], "refs.bib");
    fireEvent.drop(screen.getByRole("treeitem", { name: "img" }), {
      dataTransfer: { files: [file], types: ["Files"], getData: () => "" },
    });

    await waitFor(() =>
      expect(uploadFiles).toHaveBeenCalledWith(project, assets, [file], dir),
    );
    expect(await screen.findByText(/big\.png: File too large/)).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("treeitem", { name: "refs.bib" }),
      ).toHaveAttribute("aria-current", "page"),
    );
  });

  it("restores a dropped zip into the folder through the tree path", async () => {
    const project = initProject(newProject(1), { title: "T" });
    const dir = createFile(project, null, "img", "dir");
    const assets = fakeAssets();
    renderWorkspace(project, assets);
    isTreeDrop.mockReturnValue(true);
    readDrop.mockReturnValue({ kind: "zip", source: Promise.resolve(null) });

    const zip = new File([new Uint8Array([80, 75])], "site.zip");
    fireEvent.drop(screen.getByRole("treeitem", { name: "img" }), {
      dataTransfer: { files: [zip], types: ["Files"], getData: () => "" },
    });

    await waitFor(() => expect(uploadTreeReporting).toHaveBeenCalledTimes(1));
    const [p, a, pending, parent] = uploadTreeReporting.mock.calls[0]!;
    expect([p, a, parent]).toEqual([project, assets, dir]);
    expect(pending.kind).toBe("zip");
    expect(readDrop).toHaveBeenCalledWith(expect.anything(), {
      unwrap: false,
    });
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("sends a single picked zip through the tree path", async () => {
    const project = initProject(newProject(1), { title: "T" });
    renderWorkspace(project, fakeAssets());

    const zip = new File([new Uint8Array([80, 75])], "Site.ZIP");
    fireEvent.change(screen.getByLabelText("Files to upload"), {
      target: { files: [zip] },
    });

    await waitFor(() => expect(uploadTreeReporting).toHaveBeenCalledTimes(1));
    expect(uploadTreeReporting.mock.calls[0]![2].kind).toBe("zip");
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("keeps other picked files on the plain upload path", async () => {
    const project = initProject(newProject(1), { title: "T" });
    uploadFiles.mockResolvedValue({ created: [], errors: [] });
    renderWorkspace(project, fakeAssets());

    fireEvent.change(screen.getByLabelText("Files to upload"), {
      target: { files: [new File(["a"], "a.txt"), new File(["b"], "b.zip")] },
    });

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    expect(uploadTreeReporting).not.toHaveBeenCalled();
  });

  it("uploads a picked folder through the tree path", async () => {
    const project = initProject(newProject(1), { title: "T" });
    renderWorkspace(project, fakeAssets());

    const file = new File(["= Hi"], "intro.typ");
    Object.defineProperty(file, "webkitRelativePath", {
      value: "book/intro.typ",
    });
    fireEvent.change(screen.getByLabelText("Folder to upload"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uploadTreeReporting).toHaveBeenCalledTimes(1));
    expect(uploadTreeReporting.mock.calls[0]![2].kind).toBe("files");
    expect(uploadTreeReporting.mock.calls[0]![3]).toBeNull();
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("hides uploads for local projects", () => {
    renderWorkspace(initProject(newProject(1), { title: "T" }));
    expect(
      screen.queryByRole("button", { name: "Upload files" }),
    ).not.toBeInTheDocument();
  });

  it("previews an image asset decrypted from the blob store", async () => {
    // A subclass rather than a plain object: the editor still constructs
    // URLs (for its workers) while this stub is in place.
    vi.stubGlobal(
      "URL",
      Object.assign(class extends URL {}, {
        createObjectURL: vi.fn(() => "blob:decrypted"),
        revokeObjectURL: vi.fn(),
      }),
    );
    const project = initProject(newProject(1), { title: "T" });
    createAsset(project, null, "logo.png", {
      hash: "abc",
      size: 2048,
      mime: "image/png",
    });
    const assets = fakeAssets();
    renderWorkspace(project, assets);
    expect(
      screen.getByRole("button", { name: "Upload files" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: "logo.png" }));
    expect(
      await screen.findByRole("img", { name: "logo.png" }),
    ).toHaveAttribute("src", "blob:decrypted");
    expect(assets.load).toHaveBeenCalledWith("abc");
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
  });
});
