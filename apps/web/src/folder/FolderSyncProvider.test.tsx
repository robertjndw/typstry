import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { defaultBackend } from "@/persist/local-doc-store";

import { useFolderSync, type FolderSyncApi } from "./context";
import { FolderSyncProvider } from "./FolderSyncProvider";
import { fakeAssets, fakeFolder, type FakeFolder } from "./test-utils";

const seen: { api: FolderSyncApi | null } = { api: null };

function Probe() {
  const api = useFolderSync();
  useEffect(() => {
    seen.api = api;
  });
  return (
    <span>{api ? (api.linkName ?? "unlinked") : "no folder support"}</span>
  );
}

function setup(spaceId: string) {
  const project = initProject(newProject(1), { title: "T", starter: false });
  const view = render(
    <FolderSyncProvider
      spaceId={spaceId}
      project={project}
      assets={fakeAssets()}
      canWrite
      synced
      saveLocally={async () => {}}
    >
      <Probe />
    </FolderSyncProvider>,
  );
  return { project, ...view };
}

function pickerReturns(folder: FakeFolder | null) {
  const picker = vi.fn(async () => {
    if (!folder) throw new DOMException("dismissed", "AbortError");
    return folder.handle;
  });
  vi.stubGlobal("showDirectoryPicker", picker);
  return picker;
}

beforeEach(() => {
  seen.api = null;
  vi.stubGlobal("isSecureContext", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FolderSyncProvider", () => {
  it("offers nothing where the browser has no folder picker", () => {
    vi.stubGlobal("showDirectoryPicker", undefined);
    setup("unsupported");
    expect(screen.getByText("no folder support")).toBeTruthy();
    expect(seen.api).toBeNull();
  });

  it("links an empty folder at once and unlinks it again", async () => {
    pickerReturns(fakeFolder());
    setup("link-unlink");
    await screen.findByText("unlinked");

    await act(() => seen.api!.link());
    await screen.findByText("root");
    const backend = await defaultBackend();
    expect((await backend.loadFolder("link-unlink"))?.name).toBe("root");

    await act(() => seen.api!.unlink());
    await screen.findByText("unlinked");
    expect(await backend.loadFolder("link-unlink")).toBeNull();
  });

  it("does nothing when the picker is dismissed", async () => {
    pickerReturns(null);
    setup("dismissed");
    await screen.findByText("unlinked");

    await act(() => seen.api!.link());
    expect(screen.getByText("unlinked")).toBeTruthy();
    expect(await (await defaultBackend()).loadFolder("dismissed")).toBeNull();
  });

  it("asks first when files differ, and applies the answer", async () => {
    const folder = fakeFolder({ "main.typ": "from the folder" });
    pickerReturns(folder);
    const { project } = setup("differs");
    await screen.findByText("unlinked");
    // The project holds a different main.typ.
    const { createFile, getText } = await import("@/doc/fs-ops");
    const id = createFile(project, null, "main.typ", "text");
    getText(project, id).insert(0, "from the project");
    project.doc.commit();

    await act(() => seen.api!.link());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Use project versions");
    expect(screen.getByText("unlinked")).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Use project versions" }).click();
    });
    await screen.findByText("root");
    await waitFor(() =>
      expect(folder.text("main.typ")).toBe("from the project"),
    );
  });

  it("re-attaches a stored link on mount", async () => {
    pickerReturns(null);
    const folder = fakeFolder();
    await (
      await defaultBackend()
    ).saveFolder({
      spaceId: "stored",
      v: 1,
      handle: folder.handle,
      name: "kept",
      base: null,
    });
    setup("stored");
    await screen.findByText("kept");
  });
});
