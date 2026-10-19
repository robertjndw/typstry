import type { TreeID } from "loro-crdt";

import { getText } from "@/doc/fs-ops";
import { extensionOf } from "@/doc/names";
import type { ProjectDoc } from "@/doc/schema";
import { FOLDER_ORIGIN } from "@/folder/origin";
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
  type RenderError,
  type RenderPayload,
  type WorkerEvents,
  type WorkerLike,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import {
  buildPreviewDocument,
  type PageChange,
  type PreviewDocument,
} from "./svg-pages";

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
  /** Compile, render and parse time, from compile start to the DOM-ready pages. */
  totalMs: number | null;
  document: PreviewDocument | null;
  /**
   * Compiler startup, crash or rendering failure, as opposed to Typst
   * errors. CompilerClient.retry() tries again.
   */
  error: string | null;
  /**
   * The worker owes a compile or PDF and has been silent for a while. A
   * package download on a slow connection or a big document legitimately
   * takes that long, so it keeps going; retry() restarts it if it is hung.
   */
  stalled: boolean;
  /**
   * Set when the latest document differs from the previous one in a place
   * the user probably just edited. `seq` grows with every such document, so
   * a consumer can tell a new one from a state update that carries the same
   * value.
   */
  follow: { seq: number; changes: PageChange[] } | null;
  /**
   * How the document that was just shown should animate, set on every shown
   * document so a page swapped later does not replay an old one. Null when
   * nobody edited for the change (a font finishing loading), and for the
   * first document.
   */
  animation: PreviewAnimation | null;
}

/**
 * "typed" is the user's own edit in the editor. "external" is a change they
 * did not type: a collaborator's edit, or the linked folder's.
 */
export type AnimationKind = "typed" | "external";

export interface PreviewAnimation {
  seq: number;
  kind: AnimationKind;
  changes: PageChange[];
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
  /** A worker owned by the caller. The client cannot replace it if it dies. */
  worker?: WorkerLike;
  /** Creates (and recreates, after a crash) the client's own worker. */
  createWorker?: () => WorkerLike;
  assetLoader?: AssetLoader;
}

/**
 * How long the worker may stay silent while a compile or PDF export is
 * running before the preview offers a restart. It is never killed for it:
 * the worker cannot report progress from inside a compile, so a hang looks
 * the same as a slow package download or a long export.
 */
const WATCHDOG_MS = 60_000;

/** Automatic restarts after crashes in a row before the client gives up. */
const MAX_RESTARTS = 3;

/**
 * New or changed errors wait this long after the last local edit before they
 * show. Half-typed syntax (an unclosed bracket) is an error for a moment, and
 * showing it makes the status, the problems panel and the lint underlines
 * flash on every sentence.
 */
const ERROR_SETTLE_MS = 1000;

/**
 * A document change this soon after a local edit is taken to come from it,
 * which covers a compile that only finishes after the next edit began.
 */
const FOLLOW_WINDOW_MS = 2000;

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
  private worker: WorkerLike;
  /** Null for a caller-owned worker, which is never terminated or replaced. */
  private readonly spawnWorker: (() => WorkerLike) | null;
  private readonly assetLoader: AssetLoader | undefined;

  private readonly index: ProjectIndex;
  /** The index state this client has mirrored into the worker. */
  private files: ProjectIndexState;
  /** Asset path -> hash currently mirrored (or being loaded). */
  private readonly assets = new Map<string, string>();
  private readonly retries = new RetryQueue();
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
  /** Asset and font loads still on their way to the worker. */
  private readonly loading = new Set<Promise<void>>();
  private readonly dirty = new Set<TreeID>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while the preview is hidden, see pause(). */
  private paused = false;
  /** The worker has reported "ready" or "initError" since it was created. */
  private workerStarted = false;
  /** The worker could not build the compiler; it retries on its own. */
  private initFailed = false;
  /** Restarts after a crash since the last finished compile. */
  private restarts = 0;
  /** Restarting stopped (too many crashes, or a caller-owned worker). */
  private workerDead = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  private state: PreviewState = {
    status: "starting",
    mainPath: null,
    diagnostics: [],
    compileMs: null,
    totalMs: null,
    document: null,
    error: null,
    stalled: false,
    follow: null,
    animation: null,
  };
  /** Edit sources since the last shown result; "typed" wins over "external". */
  private pendingKind: AnimationKind | null = null;
  /** The source of the latest edit, for results that arrive a bit later. */
  private recentKind: { kind: AnimationKind; at: number } | null = null;
  /** When the user (or the folder sync) last edited a text file; ms. */
  private lastLocalEditAt = -Infinity;
  /** When the last pending asset or font load finished; ms. */
  private loadsSettledAt = -Infinity;
  /** A local edit happened since the last result that was shown. */
  private editedSinceResult = false;
  /**
   * Changes of documents that were assembled but superseded before they
   * were shown, so that the next shown document can still report them.
   */
  private carriedChanges: PageChange[] = [];
  /** Errors from a compile that finished too soon after an edit to show. */
  private held: {
    mainPath: string;
    diagnostics: ProjectDiagnostic[];
    compileMs: number;
    totalMs: number | null;
  } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(state: PreviewState) => void>();
  /**
   * The last document built from a worker render, whether or not it was
   * shown: the worker leaves out what the last render it sent contained, so
   * the next one is only meaningful against this. Kept apart from
   * `state.document`, which only follows the newest compile of the current
   * main file.
   */
  private assembled: PreviewDocument | null = null;
  /** The shown error comes from a failed render, not from the compiler. */
  private renderFailed = false;
  /** Set while a rerender waits for the browser to come back online. */
  private onlineWait: AbortController | null = null;
  private compileStartedAt = new Map<number, number>();
  private latestCompileId = 0;
  private disposed = false;
  private readonly unsubscribeIndex: () => void;
  private nextPdfId = 1;
  private readonly pdfRequests = new Map<
    number,
    { resolve: (pdf: Uint8Array) => void; reject: (err: Error) => void }
  >();

  constructor(project: ProjectDoc, options: CompilerClientOptions = {}) {
    this.project = project;
    this.spawnWorker = options.worker
      ? null
      : (options.createWorker ?? createCompileWorker);
    this.worker = options.worker ?? this.spawnWorker!();
    this.assetLoader = options.assetLoader;

    this.attach(this.worker);
    this.index = projectIndex(project);
    this.unsubscribeIndex = this.index.subscribe((change) =>
      this.onIndexChange(change),
    );
    const state = this.index.state;
    this.files = state;
    if (this.syncStructure(state, [], [...state.texts.values()], true))
      this.requestCompile();
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

  /**
   * Tries again after a failure shown in `error`: a compiler that could not
   * start or kept crashing, or a preview that could not render. While
   * `stalled`, it restarts the worker instead.
   */
  retry(): void {
    if (this.disposed) return;
    if (this.workerDead) {
      if (!this.spawnWorker) return;
      this.workerDead = false;
      this.restarts = 0;
      this.replaceWorker();
      this.setState({ error: "Restarting the compiler.", stalled: false });
    } else if (this.state.stalled && this.spawnWorker) {
      // Asked for by the user, so it is not a crash and does not count
      // toward giving up.
      this.rejectPdfRequests(new Error("the compiler was restarted"));
      this.replaceWorker();
      this.setState({ error: "Restarting the compiler.", stalled: false });
    } else if (this.initFailed) {
      this.post({ type: "restart" });
    } else {
      this.post({ type: "rerender" });
      this.requestCompile();
    }
  }

  /**
   * Loads assets and fonts that failed to load again right away, instead of
   * waiting for the backoff. For when the loader starts working again, such
   * as after the project's link was rotated and the old one stopped working.
   */
  refreshAssets(): void {
    if (this.disposed || !this.assetLoader) return;
    const failed =
      this.fontKey === null ||
      [...this.assets.values()].some((hash) => hash === FAILED_LOAD);
    if (failed && this.syncAssets(this.files)) this.requestCompile();
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
    this.track(
      Promise.all(files.map(([hash, path]) => loader(hash, path))).then(
        (data) => {
          if (load !== this.fontLoad) return;
          this.retries.succeeded("fonts");
          this.postFonts(data);
        },
        (err: unknown) => {
          console.error("failed to load project fonts", err);
          if (load !== this.fontLoad) return;
          this.fontKey = null;
          this.retries.schedule("fonts", () => this.syncAssets(this.files));
        },
      ),
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

  /**
   * Compiles the main file to a PDF, including edits not yet compiled and
   * assets still loading. The preview can show a first result without an
   * image and catch up, but an exported file cannot.
   */
  async exportPdf(): Promise<Uint8Array> {
    if (this.disposed) throw new Error("compiler disposed");
    if (this.mainPath() === undefined)
      throw new Error("the project has no main file");
    // Loads finishing can start new ones (a doc change in between), so wait
    // until none are left.
    while (this.loading.size > 0) await Promise.all(this.loading);
    if (this.disposed) throw new Error("compiler disposed");
    const mainPath = this.mainPath();
    if (mainPath === undefined) throw new Error("the project has no main file");
    if (this.workerDead) throw new Error("the compiler is not running");
    // Edits still waiting out the debounce would be missing otherwise.
    this.flushTexts();
    const id = this.nextPdfId++;
    return new Promise((resolve, reject) => {
      this.pdfRequests.set(id, { resolve, reject });
      this.post({ type: "exportPdf", id, mainPath: typstPath(mainPath) });
      this.updateWatchdog();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPdfRequests(new Error("compiler disposed"));
    this.unsubscribeIndex();
    this.retries.dispose();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.clearWatchdog();
    this.dropHeld();
    this.detach(this.worker);
    if (this.spawnWorker) this.worker.terminate();
    this.onlineWait?.abort();
    this.listeners.clear();
  }

  private attach(worker: WorkerLike): void {
    worker.addEventListener("message", this.onWorkerMessage);
    worker.addEventListener("error", this.onWorkerError);
    worker.addEventListener("messageerror", this.onWorkerError);
  }

  private detach(worker: WorkerLike): void {
    worker.removeEventListener("message", this.onWorkerMessage);
    worker.removeEventListener("error", this.onWorkerError);
    worker.removeEventListener("messageerror", this.onWorkerError);
  }

  private rejectPdfRequests(err: Error): void {
    for (const { reject } of this.pdfRequests.values()) reject(err);
    this.pdfRequests.clear();
  }

  // An uncaught error can come from anywhere in the worker, and a lost
  // message leaves a compile or export waiting forever. Neither leaves the
  // worker in a state worth trusting, so both get a fresh one.
  private readonly onWorkerError = (event: WorkerEvents["error"]) => {
    console.error("the compile worker failed", event);
    this.recoverWorker("The compiler crashed.");
  };

  /**
   * Keeps a timer running while the worker owes an answer (a compile it
   * started, or a PDF), restarted by every message from it. When it fires,
   * the preview only says so; see WATCHDOG_MS.
   */
  private updateWatchdog(): void {
    this.clearWatchdog();
    const busy =
      this.compileStartedAt.size > 0 ||
      // An export waits for the compiler to start, which is not the
      // compile hanging, and a failed start is shown as an error already.
      (this.pdfRequests.size > 0 && this.workerStarted && !this.initFailed);
    if (!busy || this.disposed) return;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      this.setState({ stalled: true });
    }, WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Replaces a crashed worker. A document that brings down every
   * fresh worker too would loop forever, so after a few restarts without a
   * finished compile in between this stops and waits for retry().
   */
  private recoverWorker(reason: string): void {
    if (this.disposed || this.workerDead) return;
    this.clearWatchdog();
    this.rejectPdfRequests(new Error(reason.toLowerCase()));
    if (!this.spawnWorker || this.restarts >= MAX_RESTARTS) {
      this.workerDead = true;
      this.detach(this.worker);
      if (this.spawnWorker) this.worker.terminate();
      this.compileStartedAt.clear();
      this.setState({
        status: "error",
        stalled: false,
        error:
          this.restarts >= MAX_RESTARTS
            ? `${reason} It failed ${this.restarts + 1} times in a row; the document may be too large or trigger a compiler bug.`
            : reason,
      });
      return;
    }
    this.restarts++;
    this.replaceWorker();
    this.setState({
      status: "error",
      stalled: false,
      error: `${reason} Restarting it.`,
    });
  }

  /** Starts a fresh worker and mirrors the whole project into it. */
  private replaceWorker(): void {
    const spawn = this.spawnWorker!;
    this.detach(this.worker);
    this.worker.terminate();
    this.worker = spawn();
    this.attach(this.worker);
    this.workerStarted = false;
    this.initFailed = false;
    // The new worker counts compiles from 1 again, and its first render is
    // a full one.
    this.compileStartedAt.clear();
    this.latestCompileId = 0;

    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.dirty.clear();
    for (const file of this.files.texts.values()) this.sendText(file);
    // Asset and font bytes were transferred to the old worker, so they are
    // loaded again.
    this.assets.clear();
    this.fontKey = "";
    this.fontFiles = new Map();
    this.syncAssets(this.files);
    // Without project fonts syncAssets has no reason to reinit, but the new
    // worker starts with the default fonts, not the ones reinit() chose.
    if (this.fontFiles.size === 0 && this.baseFonts !== DEFAULT_FONTS)
      this.loadFonts();
    this.requestCompile();
  }

  /**
   * A rerender right away would recompile straight into the same failed
   * renderer load, over and over while offline.
   */
  private rerenderWhenOnline(): void {
    if (this.onlineWait) return;
    const wait = new AbortController();
    this.onlineWait = wait;
    window.addEventListener(
      "online",
      () => {
        this.onlineWait = null;
        this.post({ type: "rerender" });
      },
      { once: true, signal: wait.signal },
    );
  }

  private post(message: WorkerRequest, transfer?: Transferable[]): void {
    if (!this.disposed && !this.workerDead)
      this.worker.postMessage(message, transfer);
  }

  private setState(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private onIndexChange(change: ProjectIndexChange): void {
    // A collaborator's edits arrive as "import" and are not the user's to be
    // followed or to hold errors back for. Edits from the folder sync count:
    // they are this user's changes on disk.
    if (change.edited.size > 0 && change.by !== "checkout") {
      // The folder sync commits locally but is not the user typing.
      const kind: AnimationKind =
        change.by === "local" && change.origin !== FOLDER_ORIGIN
          ? "typed"
          : "external";
      if (this.pendingKind !== "typed") this.pendingKind = kind;
      this.recentKind = { kind: this.pendingKind, at: Date.now() };
    }
    if (change.by === "local" && change.edited.size > 0) {
      this.lastLocalEditAt = Date.now();
      this.editedSinceResult = true;
      if (this.held) this.scheduleSettle();
    }
    let edited = false;
    for (const id of change.edited) {
      if (!this.files.texts.has(id)) continue;
      this.dirty.add(id);
      edited = true;
    }
    if (change.structural) {
      this.files = change.state;
      const changed = this.syncStructure(
        change.state,
        change.textsRemoved,
        change.textsAdded,
        change.assetsRemoved.length > 0 || change.assetsAdded.length > 0,
      );
      // A checkout or a collaborator's merged edits can change the file set
      // and file contents in one batch. Compiling the new file set while the
      // texts still wait out the debounce reports errors that never existed,
      // like an #include of a file the same batch removed.
      if (edited) {
        if (this.flushTimer !== null) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.flushTexts();
      }
      if (changed || edited) this.requestCompile();
    } else if (edited) {
      this.scheduleFlush();
    }
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

  /**
   * Sends the worker what a structural change did to the files; true when
   * the compile input changed.
   */
  private syncStructure(
    state: ProjectIndexState,
    textsRemoved: readonly IndexedText[],
    textsAdded: readonly IndexedText[],
    assetsChanged: boolean,
  ): boolean {
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
    return changed;
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
      this.track(
        loader(hash, path).then(
          (data) => {
            // The file may have been replaced or removed while loading.
            if (this.assets.get(path) !== hash) return;
            this.retries.succeeded(`asset:${path}`);
            this.post({ type: "setAsset", path: typstPath(path), data }, [
              data.buffer,
            ]);
            this.requestCompile();
          },
          (err: unknown) => {
            console.error(`failed to load asset ${path}`, err);
            if (this.assets.get(path) !== hash) return;
            this.assets.set(path, FAILED_LOAD);
            this.retries.schedule(`asset:${path}`, () => {
              if (this.syncAssets(this.files)) this.requestCompile();
            });
          },
        ),
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

  /** `load` must not reject; failures are reported where they happen. */
  private track(load: Promise<void>): void {
    this.loading.add(load);
    void load.finally(() => {
      this.loading.delete(load);
      if (this.loading.size > 0) return;
      this.loadsSettledAt = Date.now();
      // A load that worked asks for a compile, whose result replaces the
      // held one. One that failed does not, and its errors are real.
      if (this.held) this.scheduleSettle();
    });
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
      this.dropHeld();
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
        // A first start, or one after a failure: the status still describes
        // the failure, and the compile requested meanwhile follows.
        if (!this.workerStarted || this.initFailed)
          this.setState({ status: "idle" });
        this.workerStarted = true;
        this.initFailed = false;
        this.retries.succeeded("init");
        if (this.state.error) this.setState({ error: null });
        break;
      case "initError":
        this.workerStarted = true;
        this.initFailed = true;
        this.setState({
          status: "error",
          error: `Could not start the Typst compiler: ${msg.message}`,
        });
        // Usually a dropped connection or a blocked CDN; the backoff also
        // covers a connection that comes back without an "online" event.
        this.retries.schedule("init", () => {
          if (this.initFailed) this.post({ type: "restart" });
        });
        break;
      case "compiling":
        this.latestCompileId = msg.id;
        this.compileStartedAt.set(msg.id, performance.now());
        this.setState({ status: "compiling" });
        break;
      case "result":
        this.restarts = 0;
        this.handleResult(msg);
        break;
      case "render":
        this.handleRender(msg);
        break;
      case "pdf": {
        const request = this.pdfRequests.get(msg.id);
        this.pdfRequests.delete(msg.id);
        if ("data" in msg) request?.resolve(msg.data);
        else request?.reject(new Error(msg.error));
        break;
      }
    }
    if (this.state.stalled) this.setState({ stalled: false });
    this.updateWatchdog();
  };

  private handleResult(msg: Extract<WorkerResponse, { type: "result" }>): void {
    const startedAt = this.compileStartedAt.get(msg.id);
    this.compileStartedAt.delete(msg.id);
    const fresh = msg.diagnostics.map(toProjectDiagnostic);
    const last = msg.id === this.latestCompileId;
    // A compile of the previous main file, finished after the switch. Its
    // render still has to be assembled, later renders build on it, but
    // nothing of it is shown.
    const current = this.isCurrent(msg.mainPath);
    // Every render is assembled, even a superseded one: the worker sent
    // only what changed against it.
    const assembled = this.assemble(msg.render, msg.renderError, true);
    if (this.disposed || !current) return;
    // A superseded compile's diagnostics are already out of date, and
    // showing them would make errors flicker back in while typing.
    if (!last) {
      if (assembled.document)
        this.carriedChanges.push(...assembled.document.changes);
      if (assembled.error) this.setState({ error: assembled.error });
      return;
    }
    if (!assembled.error) this.renderFailed = false;

    const now = Date.now();
    const shownFailed = this.state.diagnostics.some(isError);
    const totalMs =
      startedAt !== undefined ? performance.now() - startedAt : null;
    // Images and fonts still on their way show up as "file not found" when
    // a project opens, which would flash errors that fix themselves.
    const settling =
      !assembled.error &&
      errorsKey(fresh) !== "[]" &&
      errorsKey(fresh) !== errorsKey(this.state.diagnostics) &&
      (this.loading.size > 0 ||
        now - Math.max(this.lastLocalEditAt, this.loadsSettledAt) <
          ERROR_SETTLE_MS);

    let patch: Partial<PreviewState>;
    if (settling) {
      // Keep what is shown until typing pauses. The status goes back to what
      // it was before this compile started.
      this.held = {
        mainPath: msg.mainPath,
        diagnostics: fresh,
        compileMs: msg.compileMs,
        totalMs,
      };
      this.scheduleSettle();
      patch = { status: shownFailed ? "error" : "idle" };
    } else {
      this.dropHeld();
      const diagnostics = this.reuseDiagnostics(fresh);
      patch = {
        status: diagnostics.some(isError) || assembled.error ? "error" : "idle",
        diagnostics,
        compileMs: msg.compileMs,
        totalMs,
      };
    }

    let follow = this.state.follow;
    let animation = this.state.animation;
    if (assembled.document) {
      const changes = mergeChanges([
        ...this.carriedChanges,
        ...assembled.document.changes,
      ]);
      this.carriedChanges = [];
      if (
        changes.length > 0 &&
        (this.editedSinceResult ||
          now - this.lastLocalEditAt < FOLLOW_WINDOW_MS)
      )
        follow = { seq: (follow?.seq ?? 0) + 1, changes };
      const recent = this.recentKind;
      const kind =
        this.pendingKind ??
        (recent && now - recent.at < FOLLOW_WINDOW_MS ? recent.kind : null);
      animation =
        kind && changes.length > 0
          ? { seq: (animation?.seq ?? 0) + 1, kind, changes }
          : null;
    }
    this.editedSinceResult = false;
    if (assembled.document) this.pendingKind = null;

    this.setState({
      ...patch,
      document: assembled.document ?? this.state.document,
      error: assembled.error,
      follow,
      animation,
    });
  }

  /**
   * Most compiles while typing report the same diagnostics again. Keeping
   * the old array lets the editor skip re-applying its lint state.
   */
  private reuseDiagnostics(fresh: ProjectDiagnostic[]): ProjectDiagnostic[] {
    return JSON.stringify(fresh) === JSON.stringify(this.state.diagnostics)
      ? this.state.diagnostics
      : fresh;
  }

  /**
   * (Re)starts the wait for typing to pause, counted from the last edit or
   * finished load. While loads are pending there is nothing to wait for
   * yet; the last one to finish starts it.
   */
  private scheduleSettle(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.loading.size > 0) return;
    const since = Math.max(this.lastLocalEditAt, this.loadsSettledAt);
    const wait = ERROR_SETTLE_MS - (Date.now() - since);
    this.settleTimer = setTimeout(() => this.publishHeld(), Math.max(0, wait));
  }

  private dropHeld(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.held = null;
  }

  private publishHeld(): void {
    const held = this.held;
    this.dropHeld();
    if (!held || this.disposed || !this.isCurrent(held.mainPath)) return;
    this.setState({
      // A compile that started meanwhile reports its own status.
      status: this.compileStartedAt.size > 0 ? "compiling" : "error",
      diagnostics: this.reuseDiagnostics(held.diagnostics),
      compileMs: held.compileMs,
      totalMs: held.totalMs,
    });
  }

  /** The answer to a rerender: only the document, no compile finished. */
  private handleRender(msg: Extract<WorkerResponse, { type: "render" }>): void {
    const assembled = this.assemble(msg.render, msg.renderError, false);
    // A compile in flight delivers a newer document and status itself.
    if (
      this.disposed ||
      this.compileStartedAt.size > 0 ||
      !this.isCurrent(msg.mainPath)
    )
      return;
    if (assembled.error) {
      this.setState({ status: "error", error: assembled.error });
    } else if (assembled.document) {
      const failed = this.state.diagnostics.some((d) => d.severity === "error");
      this.setState({
        status: failed ? "error" : "idle",
        document: assembled.document,
        error: this.renderFailed ? null : this.state.error,
      });
      this.renderFailed = false;
    }
  }

  private isCurrent(typstMainPath: string): boolean {
    return (
      this.state.mainPath !== null &&
      typstPath(this.state.mainPath) === typstMainPath
    );
  }

  /**
   * Builds the document of a worker render. `error` is what the preview
   * shows for a render that failed in the worker or here; `document` is
   * null if there is nothing new to show.
   */
  private assemble(
    render: RenderPayload | undefined,
    renderError: RenderError | undefined,
    mayRerender: boolean,
  ): { document: PreviewDocument | null; error: string | null } {
    if (renderError) {
      console.error("preview render failed", renderError.message);
      this.renderFailed = true;
      if (renderError.kind === "load") {
        this.rerenderWhenOnline();
        return {
          document: null,
          error:
            "Could not load the preview. It retries once the connection is back.",
        };
      }
      return {
        document: null,
        error: `Rendering failed: ${renderError.message}`,
      };
    }
    if (!render) return { document: null, error: null };
    try {
      const document = buildPreviewDocument(render, this.assembled);
      if (document) {
        this.assembled = document;
        return { document, error: null };
      }
    } catch (err) {
      // Parsing the same markup again would fail the same way, so there is
      // no rerender; the next compile starts from what is left.
      console.error("preview render failed", err);
      this.assembled = null;
      this.renderFailed = true;
      return { document: null, error: `Rendering failed: ${String(err)}` };
    }
    // The render builds on a page or the defs this client never received
    // (a restarted worker, a lost message).
    this.assembled = null;
    if (mayRerender) this.post({ type: "rerender" });
    return { document: null, error: null };
  }
}

const isError = (d: ProjectDiagnostic) => d.severity === "error";

/** Identity of the errors alone, so warnings changing does not count. */
function errorsKey(diagnostics: readonly ProjectDiagnostic[]): string {
  return JSON.stringify(diagnostics.filter(isError));
}

/**
 * The changes in page and then top order, with ranges that overlap or touch
 * on the same page joined. Separate spots on a page stay separate, so a
 * highlight does not spread over the text between them.
 */
function mergeChanges(changes: PageChange[]): PageChange[] {
  const sorted = [...changes].sort((a, b) => a.page - b.page || a.top - b.top);
  const merged: PageChange[] = [];
  for (const c of sorted) {
    const last = merged.at(-1);
    if (last && last.page === c.page && c.top <= last.bottom) {
      merged[merged.length - 1] = {
        ...last,
        bottom: Math.max(last.bottom, c.bottom),
      };
    } else {
      merged.push(c);
    }
  }
  return merged;
}
