import { loadRecent, rememberProject, updateRecentTitle } from "./recent";

describe("recent projects", () => {
  afterEach(() => localStorage.clear());

  it("updates a renamed project's title in place", () => {
    rememberProject(
      { projectId: "a", token: "ta", title: "A" },
      localStorage,
      1,
    );
    rememberProject(
      { projectId: "b", token: "tb", title: "B" },
      localStorage,
      2,
    );
    updateRecentTitle("a", "A renamed", localStorage);
    updateRecentTitle("unknown", "X", localStorage);
    expect(
      loadRecent(localStorage).map((p) => [p.projectId, p.title, p.visitedAt]),
    ).toEqual([
      ["b", "B", 2],
      ["a", "A renamed", 1],
    ]);
  });
});
