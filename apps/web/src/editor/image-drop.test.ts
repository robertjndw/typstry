import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { getText } from "@/doc/fs-ops";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { imageDrop, imageMarkup } from "./image-drop";

function pasteEvent(files: File[]): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { files, getData: () => "" },
  });
  return event;
}

function setup(upload: (files: File[]) => Promise<string[]>) {
  const project = initProject(newProject(1), { title: "T" });
  const text = getText(project, project.mainFile!);
  text.delete(0, text.length);
  text.insert(0, "before after");
  project.doc.commit();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text.toString(),
      selection: { anchor: 7 },
      extensions: imageDrop({ doc: project.doc, text, upload }),
    }),
  });
  return { project, text, view };
}

describe("imageDrop", () => {
  it("inserts #image at the paste position once the upload is done", async () => {
    let finish!: (paths: string[]) => void;
    const { project, text, view } = setup(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const event = pasteEvent([new File([], "logo.png", { type: "image/png" })]);
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    // A collaborator types in front of the spot while the upload runs.
    text.insert(0, ">> ");
    project.doc.commit();
    finish(["logo.png"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(text.toString()).toBe('>> before #image("logo.png")after');
    view.destroy();
  });

  it("leaves pastes without images to the default handling", () => {
    const upload = vi.fn(async () => []);
    const { view } = setup(upload);
    view.contentDOM.dispatchEvent(pasteEvent([new File([], "notes.txt")]));
    expect(upload).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe("imageMarkup", () => {
  it("quotes paths as Typst strings", () => {
    expect(imageMarkup('a "b".png')).toBe('#image("a \\"b\\".png")');
  });
});
