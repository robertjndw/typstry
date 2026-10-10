import type { TreeID } from "loro-crdt";

import { getText } from "@/doc/fs-ops";
import { extensionOf } from "@/doc/names";
import type { ProjectDoc } from "@/doc/schema";
import {
  projectIndex,
  type IndexedText,
  type ProjectIndex,
  type ProjectIndexChange,
  type ProjectIndexState,
} from "@/project/project-index";
import { RetryQueue } from "@/project/retry";

import { toProjectDiagnostic, type ProjectDiagnostic } from "./diagnostics";
import {
  DEFAULT_FONTS,
  type FontConfig,
  type WorkerLike,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { createPreviewRenderer, type PreviewRenderer } from "./renderer";
import { splitSvgPages, type PreviewDocument } from "./svg-pages";

export type PreviewStatus = "starting" | "idle" | "compiling" | "error";

export interface PreviewState {
  /**
   * "error" means the last compile failed (see diagnostics) or the compiler
   * could not start (see `error`); `document` still holds the last good
   * render in that case.
   */
  status: PreviewStatus;
  /** Project path of the main file, or null when there is nothing to compile. */
  mainPath: string | null;
  diagnostics: ProjectDiagnostic[];
  /** Worker-side compile time of the last finished compile. */
  compileMs: number | null;
  /** Compile plus render time, from compile start to the DOM-ready pages. */
  totalMs: number | null;
  document: PreviewDocument | null;
  /** Compiler startup or rendering failure, as opposed to Typst errors. */
  error: string | null;
}

/**
 * Resolves an asset's bytes by content hash, normally `ProjectAssets.load`
 * from assets/project-assets.ts. Without a loader, asset files are not
 * mirrored and uploaded fonts are not loaded. Each call must return a fresh
 * buffer: asset and font bytes are transferred to the worker, which detaches
 * them.
 */
export type AssetLoader = (hash: string, path: string) => Promise<Uint8Array>;

export interface CompilerClientOptions {
  worker?: WorkerLike;
  createRenderer?: () => Promise<PreviewRenderer>;
  assetLoader?: AssetLoader;
}

/** Coalesces bursts of text events per file before sending them. */
const TEXT_DEBOUNCE_MS = 16;

/**
 * Stands in for the hash of an asset whose load failed: it never matches a
 * real hash, so the next sync loads it again, and the path stays tracked so
 * that removing the file still clears whatever older version the worker has.
 */
const FAILED_LOAD = "";

// Formats Typst can parse. Uploaded WOFF/WOFF2 files stay plain assets;
// the compiler would silently ignore them as fonts.
const FONT_EXTENSIONS = new Set(["ttf", "otf", "ttc", "otc"]);

export function isCompilerFont(path: string): boolean {
  return FONT_EXTENSIONS.has(extensionOf(path));
}

function typstPath(path: string): string {
  return "/" + path;
}

export function createCompileWorker(): WorkerLike {
  return new Worker(new URL("./compile.worker.ts", import.meta.url), {
    type: "module",
    name: "typst-compiler",
  }) as WorkerLike;
}

/**
 * Mirrors a ProjectDoc into the compile worker and turns compile results
 * into rendered pages. One instance per open project.
 */
export class CompilerClient {
  private readonly project: ProjectDoc;
  private readonly worker: WorkerLike;
  private readonly ownsWorker: boolean;
  private readonly createRenderer: () => Promise<PreviewRenderer>;
  private readonly assetLoader: AssetLoader | undefined;

  private readonly index: ProjectIndex;
  /** The index state this client has mirrored into the worker. */
  private files: ProjectIndexState;
  /** Asset path -> hash currently mirrored (or being loaded). */
  private readonly assets = new Map<string, string>();
  private readonly retry = new RetryQueue();
  private mainId: TreeID | null = null;
  private baseFonts: FontConfig = DEFAULT_FONTS;
  /**
   * Sorted, comma-joined hashes of the project's font files; null after a
   * failed load so that the next sync retries.
   */
  private fontKey: string | null = "";
  /**
   * Hash -> a path using it, for the current font key. The bytes themselves
   * are not kept here: they are transferred to the worker, and a manual
   * reinit loads them again.
   */
  private fontFiles = new Map<string, string>();
  /** Bumped per font load, so only the latest one posts a reinit. */
  private fontLoad = 0;
  private readonly dirty = new Set<TreeID>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while the preview is hidden, see pause(). */
  private paused = false;

  private state: PreviewState = {
    status: "starting",
    mainPath: null,
    diagnostics: [],
    compileMs: null,
    totalMs: null,
    document: null,
    error: null,
  };
  private readonly listeners = new Set<(state: PreviewState) => void>();
  private renderer: Promise<PreviewRenderer> | null = null;
  /** Set while a resync waits for the browser to come back online. */
  private onlineWait: AbortController | null = null;
  private renderQueue: Promise<void> = Promise.resolve();
  private compileStartedAt = new Map<number, number>();
  private latestCompileId = 0;
  /** The renderer session holds a newer document than `state.document`. */
  private unrendered = false;
  private disposed = false;
  private readonly unsubscribeIndex: () => void;
  private nextPdfId = 1;
  private readonly pdfRequests = new Map<
    number,
    { resolve: (pdf: Uint8Array) => void; reject: (err: Error) => void }
  >();

  constructor(project: ProjectDoc, options: CompilerClientOptions = {}) {
    this.project = project;
    this.ownsWorker = !options.worker;
    this.worker = options.worker ?? createCompileWorker();
    this.createRenderer = options.createRenderer ?? createPreviewRenderer;
    this.assetLoader = options.assetLoader;

    this.worker.addEventListener("message", this.onWorkerMessage);
    this.index = projectIndex(project);
    this.unsubscribeIndex = this.index.subscribe((change) =>
      this.onIndexChange(change),
    );
    const state = this.index.state;
    this.files = state;
    this.syncStructure(state, [], [...state.texts.values()], true);
    // Fetched alongside the compiler instead of on the first result, which
    // narrows the window where a dropped connection leaves no renderer.
    void this.loadRenderer().catch(() => undefined);
  }

  getState = (): PreviewState => this.state;

  subscribe = (listener: (state: PreviewState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Rebuilds the compiler with a different base font set. The project's
   * uploaded fonts are always added on top.
   */
  reinit(fonts: FontConfig): void {
    this.baseFonts = fonts;
    this.loadFonts();
  }

  /**
   * Stops compiling while nobody sees the preview (a version is open in its
   * place). Edits are still tracked and go out on resume().
   */
  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.post({ type: "cancel" });
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    this.flushTexts();
    this.requestCompile();
  }

  /** Loads the project's font files and rebuilds the compiler with them. */
  private loadFonts(): void {
    const load = ++this.fontLoad;
    const loader = this.assetLoader;
    const files = [...this.fontFiles].sort(([a], [b]) => (a < b ? -1 : 1));
    if (!loader) {
      this.postFonts([]);
      return;
    }
    // Async even without font files: a delete and an add in back to back
    // batches then cost one reinit, not two.
    void Promise.all(files.map(([hash, path]) => loader(hash, path))).then(
      (data) => {
        if (load !== this.fontLoad) return;
        this.retry.succeeded("fonts");
        this.postFonts(data);
      },
      (err: unknown) => {
        console.error("failed to load project fonts", err);
        if (load !== this.fontLoad) return;
        this.fontKey = null;
        this.retry.schedule("fonts", () => this.syncAssets(this.files));
      },
    );
  }

  private postFonts(projectFonts: Uint8Array[]): void {
    const fonts: FontConfig = {
      ...this.baseFonts,
      extra: [...(this.baseFonts.extra ?? []), ...projectFonts],
    };
    // Only the freshly loaded project fonts are ours to detach; the base
    // set belongs to the caller of reinit().
    const transfer = new Set<ArrayBuffer>();
    for (const data of projectFonts) {
      if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
        transfer.add(data.buffer as ArrayBuffer);
    }
    this.post({ type: "reinit", fonts }, [...transfer]);
  }

  /** Compiles the main file to a PDF, including edits not yet compiled. */
  exportPdf(): Promise<Uint8Array> {
    if (this.disposed) return Promise.reject(new Error("compiler disposed"));
    const mainPath = this.mainPath();
    if (mainPath === undefined)
      return Promise.reject(new Error("the project has no main file"));
    // Edits still waiting out the debounce would be missing otherwise.
    this.flushTexts();
    const id = this.nextPdfId++;
    return new Promise((resolve, reject) => {
      this.pdfRequests.set(id, { resolve, reject });
      this.post({ type: "exportPdf", id, mainPath: typstPath(mainPath) });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { reject } of this.pdfRequests.values())
      reject(new Error("compiler disposed"));
    this.pdfRequests.clear();
    this.unsubscribeIndex();
    this.retry.dispose();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.worker.removeEventListener("message", this.onWorkerMessage);
    if (this.ownsWorker) this.worker.terminate();
    void this.renderer?.then((r) => r.dispose()).catch(() => undefined);
    this.onlineWait?.abort();
    this.listeners.clear();
  }

  private loadRenderer(): Promise<PreviewRenderer> {
    if (!this.renderer) {
      const loading = this.createRenderer();
      this.renderer = loading;
      // Usually a fetch that failed while offline. Keeping the rejected
      // promise would leave the preview broken until a reload.
      loading.catch(() => {
        if (this.renderer === loading) this.renderer = null;
      });
    }
    return this.renderer;
  }

  /**
   * A resync right away would recompile straight into the same failed
   * renderer load, over and over while offline. If a later edit gets the
   * renderer loaded first, its merge fails and resyncs on its own.
   */
  private resyncWhenOnline(): void {
    if (this.onlineWait) return;
    const wait = new AbortController();
    this.onlineWait = wait;
    window.addEventListener(
      "online",
      () => {
        this.onlineWait = null;
        this.post({ type: "resync" });
      },
      { once: true, signal: wait.signal },
    );
  }

  private post(message: WorkerRequest, transfer?: Transferable[]): void {
    if (!this.disposed) this.worker.postMessage(message, transfer);
  }

  private setState(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private onIndexChange(change: ProjectIndexChange): void {
    let edited = false;
    for (const id of change.edited) {
      if (!this.files.texts.has(id)) continue;
      this.dirty.add(id);
      edited = true;
    }
    if (change.structural) {
      this.files = change.state;
      this.syncStructure(
        change.state,
        change.textsRemoved,
        change.textsAdded,
        change.assetsRemoved.length > 0 || change.assetsAdded.length > 0,
      );
    }
    if (edited) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.paused) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTexts();
      this.requestCompile();
    }, TEXT_DEBOUNCE_MS);
  }

  private flushTexts(): void {
    for (const id of this.dirty) {
      const file = this.files.texts.get(id);
      if (file) this.sendText(file);
    }
    this.dirty.clear();
  }

  private sendText(file: IndexedText): void {
    let text: string;
    try {
      text = getText(this.project, file.id).toString();
    } catch {
      return; // deleted meanwhile; the structure sync sends the removal
    }
    this.post({ type: "setText", path: typstPath(file.path), text });
  }

  /** Sends the worker what a structural change did to the files. */
  private syncStructure(
    state: ProjectIndexState,
    textsRemoved: readonly IndexedText[],
    textsAdded: readonly IndexedText[],
    assetsChanged: boolean,
  ): void {
    let changed = textsRemoved.length > 0 || textsAdded.length > 0;

    // One batch can hand a path from one file to another (a swap, or a
    // delete plus a rename onto the freed name). Every remove has to reach
    // the worker before any new content, or it would wipe the new owner.
    for (const old of textsRemoved) {
      this.dirty.delete(old.id);
      // A new container under the same path is just new content.
      if (state.texts.get(old.id)?.path !== old.path)
        this.post({ type: "remove", path: typstPath(old.path) });
    }
    // Asset removes go out in here too, still ahead of the texts below.
    if (assetsChanged && this.syncAssets(state)) changed = true;
    for (const file of textsAdded) {
      this.dirty.delete(file.id);
      this.sendText(file);
    }

    const main = state.mainFile;
    const mainId = main !== null && state.texts.has(main) ? main : null;
    if (mainId !== this.mainId) {
      this.mainId = mainId;
      changed = true;
    }
    if (changed) this.requestCompile();
  }

  private syncAssets(state: ProjectIndexState): boolean {
    if (!this.assetLoader || this.disposed) return false;
    const loader = this.assetLoader;
    let changed = false;
    const fonts = new Map<string, string>(); // hash -> a path using it
    for (const { path, hash } of state.assets.values()) {
      if (isCompilerFont(path)) fonts.set(hash, path);
      if (this.assets.get(path) === hash) continue;
      this.assets.set(path, hash);
      void loader(hash, path).then(
        (data) => {
          // The file may have been replaced or removed while loading.
          if (this.assets.get(path) !== hash) return;
          this.retry.succeeded(`asset:${path}`);
          this.post({ type: "setAsset", path: typstPath(path), data }, [
            data.buffer,
          ]);
          this.requestCompile();
        },
        (err: unknown) => {
          console.error(`failed to load asset ${path}`, err);
          if (this.assets.get(path) !== hash) return;
          this.assets.set(path, FAILED_LOAD);
          this.retry.schedule(`asset:${path}`, () => {
            if (this.syncAssets(this.files)) this.requestCompile();
          });
        },
      );
    }
    for (const path of [...this.assets.keys()]) {
      if (state.assets.has(path)) continue;
      this.assets.delete(path);
      this.post({ type: "remove", path: typstPath(path) });
      changed = true;
    }
    this.syncFonts(fonts);
    return changed;
  }

  /**
   * Typst only reads fonts when the compiler is built, so a different set
   * of font files (by content, not by path) means a reinit. Renames and
   * moves keep the key and cost nothing.
   */
  private syncFonts(fonts: Map<string, string>): void {
    const key = [...fonts.keys()].sort().join(",");
    if (key === this.fontKey) return;
    this.fontKey = key;
    this.fontFiles = fonts;
    this.loadFonts();
  }

  /** Project path of the main file, if it is a mirrored text file. */
  private mainPath(): string | undefined {
    return this.mainId !== null
      ? this.files.texts.get(this.mainId)?.path
      : undefined;
  }

  private requestCompile(): void {
    // resume() compiles whatever is current by then.
    if (this.paused) return;
    const mainPath = this.mainPath();
    if (mainPath === undefined) {
      this.post({ type: "cancel" });
      if (this.state.mainPath !== null || this.state.document !== null) {
        this.setState({
          status: "idle",
          mainPath: null,
          diagnostics: [],
          document: null,
        });
      }
      return;
    }
    if (this.state.mainPath !== mainPath) this.setState({ mainPath });
    this.post({ type: "compile", mainPath: typstPath(mainPath) });
  }

  private readonly onWorkerMessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    switch (msg.type) {
      case "ready":
        if (this.state.status === "starting") this.setState({ status: "idle" });
        if (this.state.error) this.setState({ error: null });
        break;
      case "initError":
        this.setState({ status: "error", error: msg.message });
        break;
      case "compiling":
        this.latestCompileId = msg.id;
        this.compileStartedAt.set(msg.id, performance.now());
        this.setState({ status: "compiling" });
        break;
      case "result":
        this.handleResult(msg);
        break;
      case "pdf": {
        const request = this.pdfRequests.get(msg.id);
        this.pdfRequests.delete(msg.id);
        if ("data" in msg) request?.resolve(msg.data);
        else request?.reject(new Error(msg.error));
        break;
      }
    }
  };

  private handleResult(msg: Extract<WorkerResponse, { type: "result" }>): void {
    const startedAt = this.compileStartedAt.get(msg.id);
    this.compileStartedAt.delete(msg.id);
    const fresh = msg.diagnostics.map(toProjectDiagnostic);
    // Most compiles while typing report the same diagnostics again. Keeping
    // the old array lets the editor skip re-applying its lint state.
    const diagnostics =
      JSON.stringify(fresh) === JSON.stringify(this.state.diagnostics)
        ? this.state.diagnostics
        : fresh;
    const failed = diagnostics.some((d) => d.severity === "error");
    // Renders apply in order: every update, even a stale one, has to reach
    // the renderer session, because later deltas build on it.
    this.renderQueue = this.renderQueue.then(async () => {
      let document = this.state.document;
      let error: string | null = null;
      const last = msg.id === this.latestCompileId;
      let loadFailed = false;
      try {
        if (msg.update) {
          const renderer = await this.loadRenderer().catch((err: unknown) => {
            loadFailed = true;
            throw err;
          });
          renderer.apply(msg.update);
          this.unrendered = true;
        }
        // SVG work is skipped while a newer compile is already running. If
        // that one fails, its result still lands here and renders this state.
        if (last && this.unrendered && this.renderer) {
          const svg = await (await this.renderer).renderSvg();
          document = splitSvgPages(svg, document);
          this.unrendered = false;
        }
      } catch (err) {
        console.error("preview render failed", err);
        if (loadFailed) {
          error =
            "Could not load the preview. It retries once the connection is back.";
          this.resyncWhenOnline();
        } else {
          error = `Rendering failed: ${String(err)}`;
          this.post({ type: "resync" });
        }
      }
      if (this.disposed) return;
      // The main file may have gone away while this compile ran.
      if (this.state.mainPath === null) return;
      this.setState({
        status: last ? (failed || error ? "error" : "idle") : "compiling",
        diagnostics,
        compileMs: msg.compileMs,
        totalMs: startedAt !== undefined ? performance.now() - startedAt : null,
        document,
        error,
      });
    });
  }
}
