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
import { toast } from "sonner";

import type { ProjectAssets } from "@/assets/project-assets";
import { getText } from "@/doc/fs-ops";
import type { PackageRecord, ProjectDoc } from "@/doc/schema";
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
  },
  ".cm-lsp-documentation pre": { whiteSpace: "pre-wrap" },
});

/** Long enough for the first request, which waits for wasm and a compile. */
const REQUEST_TIMEOUT_MS = 20_000;
const SYNC_DEBOUNCE_MS = 150;
/** Lets a burst of package changes (an upload of several) settle first. */
const PACKAGE_RESTART_DEBOUNCE_MS = 1_000;

const encoder = new TextEncoder();

/** The Worker surface used here, so tests can substitute a fake. */
export type TinymistWorker = Pick<
  Worker,
  "postMessage" | "addEventListener" | "removeEventListener" | "terminate"
>;

export interface TinymistClientOptions {
  /** A worker owned by the caller; the client does not replace it. */
  worker?: TinymistWorker;
  /** Creates (and recreates, once, after a failure) the client's worker. */
  createWorker?: () => TinymistWorker;
}

function createTinymistWorker(): TinymistWorker {
  return new Worker(new URL("./tinymist.worker.ts", import.meta.url), {
    type: "module",
    name: "tinymist",
  });
}

function workerTransport(
  worker: TinymistWorker,
  onInitError: (message: string) => void,
): Transport {
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
        else if (data.type === "initError") onInitError(data.message);
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

interface PackageEntry {
  record: PackageRecord;
}

/**
 * Runs tinymist in a worker for one project: completion, hover docs and
 * signature help for the editor. Open files are synced by the LSP client;
 * every other project file is mirrored into the worker, text eagerly and
 * assets once tinymist asks for them.
 */
export class TinymistClient {
  readonly lsp: LSPClient;
  private worker: TinymistWorker;
  /** Null for a caller-owned worker. */
  private readonly spawnWorker: (() => TinymistWorker) | null;
  /** The worker was replaced once already; the next failure is final. */
  private restarted = false;
  private failed = false;
  private readonly project: ProjectDoc;
  private readonly assets: ProjectAssets | null;
  private readonly index: ProjectIndex;

  private readonly textsById = new Map<TreeID, TextFile>();
  private readonly assetsByUri = new Map<string, AssetFile>();
  private readonly packagesByKey = new Map<string, PackageEntry>();
  private packageRestartTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.spawnWorker = options.worker
      ? null
      : (options.createWorker ?? createTinymistWorker);
    this.worker = options.worker ?? this.spawnWorker!();
    this.attach(this.worker);
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
    }).connect(this.transport());

    this.index = projectIndex(project);
    this.unsubscribeIndex = this.index.subscribe((change) =>
      this.onIndexChange(change),
    );
    this.syncStructure(this.index.state, true);
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
    if (this.packageRestartTimer !== null)
      clearTimeout(this.packageRestartTimer);
    this.detach(this.worker);
    this.lsp.disconnect();
    this.worker.terminate();
  }

  private transport(): Transport {
    return workerTransport(this.worker, (message) =>
      this.onFailure(`failed to start: ${message}`),
    );
  }

  private attach(worker: TinymistWorker): void {
    worker.addEventListener("message", this.onWorkerMessage);
    worker.addEventListener("error", this.onWorkerError);
  }

  private detach(worker: TinymistWorker): void {
    worker.removeEventListener("message", this.onWorkerMessage);
    worker.removeEventListener("error", this.onWorkerError);
  }

  private readonly onWorkerError = (event: Event) => {
    this.onFailure(event instanceof ErrorEvent ? event.message : "crashed");
  };

  /**
   * One fresh worker covers a crash or a start that hit a flaky
   * connection. A second failure is likely to repeat, and the editor works
   * fine without completion, so it just says so.
   */
  private onFailure(reason: string): void {
    if (this.disposed || this.failed) return;
    console.error(`[tinymist] ${reason}`);
    if (this.spawnWorker && !this.restarted) {
      this.restarted = true;
      this.replaceWorker(this.spawnWorker);
      return;
    }
    this.detach(this.worker);
    this.lsp.disconnect();
    this.worker.terminate();
    this.failed = true;
    toast.warning("Language features are unavailable", {
      id: "tinymist-unavailable",
      description:
        "Completion and hover docs could not start. Editing and the preview still work; reload the page to try again.",
    });
  }

  private replaceWorker(spawn: () => TinymistWorker): void {
    if (this.packageRestartTimer !== null)
      clearTimeout(this.packageRestartTimer);
    this.packageRestartTimer = null;
    this.detach(this.worker);
    this.lsp.disconnect();
    this.worker.terminate();
    this.worker = spawn();
    this.attach(this.worker);
    // The new worker knows no files; mirror everything again. Assets wait
    // for tinymist to ask, as before.
    this.textsById.clear();
    this.assetsByUri.clear();
    this.packagesByKey.clear();
    this.dirty.clear();
    this.pinnedMain = null;
    this.syncStructure(this.index.state, true);
    // Reconnecting also reopens the files shown in editors.
    this.lsp.connect(this.transport());
  }

  /**
   * tinymist remembers what a package resolved to (or that it was missing)
   * for the life of the server, so a changed package set needs a new one.
   * Unlike a failure restart this does not use up the one-shot budget.
   * A caller-owned worker is left alone: the client has no way to make
   * another.
   */
  private schedulePackageRestart(): void {
    if (!this.spawnWorker || this.packageRestartTimer !== null) return;
    this.packageRestartTimer = setTimeout(() => {
      this.packageRestartTimer = null;
      if (this.disposed || this.failed || !this.spawnWorker) return;
      this.replaceWorker(this.spawnWorker);
    }, PACKAGE_RESTART_DEBOUNCE_MS);
  }

  private post(message: TinymistRequest, transfer?: Transferable[]): void {
    if (!this.disposed && !this.failed)
      this.worker.postMessage(message, transfer ?? []);
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

  /**
   * Brings the worker's mirror in line with the index. `fresh` is for a
   * worker that has been sent nothing yet.
   */
  private syncStructure(state: ProjectIndexState, fresh = false): void {
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

    this.syncPackages(state, fresh);

    const mainId = state.mainFile;
    const mainPath = mainId ? state.paths.byId.get(mainId)?.path : undefined;
    this.pinMain(mainPath ?? null);
  }

  /**
   * Project packages go to the worker up front: tinymist resolves a package
   * synchronously, so there is no time to ask for the archive when an import
   * is first seen. `fresh` is the first send to a worker, which needs no
   * restart because it has not resolved anything yet.
   */
  private syncPackages(state: ProjectIndexState, fresh: boolean): void {
    for (const [key, entry] of this.packagesByKey) {
      const next = state.packages.get(key);
      if (next?.hash === entry.record.hash) continue;
      this.packagesByKey.delete(key);
      this.retry.cancel(`package:${key}`);
      if (!next) {
        this.post({ type: "removePackage", key });
        this.schedulePackageRestart();
      }
    }
    for (const [key, record] of state.packages) {
      if (this.packagesByKey.has(key)) continue;
      const entry = { record };
      this.packagesByKey.set(key, entry);
      this.sendPackage(key, entry, fresh);
    }
  }

  private sendPackage(key: string, entry: PackageEntry, fresh: boolean) {
    const { record } = entry;
    void this.assets?.load(record.hash).then(
      (data) => {
        // Replaced or removed while loading.
        if (this.packagesByKey.get(key) !== entry) return;
        this.retry.succeeded(`package:${key}`);
        this.post({ type: "setPackage", key, hash: record.hash, data }, [
          data.buffer,
        ]);
        if (!fresh) this.schedulePackageRestart();
      },
      (err: unknown) => {
        console.error(`failed to load package ${key}`, err);
        if (this.packagesByKey.get(key) !== entry) return;
        // Whatever imported the package has already failed to resolve it,
        // so a late success needs the restart too.
        this.retry.schedule(`package:${key}`, () => {
          const current = this.packagesByKey.get(key);
          if (current) this.sendPackage(key, current, false);
        });
      },
    );
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
