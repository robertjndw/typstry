import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { createFile, getText, setMainFile } from "@/doc/fs-ops";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { ProjectProvider } from "@/project/ProjectProvider";

import { useOutline } from "./useOutline";

function setup() {
  const project = initProject(newProject(1), { title: "Test" });
  const main = project.mainFile!;
  getText(project, main).update('= Start\n#include "ch/a.typ"\n');
  const dir = createFile(project, null, "ch", "dir");
  const a = createFile(project, dir, "a.typ", "text", "== In A\n");
  const other = createFile(project, null, "other.typ", "text", "= Other\n");
  project.doc.commit();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ProjectProvider doc={project}>{children}</ProjectProvider>
  );
  const hook = renderHook(() => useOutline(), { wrapper });
  return { project, main, a, other, hook };
}

const titles = (hook: ReturnType<typeof setup>["hook"]) =>
  hook.result.current.items.map((i) => i.title);

describe("useOutline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts at the main file and follows its includes", () => {
    const { hook } = setup();
    expect(titles(hook)).toEqual(["Start", "In A"]);
  });

  it("recomputes debounced after an edit inside the include graph", () => {
    const { project, a, hook } = setup();
    act(() => {
      getText(project, a).insert(0, "== New\n");
      project.doc.commit();
    });
    expect(titles(hook)).toEqual(["Start", "In A"]);
    act(() => void vi.advanceTimersByTime(250));
    expect(titles(hook)).toEqual(["Start", "New", "In A"]);
  });

  it("ignores edits to files outside the include graph", () => {
    const { project, other, hook } = setup();
    const before = hook.result.current.items;
    act(() => {
      getText(project, other).insert(0, "= More\n");
      project.doc.commit();
      vi.advanceTimersByTime(250);
    });
    expect(hook.result.current.items).toBe(before);
  });

  it("follows a change of the main file", () => {
    const { project, other, hook } = setup();
    act(() => setMainFile(project, other));
    expect(titles(hook)).toEqual(["Other"]);
  });
});
