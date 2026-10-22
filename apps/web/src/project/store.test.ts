import { afterEach, describe, expect, it } from "vitest";

import { addComment, deleteComment, listThreads } from "@/doc/comments";
import { createFile, deleteNode, getText } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { fork, newProject } from "@/doc/test-utils";
import { FOLDER_ORIGIN } from "@/folder/origin";

import { loadOpenTabs, saveOpenTabs } from "./open-tabs";
import { ProjectStore } from "./store";

describe("ProjectStore undo", () => {
  it("never undoes edits that came from the linked folder", () => {
    const project = initProject(newProject(1), { title: "T" });
    const main = project.mainFile!;
    const store = new ProjectStore(project);
    const text = getText(project, main);
    const before = text.toString();

    text.insert(0, "disk ");
    project.doc.commit({ origin: FOLDER_ORIGIN });
    expect(store.undoManager.canUndo()).toBe(false);

    text.insert(0, "typed ");
    project.doc.commit();
    expect(store.undoManager.canUndo()).toBe(true);
    store.undoManager.undo();
    expect(text.toString()).toBe(`disk ${before}`);
    store.dispose();
  });

  it("never undoes comments", () => {
    const project = initProject(newProject(1), { title: "T" });
    const main = project.mainFile!;
    const store = new ProjectStore(project);
    const text = getText(project, main);
    const before = text.toString();

    text.insert(0, "typed ");
    project.doc.commit();
    const id = addComment(project, {
      fileId: main,
      text,
      from: 0,
      to: 5,
      body: "Why?",
      name: "Ada",
      color: "#3366cc",
    });
    store.undoManager.undo();
    expect(text.toString()).toBe(before);
    expect(listThreads(project).map((t) => t.id)).toEqual([id]);
    expect(store.undoManager.canUndo()).toBe(false);

    deleteComment(project, id);
    expect(store.undoManager.canUndo()).toBe(false);
    store.dispose();
  });
});

describe("ProjectStore tabs", () => {
  afterEach(() => localStorage.clear());

  function setup() {
    const project = initProject(newProject(1), { title: "T" });
    const a = createFile(project, null, "a.typ", "text");
    const b = createFile(project, null, "b.typ", "text");
    return { project, main: project.mainFile!, a, b };
  }

  function mount(project: ProjectDoc, projectId?: string) {
    const store = new ProjectStore(project, { projectId });
    store.subscribe(() => {});
    return store;
  }

  it("reopens the tabs of the last visit", () => {
    const { project, main, a, b } = setup();
    const first = mount(project, "p");
    first.open(a);
    first.open(b);
    first.open(a);
    first.dispose();

    const { tabs, openFileId } = mount(project, "p").getSnapshot();
    expect(tabs).toEqual([main, a, b]);
    expect(openFileId).toBe(a);
  });

  it("keeps the tabs of each project apart", () => {
    const { project, main, a } = setup();
    mount(project, "p").open(a);
    expect(mount(project, "q").getSnapshot().tabs).toEqual([main]);
  });

  it("remembers nothing without a project id", () => {
    const { project, main, a } = setup();
    mount(project).open(a);
    expect(
      Object.keys(localStorage).filter((k) => k.startsWith("typstry:tabs:")),
    ).toEqual([]);
    expect(mount(project).getSnapshot().tabs).toEqual([main]);
  });

  it("restores closing every tab", () => {
    const { project, main } = setup();
    mount(project, "p").close(main);
    const { tabs, openFileId } = mount(project, "p").getSnapshot();
    expect(tabs).toEqual([]);
    expect(openFileId).toBeNull();
  });

  it("drops tabs of files deleted since", () => {
    const { project, main, a, b } = setup();
    saveOpenTabs("p", { tabs: [main, a, b], open: a });
    deleteNode(project, a);
    const { tabs, openFileId } = mount(project, "p").getSnapshot();
    expect(tabs).toEqual([main, b]);
    expect(openFileId).toBe(main);
  });

  it("falls back to the main file when every saved tab is gone", () => {
    const { project, main, a } = setup();
    saveOpenTabs("p", { tabs: [a], open: a });
    deleteNode(project, a);
    const { tabs, openFileId } = mount(project, "p").getSnapshot();
    expect(tabs).toEqual([main]);
    expect(openFileId).toBe(main);
  });

  it("ignores stored garbage", () => {
    localStorage.setItem("typstry:tabs:p", JSON.stringify({ tabs: [1] }));
    expect(loadOpenTabs("p")).toBeNull();
    const { project, main } = setup();
    expect(mount(project, "p").getSnapshot().tabs).toEqual([main]);
  });

  describe("with a doc that lags behind the server", () => {
    function lagging() {
      const server = initProject(newProject(1), { title: "T" });
      const main = server.mainFile!;
      const local = fork(server, 2);
      const a = createFile(server, null, "a.typ", "text");
      saveOpenTabs("p", { tabs: [main, a], open: a });
      const catchUp = () =>
        local.doc.import(server.doc.export({ mode: "update" }));
      return { local, main, a, catchUp };
    }

    it("reopens a tab once its file arrives", () => {
      const { local, main, a, catchUp } = lagging();
      const store = mount(local, "p");
      expect(store.getSnapshot().tabs).toEqual([main]);
      // The partial set must not replace what was saved.
      expect(loadOpenTabs("p")?.tabs).toEqual([main, a]);

      catchUp();
      expect(store.getSnapshot().tabs).toEqual([main, a]);
      expect(store.getSnapshot().openFileId).toBe(a);
    });

    it("forgets tabs still missing after the sync", () => {
      const { local, main } = lagging();
      const store = mount(local, "p");
      store.settle();
      expect(loadOpenTabs("p")).toEqual({ tabs: [main], open: main });
    });

    it("stops waiting once tabs are picked by hand", () => {
      const { local, main, catchUp } = lagging();
      const store = mount(local, "p");
      store.close(main);
      catchUp();
      expect(store.getSnapshot().tabs).toEqual([]);
      expect(loadOpenTabs("p")).toEqual({ tabs: [], open: null });
    });
  });
});
