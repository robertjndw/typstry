// Message protocol between compiler-client (main thread) and
// compile.worker.ts. Paths on this boundary are absolute typst paths
// ("/main.typ"); the client maps them to and from project paths.

export type FontAsset = "text" | "cjk" | "emoji";

export interface FontConfig {
  /** Default font bundles shipped with typst.ts, fetched from a CDN. */
  assets: FontAsset[];
  /** Extra fonts: URLs, or raw bytes (uploaded project fonts). */
  extra?: (string | Uint8Array)[];
}

export const DEFAULT_FONTS: FontConfig = { assets: ["text"] };

export type WorkerRequest =
  | { type: "setText"; path: string; text: string }
  | { type: "setAsset"; path: string; data: Uint8Array }
  | { type: "remove"; path: string }
  /**
   * A project package as its stored .tar.gz. `key` is the doc's key
   * ("ns/name/version"); the hash names the content, so a replacement can be
   * told from the archive it supersedes.
   */
  | { type: "setPackage"; key: string; hash: string; data: Uint8Array }
  | { type: "removePackage"; key: string }
  /** Debounced in the worker; only the latest pending request runs. */
  | { type: "compile"; mainPath: string }
  /** One-off PDF compile, answered by a "pdf" response with the same id. */
  | { type: "exportPdf"; id: number; mainPath: string }
  /** Drops a scheduled compile that has not started yet. */
  | { type: "cancel" }
  /** Rebuilds the compiler with a new font set and resends all files. */
  | { type: "reinit"; fonts: FontConfig }
  /** Builds the compiler again with the same fonts, after a failed start. */
  | { type: "restart" }
  /**
   * The client could not use a render (it lacks a page or the defs the
   * worker left out, or the preview failed to load). The worker forgets what
   * it sent and answers with the current document in full, compiling only if
   * the renderer does not hold it yet.
   */
  | { type: "rerender" };

/** A typst source range, 0-based lines and columns in Unicode code points. */
export interface SourceRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export type Severity = "error" | "warning";

export interface WorkerDiagnostic {
  /** Absolute typst path, or "" when typst reports no location. */
  path: string;
  /** Package spec such as "@preview/cetz:0.3.4", or "" for project files. */
  package: string;
  severity: Severity;
  message: string;
  range: SourceRange | null;
}

/**
 * Incremental vector data for the renderer session, which lives in the
 * worker next to the compiler. "reset" carries a full document, "merge" a
 * delta against everything sent since the last reset. The renderer must
 * apply every update in order.
 */
export interface ArtifactUpdate {
  action: "reset" | "merge";
  data: Uint8Array;
}

export interface RenderPage {
  /** Content hash typst.ts assigns to the page; equal tid, equal content. */
  tid: string;
  width: number;
  height: number;
  /**
   * The page's `<g class="typst-page">` markup, or null when the last render
   * sent already had a page with this tid (counted per occurrence).
   */
  markup: string | null;
}

/**
 * A rendered document, minus what the client already holds from the last
 * render the worker sent: unchanged pages and defs never cross the thread
 * boundary again.
 */
export interface RenderPayload {
  /** Opening tag of typst.ts' stacked SVG, needed to parse any fragment. */
  rootTag: string;
  /** Glyph, clip path and style markup, or null when unchanged. */
  defs: string | null;
  pages: RenderPage[];
}

export interface RenderError {
  /** "load": the renderer wasm could not be fetched, usually offline. */
  kind: "load" | "render";
  message: string;
}

export type WorkerResponse =
  | {
      type: "ready";
      /** The extra font bundles could not load; the compiler runs without. */
      fontWarning?: string;
    }
  | { type: "initError"; message: string }
  | { type: "compiling"; id: number }
  | {
      type: "result";
      id: number;
      mainPath: string;
      diagnostics: WorkerDiagnostic[];
      /** Absent when the compile failed; the last good render stays valid. */
      render?: RenderPayload;
      renderError?: RenderError;
      compileMs: number;
      renderMs: number;
    }
  /** The answer to "rerender", when the renderer already held the document. */
  | {
      type: "render";
      mainPath: string;
      render?: RenderPayload;
      renderError?: RenderError;
      renderMs: number;
    }
  | ({ type: "pdf"; id: number } & ({ data: Uint8Array } | { error: string }));

/** The Worker events the client listens to. */
export interface WorkerEvents {
  message: MessageEvent<WorkerResponse>;
  /** An uncaught error in the worker, or its script failing to load. */
  error: Event;
  /** A response that could not be deserialized, and so never arrived. */
  messageerror: MessageEvent;
}

/** Minimal Worker surface, so tests can substitute a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener<K extends keyof WorkerEvents>(
    type: K,
    listener: (event: WorkerEvents[K]) => void,
  ): void;
  removeEventListener<K extends keyof WorkerEvents>(
    type: K,
    listener: (event: WorkerEvents[K]) => void,
  ): void;
  terminate(): void;
}
