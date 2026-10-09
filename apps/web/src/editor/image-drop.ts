import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LoroDoc, LoroText } from "loro-crdt";

import { fileCategory } from "@/assets/file-types";

export interface ImageDropOptions {
  doc: LoroDoc;
  text: LoroText;
  /**
   * Adds the files to the project and resolves to the paths to reference
   * them by, relative to the edited file. Files that failed are left out.
   */
  upload: (files: File[]) => Promise<string[]>;
}

function imagesOf(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter(
    (file) => fileCategory(file.name, file.type) === "image",
  );
}

/** Typst markup that shows the image at `path`. */
export function imageMarkup(path: string): string {
  // Names cannot contain control characters (see validateName), so JSON's
  // escapes are all ones Typst understands too.
  return `#image(${JSON.stringify(path)})`;
}

/**
 * Pasting or dropping images uploads them and inserts `#image(...)` where
 * they landed. Anything else (text, other files) keeps the default handling.
 */
export function imageDrop({ doc, text, upload }: ImageDropOptions): Extension {
  async function insertAfterUpload(files: File[], pos: number) {
    // The upload takes a while and collaborators keep typing meanwhile, so
    // the spot is tracked as a CRDT cursor rather than an offset.
    const cursor = text.getCursor(pos);
    const paths = await upload(files);
    if (paths.length === 0) return;
    const at = (cursor && doc.getCursorPos(cursor)?.offset) ?? pos;
    text.insert(Math.min(at, text.length), paths.map(imageMarkup).join("\n"));
    doc.commit();
  }

  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = imagesOf(event.clipboardData);
      if (files.length === 0) return false;
      event.preventDefault();
      void insertAfterUpload(files, view.state.selection.main.head);
      return true;
    },
    drop(event, view) {
      const files = imagesOf(event.dataTransfer);
      if (files.length === 0) return false;
      event.preventDefault();
      const pos =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
        view.state.selection.main.head;
      void insertAfterUpload(files, pos);
      return true;
    },
  });
}
