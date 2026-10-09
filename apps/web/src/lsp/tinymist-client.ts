import {
  LSPClient,
  hoverTooltips,
  serverCompletion,
  signatureHelp,
  type Transport,
} from "@codemirror/lsp-client";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ContainerID, LoroEventBatch, TreeID } from "loro-crdt";

import type { ProjectAssets } from "@/assets/project-assets";
import { getText } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { NODE, type ProjectDoc } from "@/doc/schema";

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

function workerTransport(worker: Worker): Transport {
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
  private readonly worker: Worker;
  private readonly project: ProjectDoc;
  private readonly assets: ProjectAssets | null;

  private readonly textsById = new Map<TreeID, TextFile>();
  private readonly idByContainer = new Map<ContainerID, TreeID>();
  private readonly assetsByUri = new Map<string, AssetFile>();
  /** Project paths of every file, for path completion. */
  private paths: string[] = [];
  private readonly dirty = new Set<TreeID>();
  private structural = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private pinnedMain: string | null = null;
  private readonly unsubscribeDoc: () => void;
  private disposed = false;

  constructor(project: ProjectDoc, assets: ProjectAssets | null) {
    this.project = project;
    this.assets = assets;
    this.worker = new Worker(new URL("./tinymist.worker.ts", import.meta.url), {
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

    this.unsubscribeDoc = project.doc.subscribe((batch) =>
      this.onDocEvent(batch),
    );
    this.syncStructure();
  }

  /** The editor extension for the file at project path `path`. */
  plugin(path: string): Extension {
    // Created once: CodeMirror tracks completion sources by identity, and a
    // fresh function per lookup would leave the completion pending forever.
    const data = [{ autocomplete: pathCompletion(path, () => this.paths) }];
    return [
      this.lsp.plugin(projectUri(path), "typst"),
      EditorState.languageData.of(() => data),
      lspTooltipTheme,
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeDoc();
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

  // Same split as CompilerClient.onDocEvent: an edit only resends its file,
  // anything else (tree moves, renames, new containers) rescans the project.
  private onDocEvent(batch: LoroEventBatch): void {
    for (const event of batch.events) {
      const id =
        event.diff.type === "text"
          ? this.idByContainer.get(event.target)
          : undefined;
      if (id !== undefined) this.dirty.add(id);
      else this.structural = true;
    }
    if (this.syncTimer !== null) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.structural) this.syncStructure();
      for (const id of this.dirty) {
        const file = this.textsById.get(id);
        if (file) this.sendText(id, file.uri);
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
    this.post({ type: "setFile", uri, data: encoder.encode(text) });
  }

  private sendAsset(uri: string, asset: AssetFile): void {
    const { hash, path } = asset;
    void this.assets?.load(hash).then(
      (data) => {
        // Replaced or removed while loading.
        if (this.assetsByUri.get(uri)?.hash !== hash) return;
        this.post({ type: "setFile", uri, data }, [data.buffer]);
      },
      (err: unknown) => console.error(`failed to load asset ${path}`, err),
    );
  }

  /** Recomputes paths and sends the worker the difference. */
  private syncStructure(): void {
    this.structural = false;
    const index = buildPathIndex(this.project);
    const paths: string[] = [];
    const seenTexts = new Set<TreeID>();
    const seenAssets = new Set<string>();
    for (const [id, entry] of index.byId) {
      if (entry.kind === "dir") continue;
      paths.push(entry.path);
      const uri = projectUri(entry.path);
      if (entry.kind === "text") {
        let container: ContainerID;
        try {
          container = getText(this.project, id).id;
        } catch {
          continue; // content container not arrived yet
        }
        seenTexts.add(id);
        const prev = this.textsById.get(id);
        if (prev?.uri === uri && prev.container === container) continue;
        if (prev) {
          this.idByContainer.delete(prev.container);
          if (prev.uri !== uri)
            this.post({ type: "removeFile", uri: prev.uri });
        }
        this.textsById.set(id, { uri, container });
        this.idByContainer.set(container, id);
        this.dirty.delete(id);
        this.sendText(id, uri);
      } else {
        const hash: unknown = this.project.fs
          .getNodeByID(id)
          ?.data.get(NODE.hash);
        if (typeof hash !== "string") continue;
        seenAssets.add(uri);
        const prev = this.assetsByUri.get(uri);
        if (prev?.hash === hash) continue;
        const asset = { path: entry.path, hash, requested: !!prev?.requested };
        this.assetsByUri.set(uri, asset);
        if (asset.requested) this.sendAsset(uri, asset);
      }
    }
    this.paths = paths;
    for (const [id, file] of this.textsById) {
      if (seenTexts.has(id)) continue;
      this.textsById.delete(id);
      this.idByContainer.delete(file.container);
      this.dirty.delete(id);
      this.post({ type: "removeFile", uri: file.uri });
    }
    for (const uri of this.assetsByUri.keys()) {
      if (seenAssets.has(uri)) continue;
      this.assetsByUri.delete(uri);
      this.post({ type: "removeFile", uri });
    }

    const mainId = this.project.mainFile;
    const mainPath = mainId ? index.byId.get(mainId)?.path : undefined;
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
