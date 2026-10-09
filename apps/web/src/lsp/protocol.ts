// Message protocol between tinymist-client (main thread) and
// tinymist.worker.ts. LSP traffic is passed through as JSON strings, the
// shape @codemirror/lsp-client sends and expects.

export type TinymistRequest =
  | { type: "lsp"; message: string }
  /** Project file contents, served when tinymist asks for a file. */
  | { type: "setFile"; uri: string; data: Uint8Array }
  | { type: "removeFile"; uri: string };

export type TinymistResponse =
  | { type: "lsp"; message: string }
  | { type: "initError"; message: string }
  /**
   * tinymist wants a file the worker does not have. Assets are only sent on
   * request, since most of them never matter for completion or hover.
   */
  | { type: "needFile"; uri: string };
