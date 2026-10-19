import {
  createTypstRenderer,
  type RenderSession,
} from "@myriaddreamin/typst.ts/renderer";
import rendererWasmUrl from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url";

import type { ArtifactUpdate } from "./protocol";
import { wasmModuleRef } from "./wasm-module";

/** What the worker's RenderHost needs from a renderer; tests substitute a fake. */
export interface PreviewRenderer {
  /** Applies an update; throws if a merge does not fit the session state. */
  apply(update: ArtifactUpdate): void;
  /** Full SVG for the current document, without the typst.ts script. */
  renderSvg(): Promise<string>;
  dispose(): void;
}

/**
 * Renders in the compile worker. The incremental server ships vector
 * deltas, and the session here merges them. SVG generation itself is cheap,
 * but the string is big (embedded images are base64-encoded on every
 * render), so it stays in the worker: render-state.ts splits it into pages
 * and sends the main thread only the ones that changed.
 *
 * typst.ts also has an in-place DOM patcher (renderToSvg / render_svg), but
 * it owns the container's markup and lays all pages out as one stacked SVG,
 * which rules out per-page layout, gaps and lazy painting. The string path
 * is simpler and fast enough.
 */
export async function createPreviewRenderer(): Promise<PreviewRenderer> {
  const renderer = createTypstRenderer();
  await renderer.init({ getModule: () => wasmModuleRef(rendererWasmUrl) });

  // runWithSession frees the session when the callback settles; park it so
  // the session lives as long as this renderer.
  let release!: () => void;
  const session = await new Promise<RenderSession>((resolve) => {
    void renderer.runWithSession(
      (s) =>
        new Promise<void>((done) => {
          release = done;
          resolve(s);
        }),
    );
  });

  let hasDocument = false;
  return {
    apply(update) {
      if (update.action === "merge" && !hasDocument) {
        throw new Error("merge before reset");
      }
      session.manipulateData({ action: update.action, data: update.data });
      hasDocument = true;
    },
    renderSvg() {
      return renderer.renderSvg({
        renderSession: session,
        data_selection: { body: true, defs: true, css: true, js: false },
      });
    },
    dispose() {
      release();
    },
  };
}
