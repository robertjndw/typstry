import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { createFile, deleteNode, getText, rename } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";

import { useProject } from "./context";
import { ProjectProvider } from "./ProjectProvider";

function setup() {
  const project = initProject(newProject(1), { title: "Test" });
  const other = createFile(project, null, "other.typ", "text");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ProjectProvider doc={project}>{children}</ProjectProvider>
  );
  const hook = renderHook(() => useProject(), { wrapper });
  return { project, other, hook };
}

function edit(project: ProjectDoc, id: Parameters<typeof getText>[1]) {
  getText(project, id).insert(0, "x");
  project.doc.commit();
}

describe("ProjectProvider", () => {
  it("opens the main file and clears undo history when switching files", () => {
    const { project, other, hook } = setup();
    const main = project.mainFile!;
    expect(hook.result.current.openFileId).toBe(main);

    act(() => edit(project, main));
    expect(hook.result.current.undoManager.canUndo()).toBe(true);

    act(() => hook.result.current.openFile(other));
    expect(hook.result.current.openFileId).toBe(other);
    expect(hook.result.current.undoManager.canUndo()).toBe(false);
  });

  it("ignores attempts to open folders", () => {
    const { project, hook } = setup();
    const dir = createFile(project, null, "chapters", "dir");
    act(() => hook.result.current.openFile(dir));
    expect(hook.result.current.openFileId).toBe(project.mainFile);
  });

  it("re-renders on tree changes but not on text edits", () => {
    const { project, other, hook } = setup();
    const before = hook.result.current.index;

    act(() => edit(project, other));
    expect(hook.result.current.index).toBe(before);

    act(() => rename(project, other, "renamed.typ"));
    expect(hook.result.current.index).not.toBe(before);
    expect(hook.result.current.index.byId.get(other)?.path).toBe("renamed.typ");
  });

  it("keeps the same value when a change leaves the files alone", () => {
    const { project, hook } = setup();
    const before = hook.result.current;

    act(() => project.setPeer("7", { name: "Ada", color: "#000" }));
    expect(hook.result.current).toBe(before);

    act(() => {
      project.meta.set("title", "Renamed");
      project.doc.commit();
    });
    expect(hook.result.current).not.toBe(before);
    expect(hook.result.current.title).toBe("Renamed");
    expect(hook.result.current.index).toBe(before.index);
  });

  it("opens new tabs next to the active one", () => {
    const { project, other, hook } = setup();
    const main = project.mainFile!;
    const third = createFile(project, null, "third.typ", "text");
    expect(hook.result.current.tabs).toEqual([main]);

    act(() => hook.result.current.openFile(other));
    act(() => hook.result.current.openFile(main));
    act(() => hook.result.current.openFile(third));
    expect(hook.result.current.tabs).toEqual([main, third, other]);
    expect(hook.result.current.openFileId).toBe(third);
  });

  it("activates the neighboring tab when closing the active one", () => {
    const { project, other, hook } = setup();
    const main = project.mainFile!;
    const third = createFile(project, null, "third.typ", "text");
    act(() => hook.result.current.openFile(other));
    act(() => hook.result.current.openFile(third));

    act(() => hook.result.current.closeFile(other));
    expect(hook.result.current.tabs).toEqual([main, third]);
    expect(hook.result.current.openFileId).toBe(third);

    act(() => hook.result.current.closeFile(third));
    expect(hook.result.current.openFileId).toBe(main);

    act(() => hook.result.current.closeFile(main));
    expect(hook.result.current.tabs).toEqual([]);
    expect(hook.result.current.openFileId).toBeNull();
  });

  it("closes the tab of a file a peer deletes", () => {
    const { project, other, hook } = setup();
    act(() => hook.result.current.openFile(other));

    const peer = fork(project, 2);
    deleteNode(peer, other);
    act(() => sync(project, peer));

    expect(hook.result.current.tabs).toEqual([project.mainFile]);
    expect(hook.result.current.openFileId).toBe(project.mainFile);
    expect(hook.result.current.index.byId.has(other)).toBe(false);
  });
});
