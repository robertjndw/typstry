import type { ArtifactUpdate, RenderError, RenderPayload } from "./protocol";
import type { PreviewRenderer } from "./renderer";
import { splitSvgString, type SplitSvg } from "./svg-split";

/**
 * Remembers the tid multiset and defs of the last render sent to the client,
 * and leaves out of the next one what the client holds already. The client
 * keeps exactly the last render it was sent (see buildPreviewDocument), so
 * the two stay in step as long as every message arrives; when one does not,
 * the client asks for a rerender and this is reset.
 */
export class RenderDiff {
  private defs: string | null = null;
  private tids = new Map<string, number>();

  diff(split: SplitSvg): RenderPayload {
    const unused = new Map(this.tids);
    const pages = split.pages.map(({ tid, width, height, markup }) => {
      const left = tid ? (unused.get(tid) ?? 0) : 0;
      if (left === 0) return { tid, width, height, markup };
      unused.set(tid, left - 1);
      return { tid, width, height, markup: null };
    });
    const defs = split.defsSource === this.defs ? null : split.defsSource;

    this.defs = split.defsSource;
    this.tids = new Map();
    for (const { tid } of split.pages) {
      // An empty tid is never reused, so it is not worth counting.
      if (tid) this.tids.set(tid, (this.tids.get(tid) ?? 0) + 1);
    }
    return { rootTag: split.rootTag, defs, pages };
  }

  /** Forgets what was sent, so the next diff is a full render. */
  reset(): void {
    this.defs = null;
    this.tids.clear();
  }
}

export interface RenderOutcome {
  /** Null when nothing was rendered, because of an error or by choice. */
  render: RenderPayload | null;
  renderMs: number;
  error: RenderError | null;
  /**
   * The renderer dropped an update it was given or lost its state, so the
   * compiler's incremental stream no longer matches it. The compiler's next
   * update has to be a full reset.
   */
  desynced: boolean;
}

export type RerenderOutcome =
  | { kind: "render"; outcome: RenderOutcome }
  /** The renderer does not hold the document; it needs a compile. */
  | { kind: "compile" };

/**
 * The worker's side of the preview: the renderer session that vector updates
 * are merged into, and the diff against what the client has. The session
 * lives here so a 12 MB SVG string (embedded images are base64-encoded on
 * every render) never leaves the worker. It can outlive a compiler restart,
 * since a new compiler session starts with a full reset update.
 */
export class RenderHost {
  private renderer: Promise<PreviewRenderer> | null = null;
  private readonly diff = new RenderDiff();
  /** Main file of the last update applied; null if the session is unusable. */
  private sessionMainPath: string | null = null;
  /** The session holds a newer document than the last render sent. */
  private unrendered = false;
  /** Updates and renders must not interleave on one session. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly createRenderer: () => Promise<PreviewRenderer>;
  private readonly now: () => number;

  constructor(
    createRenderer: () => Promise<PreviewRenderer>,
    now: () => number = () => performance.now(),
  ) {
    this.createRenderer = createRenderer;
    this.now = now;
  }

  /** Fetches the renderer alongside the compiler instead of at the first result. */
  preload(): void {
    void this.load().catch(() => undefined);
  }

  /**
   * Applies a compile's update and renders, unless `defer()` says that a
   * newer compile is already waiting. A deferred state is rendered by the
   * next call that does not defer, even one without an update (that newer
   * compile may fail).
   */
  update(
    update: ArtifactUpdate | undefined,
    mainPath: string,
    defer: () => boolean,
  ): Promise<RenderOutcome> {
    return this.exclusive(async () => {
      const started = this.now();
      const done = (render: RenderPayload | null): RenderOutcome => ({
        render,
        renderMs: this.now() - started,
        error: null,
        desynced: false,
      });
      if (!update && !this.unrendered) return done(null);

      if (update) {
        let renderer: PreviewRenderer;
        try {
          renderer = await this.load();
        } catch (err) {
          return this.fail("load", err, started);
        }
        try {
          renderer.apply(update);
        } catch (err) {
          return this.fail("render", err, started);
        }
        this.sessionMainPath = mainPath;
        this.unrendered = true;
      }
      if (defer()) return done(null);
      try {
        return done(await this.renderNow());
      } catch (err) {
        return this.fail("render", err, started);
      }
    });
  }

  /**
   * Sends the next render in full. Answers from the session when it holds
   * the document for `mainPath`, so nothing is compiled again.
   */
  rerender(mainPath: string | null): Promise<RerenderOutcome> {
    return this.exclusive(async () => {
      this.diff.reset();
      if (mainPath === null || this.sessionMainPath !== mainPath)
        return { kind: "compile" };
      const started = this.now();
      try {
        const render = await this.renderNow();
        return {
          kind: "render",
          outcome: {
            render,
            renderMs: this.now() - started,
            error: null,
            desynced: false,
          },
        };
      } catch (err) {
        return { kind: "render", outcome: this.fail("render", err, started) };
      }
    });
  }

  dispose(): void {
    this.drop();
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async renderNow(): Promise<RenderPayload> {
    const renderer = await this.load();
    const render = this.diff.diff(splitSvgString(await renderer.renderSvg()));
    this.unrendered = false;
    return render;
  }

  private load(): Promise<PreviewRenderer> {
    if (!this.renderer) {
      const loading = this.createRenderer();
      this.renderer = loading;
      // Usually a fetch that failed while offline. Keeping the rejected
      // promise would leave the preview broken until the worker restarts.
      loading.catch(() => {
        if (this.renderer === loading) this.renderer = null;
      });
    }
    return this.renderer;
  }

  private drop(): void {
    const renderer = this.renderer;
    this.renderer = null;
    this.sessionMainPath = null;
    this.unrendered = false;
    void renderer?.then((r) => r.dispose()).catch(() => undefined);
  }

  // The session may be half merged or the wasm may have panicked, so it is
  // thrown away rather than trusted. What was sent to the client stays valid.
  private fail(
    kind: RenderError["kind"],
    err: unknown,
    started: number,
  ): RenderOutcome {
    console.error("preview render failed", err);
    this.drop();
    return {
      render: null,
      renderMs: this.now() - started,
      error: { kind, message: String(err) },
      desynced: true,
    };
  }
}
