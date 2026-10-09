import { render } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { LoroDoc, UndoManager } from "loro-crdt";

import { Editor } from "./Editor";

describe("Editor", () => {
  function setup() {
    const doc = new LoroDoc();
    const main = doc.getText("main.typ");
    const other = doc.getText("other.typ");
    main.insert(0, "= Main\n");
    other.insert(0, "= Other\n");
    doc.commit();
    return { doc, main, other, undoManager: new UndoManager(doc, {}) };
  }

  it("mounts a bound view, swaps it per text container and cleans up", () => {
    const { doc, main, other, undoManager } = setup();
    const ready: EditorView[] = [];
    const onReady = (v: EditorView) => ready.push(v);

    const { rerender, unmount, container } = render(
      <Editor
        doc={doc}
        text={main}
        undoManager={undoManager}
        onReady={onReady}
      />,
    );
    expect(ready).toHaveLength(1);
    expect(ready[0]!.state.doc.toString()).toBe("= Main\n");
    expect(container.querySelector(".cm-editor")).not.toBeNull();

    // A fresh wrapper for the same container must not recreate the view.
    rerender(
      <Editor
        doc={doc}
        text={doc.getText("main.typ")}
        onReady={onReady}
        undoManager={undoManager}
      />,
    );
    expect(ready).toHaveLength(1);

    rerender(
      <Editor
        doc={doc}
        text={other}
        undoManager={undoManager}
        onReady={onReady}
      />,
    );
    expect(ready).toHaveLength(2);
    const view = ready[1]!;
    expect(view.state.doc.toString()).toBe("= Other\n");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "text" } });
    expect(other.toString()).toBe("= Other\ntext");
    expect(main.toString()).toBe("= Main\n");

    unmount();
    expect(container.querySelector(".cm-editor")).toBeNull();
    other.insert(0, "x");
    doc.commit();
    expect(view.state.doc.toString()).toBe("= Other\ntext");
  });
});
