import { EditorView } from "@codemirror/view";

import { addComment, resolveThread } from "@/doc/comments";
import { createFile, getText } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";
import { CommentsUi } from "@/project/comments-ui";

import {
  commentHighlightRanges,
  commentHighlights,
  commentSelection,
} from "./comment-highlights";
import { createLoroEditorState } from "./loro-binding";

const ADA = { name: "Ada", color: "#3366cc" };
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(options: { composer?: boolean } = {}) {
  const a = initProject(newProject(1), { title: "T", starter: false });
  const file = createFile(a, null, "main.typ", "text", "hello brave world");
  const b = fork(a, 2);
  const text = getText(a, file);
  const ui = new CommentsUi();
  const view = new EditorView({
    parent: document.body,
    state: createLoroEditorState(
      { doc: a.doc, text },
      {
        extensions: [
          commentHighlights({ project: a, text, fileId: file, ui }),
          options.composer ? commentSelection(ui, file, text) : [],
        ],
      },
    ),
  });
  return { a, b, file, ui, view };
}

function comment(project: ProjectDoc, file: ReturnType<typeof setup>["file"]) {
  return addComment(project, {
    fileId: file,
    text: getText(project, file),
    from: 6,
    to: 11,
    body: "Brave?",
    ...ADA,
  });
}

function highlighted(view: EditorView) {
  return commentHighlightRanges(view).map((r) =>
    view.state.doc.sliceString(r.from, r.to),
  );
}

describe("commentHighlights", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("marks open threads and drops them once resolved", async () => {
    const { a, file, view } = setup();
    const id = comment(a, file);
    await flush();
    expect(highlighted(view)).toEqual(["brave"]);
    expect(view.dom.querySelector(".cm-comment")?.textContent).toBe("brave");

    resolveThread(a, id);
    await flush();
    expect(highlighted(view)).toEqual([]);
    view.destroy();
  });

  it("maps through local typing, leaving text at the edges outside", async () => {
    const { a, file, view } = setup();
    comment(a, file);
    await flush();
    const dispatch = vi.spyOn(view, "dispatch");
    view.dispatch({ changes: { from: 11, insert: "!" } });
    view.dispatch({ changes: { from: 6, insert: "[" } });
    view.dispatch({ changes: { from: 9, insert: "X" } });
    expect(highlighted(view)).toEqual(["brXave"]);
    // Mapping was enough; nothing was recomputed.
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(3);
    view.destroy();
  });

  it("shows a comment made by another peer", async () => {
    const { a, b, file, view } = setup();
    await flush();
    expect(highlighted(view)).toEqual([]);
    comment(b, file);
    getText(b, file).insert(0, ">> ");
    b.doc.commit();
    sync(a, b);
    await flush();
    expect(view.state.doc.toString()).toBe(">> hello brave world");
    expect(highlighted(view)).toEqual(["brave"]);
    view.destroy();
  });

  it("marks the active thread and selects one on click", async () => {
    const { a, file, ui, view } = setup();
    const id = comment(a, file);
    await flush();
    expect(commentHighlightRanges(view)[0]!.active).toBe(false);

    const shown = vi.fn();
    ui.onShowPanel(shown);
    view.dom
      .querySelector(".cm-comment")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ui.getState().active).toBe(id);
    expect(shown).toHaveBeenCalledWith(false);
    await flush();
    expect(commentHighlightRanges(view)[0]!.active).toBe(true);
    expect(view.dom.querySelector(".cm-comment-active")).not.toBeNull();
    view.destroy();
  });
});

describe("commentSelection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("drafts from the reported selection", () => {
    const { a, file, ui, view } = setup({ composer: true });
    expect(ui.startDraft()).toBe(false);
    view.dispatch({ selection: { anchor: 6, head: 11 } });

    const shown = vi.fn();
    ui.onShowPanel(shown);
    expect(ui.startDraft()).toBe(true);
    expect(shown).toHaveBeenCalledWith(true);
    const draft = ui.getState().draft!;
    expect(draft).toMatchObject({ fileId: file, quote: "brave" });

    // The draft follows edits made after it was started.
    getText(a, file).insert(0, ">> ");
    a.doc.commit();
    view.dispatch({ selection: { anchor: 0 } });
    expect(ui.getState().draft).toBe(draft);
    view.destroy();
  });

  it("forgets the selection when the editor goes away", () => {
    const { ui, view } = setup({ composer: true });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(ui.hasSelection()).toBe(true);
    view.destroy();
    expect(ui.hasSelection()).toBe(false);
    expect(ui.startDraft()).toBe(false);
  });
});
