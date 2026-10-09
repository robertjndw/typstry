import {
  forgetProject,
  loadProjectKey,
  loadShare,
  loadShareLinks,
  loadRecent,
  rememberProject,
  rememberShare,
  saveProjectKey,
  saveShareLinks,
  updateRecentTitle,
} from "./recent";

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

  it("forgets everything stored about one project", () => {
    const key = "A".repeat(43);
    for (const id of ["a", "b"]) {
      rememberProject(
        { projectId: id, token: `t${id}`, title: id },
        localStorage,
      );
      saveShareLinks(
        id,
        { editToken: `e${id}`, viewToken: `v${id}` },
        localStorage,
      );
      rememberShare(
        `e${id}`,
        { projectId: id, permission: "write" },
        localStorage,
      );
      rememberShare(
        `v${id}`,
        { projectId: id, permission: "read" },
        localStorage,
      );
    }
    saveProjectKey("a", key, localStorage);

    forgetProject("a", localStorage);

    expect(loadRecent(localStorage).map((p) => p.projectId)).toEqual(["b"]);
    expect(loadShareLinks("a", localStorage)).toBeNull();
    expect(loadProjectKey("a", localStorage)).toBeNull();
    expect(loadShare("ea", localStorage)).toBeNull();
    expect(loadShare("va", localStorage)).toBeNull();
    expect(loadShareLinks("b", localStorage)).not.toBeNull();
    expect(loadShare("vb", localStorage)).not.toBeNull();
  });
});
