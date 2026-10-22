import { act, renderHook } from "@testing-library/react";

import { createFile, getText } from "@/doc/fs-ops";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { useProjectSearch } from "./useProjectSearch";
import type { SearchQuery } from "./search";

const query = (pattern: string): SearchQuery => ({
  pattern,
  regex: false,
  caseSensitive: false,
  wholeWord: false,
});

describe("useProjectSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces, then follows edits and new files", () => {
    const project = initProject(newProject(1), { title: "T" });
    createFile(project, null, "a.typ", "text", "needle");
    const { result, rerender } = renderHook(
      ({ q }) => useProjectSearch(project, q),
      { initialProps: { q: query("needle") } },
    );
    expect(result.current).toMatchObject({ result: null, searching: true });
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.searching).toBe(false);
    expect(result.current.result).toMatchObject({ total: 1 });

    act(() => {
      getText(project, project.mainFile!).insert(0, "needle ");
      project.doc.commit();
      createFile(project, null, "b.typ", "text", "needle");
    });
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.result).toMatchObject({ total: 3 });

    rerender({ q: query("zzz") });
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.result).toMatchObject({ total: 0 });
  });
});
