import type { ContainerID, LoroEventBatch, TreeID } from "loro-crdt";

import { getText } from "@/doc/fs-ops";
import { extensionOf } from "@/doc/names";
import { buildPathIndex } from "@/doc/paths";
import { NODE, type ProjectDoc } from "@/doc/schema";

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
 * buffer: asset bytes are transferred to the worker, which detaches them.
 */
export type AssetLoader = (hash: string, path: string) => Promise<Uint8Array>;

export interface CompilerClientOptions {
  worker?: WorkerLike;
  createRenderer?: () => Promise<PreviewRenderer>;
  assetLoader?: AssetLoader;
}

/** Coalesces bursts of text events per file before sending them. */
const TEXT_DEBOUNCE_MS = 16;

interface TextFile {
  id: TreeID;
  path: string;
  container: ContainerID;
}

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

  private readonly textsById = new Map<TreeID, TextFile>();
  private readonly idByContainer = new Map<ContainerID, TreeID>();
  /** Asset path -> hash currently mirrored (or being loaded). */
  private readonly assets = new Map<string, string>();
  private mainId: TreeID | null = null;
  private baseFonts: FontConfig = DEFAULT_FONTS;
  /**
   * Sorted, comma-joined hashes of the project's font files; null after a
   * failed load so that the next sync retries.
   */
  private fontKey: string | null = "";
  private projectFonts: Uint8Array[] = [];
  private readonly dirty = new Set<TreeID>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

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
  private renderQueue: Promise<void> = Promise.resolve();
  private compileStartedAt = new Map<number, number>();
  private latestCompileId = 0;
  /** The renderer session holds a newer document than `state.document`. */
  private unrendered = false;
  private disposed = false;
  private readonly unsubscribeDoc: () => void;

  constructor(project: ProjectDoc, options: CompilerClientOptions = {}) {
    this.project = project;
    this.ownsWorker = !options.worker;
    this.worker = options.worker ?? createCompileWorker();
    this.createRenderer = options.createRenderer ?? createPreviewRenderer;
    this.assetLoader = options.assetLoader;

    this.worker.addEventListener("message", this.onWorkerMessage);
    this.unsubscribeDoc = project.doc.subscribe((batch) =>
      this.onDocEvent(batch),
    );
    this.syncStructure();
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
    this.postFonts();
  }

  private postFonts(): void {
    const fonts: FontConfig = {
      ...this.baseFonts,
      extra: [...(this.baseFonts.extra ?? []), ...this.projectFonts],
    };
    this.post({ type: "reinit", fonts });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeDoc();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.worker.removeEventListener("message", this.onWorkerMessage);
    if (this.ownsWorker) this.worker.terminate();
    void this.renderer?.then((r) => r.dispose()).catch(() => undefined);
    this.listeners.clear();
  }

  private post(message: WorkerRequest, transfer?: Transferable[]): void {
    if (!this.disposed) this.worker.postMessage(message, transfer);
  }

  private setState(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private onDocEvent(batch: LoroEventBatch): void {
    let structural = false;
    let edited = false;
    for (const event of batch.events) {
      const id =
        event.diff.type === "text"
          ? this.idByContainer.get(event.target)
          : undefined;
      if (id !== undefined) {
        this.dirty.add(id);
        edited = true;
      } else {
        // Tree moves, renames (node metadata maps), new content containers
        // and main file changes all land here. Rebuilding the path index is
        // cheap next to a compile, so there is no finer bookkeeping.
        structural = true;
      }
    }
    if (structural) this.syncStructure();
    if (edited) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTexts();
      this.requestCompile();
    }, TEXT_DEBOUNCE_MS);
  }

  private flushTexts(): void {
    for (const id of this.dirty) {
      const file = this.textsById.get(id);
      if (file) this.sendText(file);
    }
    this.dirty.clear();
  }

  private sendText(file: TextFile): void {
    let text: string;
    try {
      text = getText(this.project, file.id).toString();
    } catch {
      return; // deleted meanwhile; the structure sync sends the removal
    }
    this.post({ type: "setText", path: typstPath(file.path), text });
  }

  /** Recomputes paths and sends the worker the difference. */
  private syncStructure(): void {
    const index = buildPathIndex(this.project);
    let changed = false;

    const seen = new Set<TreeID>();
    for (const [id, entry] of index.byId) {
      if (entry.kind !== "text") continue;
      let container: ContainerID;
      try {
        container = getText(this.project, id).id;
      } catch {
        continue; // a text node whose content container has not arrived yet
      }
      seen.add(id);
      const prev = this.textsById.get(id);
      if (prev && prev.path === entry.path && prev.container === container) {
        continue;
      }
      if (prev && prev.path !== entry.path) {
        this.post({ type: "remove", path: typstPath(prev.path) });
      }
      if (prev) this.idByContainer.delete(prev.container);
      const file = { id, path: entry.path, container };
      this.textsById.set(id, file);
      this.idByContainer.set(container, id);
      this.dirty.delete(id);
      this.sendText(file);
      changed = true;
    }
    for (const [id, file] of this.textsById) {
      if (seen.has(id)) continue;
      this.textsById.delete(id);
      this.idByContainer.delete(file.container);
      this.dirty.delete(id);
      this.post({ type: "remove", path: typstPath(file.path) });
      changed = true;
    }

    if (this.syncAssets(index.byId)) changed = true;

    const main = this.project.mainFile;
    const mainId = main !== null && this.textsById.has(main) ? main : null;
    if (mainId !== this.mainId) {
      this.mainId = mainId;
      changed = true;
    }
    if (changed) this.requestCompile();
  }

  private syncAssets(byId: ReturnType<typeof buildPathIndex>["byId"]): boolean {
    if (!this.assetLoader) return false;
    const loader = this.assetLoader;
    let changed = false;
    const live = new Set<string>();
    const fonts = new Map<string, string>(); // hash -> a path using it
    for (const [id, entry] of byId) {
      if (entry.kind !== "asset") continue;
      const hash: unknown = this.project.fs
        .getNodeByID(id)
        ?.data.get(NODE.hash);
      if (typeof hash !== "string") continue;
      live.add(entry.path);
      if (isCompilerFont(entry.path)) fonts.set(hash, entry.path);
      if (this.assets.get(entry.path) === hash) continue;
      this.assets.set(entry.path, hash);
      const path = entry.path;
      void loader(hash, path).then(
        (data) => {
          // The file may have been replaced or removed while loading.
          if (this.assets.get(path) !== hash) return;
          this.post({ type: "setAsset", path: typstPath(path), data }, [
            data.buffer,
          ]);
          this.requestCompile();
        },
        (err: unknown) => console.error(`failed to load asset ${path}`, err),
      );
    }
    for (const path of [...this.assets.keys()]) {
      if (live.has(path)) continue;
      this.assets.delete(path);
      this.post({ type: "remove", path: typstPath(path) });
      changed = true;
    }
    this.syncFonts(fonts, loader);
    return changed;
  }

  /**
   * Typst only reads fonts when the compiler is built, so a different set
   * of font files (by content, not by path) means a reinit. Renames and
   * moves keep the key and cost nothing.
   */
  private syncFonts(fonts: Map<string, string>, loader: AssetLoader): void {
    const sorted = [...fonts.keys()].sort();
    const key = sorted.join(",");
    if (key === this.fontKey) return;
    this.fontKey = key;
    void Promise.all(sorted.map((hash) => loader(hash, fonts.get(hash)!))).then(
      (data) => {
        if (this.fontKey !== key) return; // superseded while loading
        this.projectFonts = data;
        this.postFonts();
      },
      (err: unknown) => {
        console.error("failed to load project fonts", err);
        if (this.fontKey === key) this.fontKey = null;
      },
    );
  }

  private requestCompile(): void {
    const mainPath =
      this.mainId !== null ? this.textsById.get(this.mainId)?.path : undefined;
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
      try {
        if (msg.update) {
          this.renderer ??= this.createRenderer();
          (await this.renderer).apply(msg.update);
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
        error = `Rendering failed: ${String(err)}`;
        this.post({ type: "resync" });
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
