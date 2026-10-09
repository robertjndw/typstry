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

  it("closes the open file when a peer deletes it", () => {
    const { project, other, hook } = setup();
    act(() => hook.result.current.openFile(other));

    const peer = fork(project, 2);
    deleteNode(peer, other);
    act(() => sync(project, peer));

    expect(hook.result.current.openFileId).toBeNull();
    expect(hook.result.current.index.byId.has(other)).toBe(false);
  });
});
