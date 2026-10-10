import {
  LSPClient,
  hoverTooltips,
  serverCompletion,
  signatureHelp,
  type Transport,
} from "@codemirror/lsp-client";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ContainerID, TreeID } from "loro-crdt";

import type { ProjectAssets } from "@/assets/project-assets";
import { getText } from "@/doc/fs-ops";
import type { ProjectDoc } from "@/doc/schema";
import {
  projectIndex,
  type ProjectIndex,
  type ProjectIndexChange,
  type ProjectIndexState,
} from "@/project/project-index";
import { RetryQueue } from "@/project/retry";

import { pathCompletion } from "./path-completion";
import type { TinymistRequest, TinymistResponse } from "./protocol";

/** Where the project lives as far as tinymist is concerned. */
const PROJECT_ROOT = "/project";
const PROJECT_ROOT_URI = `file://${PROJECT_ROOT}`;

function projectUri(path: string): string {
  return `${PROJECT_ROOT_URI}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// tinymist's docs are long (the hover on `text` lists every parameter), and
// the client leaves hover tooltips unbounded.
const lspTooltipTheme = EditorView.theme({
  ".cm-lsp-hover-tooltip, .cm-lsp-completion-documentation": {
    maxWidth: "min(40em, 80vw)",
    maxHeight: "20em",
    overflowY: "auto",
    fontSize: "90%",
  },
  ".cm-lsp-documentation pre": { whiteSpace: "pre-wrap" },
  ".cm-completionDetail": {
    display: "inline-block",
    maxWidth: "24em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    verticalAlign: "bottom",
  },
});

/** Long enough for the first request, which waits for wasm and a compile. */
const REQUEST_TIMEOUT_MS = 20_000;
const SYNC_DEBOUNCE_MS = 150;

const encoder = new TextEncoder();

/** The Worker surface used here, so tests can substitute a fake. */
export type TinymistWorker = Pick<
  Worker,
  "postMessage" | "addEventListener" | "removeEventListener" | "terminate"
>;

export interface TinymistClientOptions {
  worker?: TinymistWorker;
}

function workerTransport(worker: TinymistWorker): Transport {
  const handlers = new Map<
    (value: string) => void,
    (event: MessageEvent<TinymistResponse>) => void
  >();
  return {
    send: (message) =>
      worker.postMessage({ type: "lsp", message } satisfies TinymistRequest),
    subscribe(handler) {
      const listener = ({ data }: MessageEvent<TinymistResponse>) => {
        if (data.type === "lsp") handler(data.message);
        else if (data.type === "initError")
          console.error("[tinymist] failed to start:", data.message);
      };
      handlers.set(handler, listener);
      worker.addEventListener("message", listener);
    },
    unsubscribe(handler) {
      const listener = handlers.get(handler);
      if (listener) worker.removeEventListener("message", listener);
      handlers.delete(handler);
    },
  };
}

interface TextFile {
  uri: string;
  container: ContainerID;
}

interface AssetFile {
  path: string;
  hash: string;
  /** The worker asked for it, so later versions are pushed too. */
  requested: boolean;
}

/**
 * Runs tinymist in a worker for one project: completion, hover docs and
 * signature help for the editor. Open files are synced by the LSP client;
 * every other project file is mirrored into the worker, text eagerly and
 * assets once tinymist asks for them.
 */
export class TinymistClient {
  readonly lsp: LSPClient;
  private readonly worker: TinymistWorker;
  private readonly project: ProjectDoc;
  private readonly assets: ProjectAssets | null;
  private readonly index: ProjectIndex;

  private readonly textsById = new Map<TreeID, TextFile>();
  private readonly assetsByUri = new Map<string, AssetFile>();
  private readonly retry = new RetryQueue();
  /**
   * URIs open in an editor, with how many editors show each. The LSP client
   * keeps tinymist up to date on those itself.
   */
  private readonly openUris = new Map<string, number>();
  /** Project paths of every file, for path completion. */
  private paths: string[] = [];
  private readonly dirty = new Set<TreeID>();
  private structural = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while the editor is hidden, see pause(). */
  private paused = false;
  private pinnedMain: string | null = null;
  private readonly unsubscribeIndex: () => void;
  private disposed = false;

  constructor(
    project: ProjectDoc,
    assets: ProjectAssets | null,
    options: TinymistClientOptions = {},
  ) {
    this.project = project;
    this.assets = assets;
    this.worker =
      options.worker ??
      new Worker(new URL("./tinymist.worker.ts", import.meta.url), {
        type: "module",
        name: "tinymist",
      });
    this.worker.addEventListener("message", this.onWorkerMessage);
    this.lsp = new LSPClient({
      rootUri: PROJECT_ROOT_URI,
      timeout: REQUEST_TIMEOUT_MS,
      initializationOptions: {
        // Files come from us (tinymist/fs/watch), not from a disk.
        delegateFsRequests: true,
        compileStatus: "disable",
        exportPdf: "never",
        semanticTokens: "disable",
        projectResolution: "singleFile",
      },
      extensions: [serverCompletion(), hoverTooltips(), signatureHelp()],
    }).connect(workerTransport(this.worker));

    this.index = projectIndex(project);
    this.unsubscribeIndex = this.index.subscribe((change) =>
      this.onIndexChange(change),
    );
    this.syncStructure(this.index.state);
  }

  /** The editor extension for the file at project path `path`. */
  plugin(path: string): Extension {
    // Created once: CodeMirror tracks completion sources by identity, and a
    // fresh function per lookup would leave the completion pending forever.
    const data = [{ autocomplete: pathCompletion(path, () => this.paths) }];
    const uri = projectUri(path);
    return [
      this.lsp.plugin(uri, "typst"),
      ViewPlugin.define(() => {
        this.opened(uri);
        return { destroy: () => this.closed(uri) };
      }),
      EditorState.languageData.of(() => data),
      lspTooltipTheme,
    ];
  }

  /**
   * Stops mirroring edits while no editor of the live project is shown (a
   * version is open in its place). Changes are still tracked and go out on
   * resume().
   */
  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    if (this.structural || this.dirty.size > 0) this.scheduleSync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeIndex();
    this.retry.dispose();
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.worker.removeEventListener("message", this.onWorkerMessage);
    this.lsp.disconnect();
    this.worker.terminate();
  }

  private post(message: TinymistRequest, transfer?: Transferable[]): void {
    if (!this.disposed) this.worker.postMessage(message, transfer ?? []);
  }

  private onWorkerMessage = ({ data }: MessageEvent<TinymistResponse>) => {
    if (data.type !== "needFile") return;
    const asset = this.assetsByUri.get(data.uri);
    if (!asset || asset.requested) return;
    asset.requested = true;
    this.sendAsset(data.uri, asset);
  };

  private opened(uri: string): void {
    this.openUris.set(uri, (this.openUris.get(uri) ?? 0) + 1);
  }

  private closed(uri: string): void {
    const count = (this.openUris.get(uri) ?? 1) - 1;
    if (count > 0) {
      this.openUris.set(uri, count);
      return;
    }
    this.openUris.delete(uri);
    // While the file was open, its edits reached tinymist through the LSP
    // client only, so the mirror is out of date now that tinymist reads it.
    for (const [id, file] of this.textsById) {
      if (file.uri === uri) this.dirty.add(id);
    }
    this.scheduleSync();
  }

  // Edits only resend their file. Anything structural (tree moves, renames,
  // new containers) is reconciled against the shared index on the next sync.
  private onIndexChange(change: ProjectIndexChange): void {
    for (const id of change.edited) this.dirty.add(id);
    if (change.structural) this.structural = true;
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.syncTimer !== null || this.paused || this.disposed) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.structural) this.syncStructure(this.index.state);
      for (const id of this.dirty) {
        const file = this.textsById.get(id);
        if (file && !this.openUris.has(file.uri)) this.sendText(id, file.uri);
      }
      this.dirty.clear();
    }, SYNC_DEBOUNCE_MS);
  }

  private sendText(id: TreeID, uri: string): void {
    let text: string;
    try {
      text = getText(this.project, id).toString();
    } catch {
      return; // deleted meanwhile; the structure sync sends the removal
    }
    const data = encoder.encode(text);
    this.post({ type: "setFile", uri, data }, [data.buffer]);
  }

  private sendAsset(uri: string, asset: AssetFile): void {
    const { hash, path } = asset;
    void this.assets?.load(hash).then(
      (data) => {
        // Replaced or removed while loading.
        if (this.assetsByUri.get(uri) !== asset) return;
        this.retry.succeeded(uri);
        this.post({ type: "setFile", uri, data }, [data.buffer]);
      },
      (err: unknown) => {
        console.error(`failed to load asset ${path}`, err);
        // tinymist asks for a file once, so nobody else would retry it.
        if (this.assetsByUri.get(uri) !== asset) return;
        // Looks up the entry again instead of closing over `asset`: only one
        // retry per URI is pending, so if the asset was replaced and the new
        // version failed too, this retry is the only one left for it.
        this.retry.schedule(uri, () => {
          const current = this.assetsByUri.get(uri);
          if (current?.requested) this.sendAsset(uri, current);
        });
      },
    );
  }

  /** Brings the worker's mirror in line with the index. */
  private syncStructure(state: ProjectIndexState): void {
    this.structural = false;
    const paths: string[] = [];
    for (const entry of state.paths.byId.values())
      if (entry.kind !== "dir") paths.push(entry.path);
    this.paths = paths;

    // Every removal goes out before any write: a file deleted while another
    // moves onto its path, two files swapping paths, or an asset replaced by
    // a text file at the same path would otherwise have the worker drop the
    // file that just arrived.
    const nextAssets = new Map<string, { path: string; hash: string }>();
    for (const { path, hash } of state.assets.values())
      nextAssets.set(projectUri(path), { path, hash });
    for (const [id, file] of this.textsById) {
      const next = state.texts.get(id);
      if (next && projectUri(next.path) === file.uri) continue;
      if (!next) {
        this.textsById.delete(id);
        this.dirty.delete(id);
      }
      this.post({ type: "removeFile", uri: file.uri });
    }
    for (const uri of this.assetsByUri.keys()) {
      if (nextAssets.has(uri)) continue;
      this.assetsByUri.delete(uri);
      this.post({ type: "removeFile", uri });
    }

    for (const [id, file] of state.texts) {
      const uri = projectUri(file.path);
      const prev = this.textsById.get(id);
      if (prev?.uri === uri && prev.container === file.container) continue;
      this.textsById.set(id, { uri, container: file.container });
      this.dirty.delete(id);
      this.sendText(id, uri);
    }
    for (const [uri, { path, hash }] of nextAssets) {
      const prev = this.assetsByUri.get(uri);
      if (prev?.hash === hash) continue;
      const asset = { path, hash, requested: !!prev?.requested };
      this.assetsByUri.set(uri, asset);
      if (asset.requested) this.sendAsset(uri, asset);
    }

    const mainId = state.mainFile;
    const mainPath = mainId ? state.paths.byId.get(mainId)?.path : undefined;
    this.pinMain(mainPath ?? null);
  }

  /**
   * Analyses an included chapter in the context of the main file, so its
   * completions see what main.typ sets up (imports, show rules, labels).
   */
  private pinMain(path: string | null): void {
    if (path === this.pinnedMain) return;
    this.pinnedMain = path;
    void this.lsp.initializing.then(() =>
      this.lsp
        .request("workspace/executeCommand", {
          command: "tinymist.pinMain",
          arguments: [path === null ? null : `${PROJECT_ROOT}/${path}`],
        })
        .catch((err: unknown) =>
          console.warn("[tinymist] pinMain failed", err),
        ),
    );
  }
}
