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
   * The renderer lost track of the incremental stream (e.g. a merge failed);
   * the next result must be a full "reset" update.
   */
  | { type: "resync" };

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
 * Incremental vector data for the renderer session. "reset" carries a full
 * document, "merge" a delta against everything sent since the last reset.
 * The renderer must apply every update in order.
 */
export interface ArtifactUpdate {
  action: "reset" | "merge";
  data: Uint8Array;
}

export type WorkerResponse =
  | { type: "ready" }
  | { type: "initError"; message: string }
  | { type: "compiling"; id: number }
  | {
      type: "result";
      id: number;
      mainPath: string;
      diagnostics: WorkerDiagnostic[];
      /** Absent when the compile failed; the last good render stays valid. */
      update?: ArtifactUpdate;
      compileMs: number;
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
