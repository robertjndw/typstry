import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { typstLanguage } from "./language";
import { editorBasics } from "./setup";
import { foldMarker } from "./theme";

describe("editor theme", () => {
  it("tags Typst tokens with the classes editor.css colors", async () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: '= Title\n#let x = "s"\n',
        extensions: [editorBasics, typstLanguage],
      }),
    });
    try {
      await vi.waitFor(() => {
        for (const cls of ["tok-heading", "tok-keyword", "tok-string"])
          expect(view.contentDOM.querySelector(`.${cls}`)).not.toBeNull();
      });
    } finally {
      view.destroy();
    }
  });

  it("marks fold state on the gutter marker", () => {
    expect(foldMarker(true).className).toContain("cm-foldMarker-open");
    expect(foldMarker(false).className).toContain("cm-foldMarker-closed");
  });
});
