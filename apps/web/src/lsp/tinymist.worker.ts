import initTinymist, {
  TinymistLanguageServer,
} from "../../vendor/tinymist/tinymist.js";
import tinymistWasmUrl from "../../vendor/tinymist/tinymist_bg.wasm?url";

import { toBase64 } from "@/crypto/bytes";

import type { TinymistRequest, TinymistResponse } from "./protocol";

// Same hand-typed worker scope as compile.worker.ts.
const scope = self as unknown as {
  postMessage(message: TinymistResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<TinymistRequest>) => void,
  ): void;
};

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function toClient(message: JsonRpcMessage): void {
  scope.postMessage({
    type: "lsp",
    message: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
}

// The project lives on the main thread; this is a mirror. tinymist reads
// files by asking for them (tinymist/fs/watch) and is told about them, and
// about later changes, through tinymist/fsChange.
const files = new Map<string, Uint8Array>();
const watched = new Set<string>();
/** Watched files changed since the last fsChange, sent together per drain. */
const changed = new Set<string>();

function fileChange(uri: string) {
  const data = files.get(uri);
  return {
    uri,
    content: data
      ? { type: "ok", content: toBase64(data) }
      : { type: "err", error: "file not found" },
  };
}

let server: TinymistLanguageServer | null = null;

// The server is a Rust value behind a &mut borrow; calling back into it from
// one of its own callbacks panics ("recursive use of an object"). So every
// call into it goes through this queue and runs on a fresh task.
type Task = (server: TinymistLanguageServer) => void;
const pending: Task[] = [];
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(drain, 0);
}

function enqueue(task: Task): void {
  pending.push(task);
  schedule();
}

function drain(): void {
  scheduled = false;
  if (!server) return;
  if (changed.size > 0) {
    const uris = [...changed];
    changed.clear();
    pending.push((s) => {
      void s.on_request("tinymist/fsChange", {
        inserts: uris.map(fileChange),
        removes: [],
        isSync: true,
      });
    });
  }
  for (const task of pending.splice(0)) {
    try {
      task(server);
    } catch (err) {
      console.error("[tinymist]", err);
    }
  }
}

function markChanged(uri: string): void {
  if (!watched.has(uri)) return;
  changed.add(uri);
  schedule();
}

/**
 * tinymist's wasm binding returns errors in place of results, with nothing
 * to tell them apart, so this goes by the shape of a JSON-RPC error. Revisit
 * if the binding ever rejects or tags its errors.
 */
function isResponseError(value: unknown): value is { code: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "number" &&
    typeof (value as { message?: unknown }).message === "string" &&
    Object.keys(value).length <= 3
  );
}

function respond(id: number | string, value: unknown): void {
  if (isResponseError(value)) toClient({ id, error: value });
  else toClient({ id, result: value ?? null });
}

// Requests tinymist sends to its client. @codemirror/lsp-client only
// handles responses and notifications, so they are answered here.
function onServerRequest(
  method: string,
  params: Record<string, unknown> | undefined,
): unknown {
  switch (method) {
    case "tinymist/fs/watch": {
      for (const uri of (params?.inserts as string[] | undefined) ?? []) {
        watched.add(uri);
        // Answered for missing files too: "not found" until the main thread
        // sends the file, which then counts as a change.
        markChanged(uri);
        if (!files.has(uri)) scope.postMessage({ type: "needFile", uri });
      }
      for (const uri of (params?.removes as string[] | undefined) ?? [])
        watched.delete(uri);
      return null;
    }
    case "workspace/configuration":
      return ((params?.items as unknown[] | undefined) ?? []).map(() => null);
    default:
      return null;
  }
}

// Notifications nobody on the main thread acts on. Diagnostics come from
// the preview compiler, which is the one that matches the rendered output.
const DROPPED_NOTIFICATIONS = new Set([
  "textDocument/publishDiagnostics",
  "$/progress",
]);

async function start(): Promise<void> {
  await initTinymist({ module_or_path: tinymistWasmUrl });
  server = new TinymistLanguageServer({
    sendEvent: (event: number) => enqueue((s) => s.on_event(event)),
    sendRequest: ({
      id,
      method,
      params,
    }: {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    }) => {
      const result = onServerRequest(method, params);
      enqueue((s) => s.on_response({ id, result }));
    },
    sendNotification: ({
      method,
      params,
    }: {
      method: string;
      params?: unknown;
    }) => {
      if (method.startsWith("tinymist/") || DROPPED_NOTIFICATIONS.has(method))
        return;
      toClient({ method, params });
    },
    // No packages yet. Resolving one means downloading and unpacking it
    // synchronously, which we don't do.
    resolveFn: () => undefined,
  });
  drain();
}

function onClientMessage(raw: string): void {
  const message = JSON.parse(raw) as JsonRpcMessage;
  const { id, method } = message;
  if (method === undefined) return; // a response; we never send requests up
  enqueue((s) => {
    if (id === undefined) {
      s.on_notification(method, message.params ?? null);
      return;
    }
    const result: unknown = s.on_request(method, message.params ?? null);
    if (result instanceof Promise)
      result.then(
        (value) => respond(id, value),
        (err: unknown) =>
          toClient({ id, error: { code: -32603, message: String(err) } }),
      );
    else respond(id, result);
  });
}

scope.addEventListener("message", ({ data }) => {
  if (data.type === "lsp") {
    onClientMessage(data.message);
    return;
  }
  if (data.type === "setFile") files.set(data.uri, data.data);
  else files.delete(data.uri);
  markChanged(data.uri);
});

start().catch((err: unknown) => {
  scope.postMessage({
    type: "initError",
    message: err instanceof Error ? err.message : String(err),
  });
});
