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

  it("hides uploads for local projects", () => {
    renderWorkspace(initProject(newProject(1), { title: "T" }));
    expect(
      screen.queryByRole("button", { name: "Upload files" }),
    ).not.toBeInTheDocument();
  });

  it("previews an image asset decrypted from the blob store", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:decrypted"),
      revokeObjectURL: vi.fn(),
    });
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
