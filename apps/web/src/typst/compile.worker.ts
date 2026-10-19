import {
  CompileFormatEnum,
  createTypstCompiler,
  type TypstCompiler,
} from "@myriaddreamin/typst.ts/compiler";
import { MemoryAccessModel } from "@myriaddreamin/typst.ts/fs/memory";
import { FetchPackageRegistry } from "@myriaddreamin/typst.ts/fs/package";
import {
  loadFonts,
  withAccessModel,
  withPackageRegistry,
} from "@myriaddreamin/typst.ts/options.init";
import compilerWasmUrl from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url";

import { wasmModuleRef } from "./wasm-module";

import { normalizeDiagnostic, type RawDiagnostic } from "./diagnostics";
import {
  DEFAULT_FONTS,
  type ArtifactUpdate,
  type FontConfig,
  type WorkerDiagnostic,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { FONT_CACHE } from "./cache-names";
import { createPreviewRenderer } from "./renderer";
import { RenderHost, type RenderOutcome } from "./render-state";
import { CompileScheduler } from "./scheduler";

// typst.ts 0.8 fetches its default fonts from typst-assets on jsdelivr. Point
// it at the release matching the bundled Typst 0.15.0 (its own default is
// v0.13.1) so the preview uses the same fonts as a native typst 0.15.0 build,
// which matters once PDFs are also exported server-side.
const FONT_PREFIX = {
  text: fontBase(
    import.meta.env.VITE_TYPST_FONT_BASE,
    "https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.15.0/files/fonts/",
  ),
  // The CJK and emoji bundles, which the app does not load by default.
  _: fontBase(
    import.meta.env.VITE_TYPST_DEV_FONT_BASE,
    "https://cdn.jsdelivr.net/gh/typst/typst-dev-assets@v0.15.0/files/fonts/",
  ),
};

/**
 * Self-hosters who cannot reach jsdelivr can mirror the font files and
 * point the build at their copy. typst.ts appends file names directly, so
 * the prefix needs its trailing slash.
 */
function fontBase(configured: string | undefined, fallback: string): string {
  const base = configured?.trim();
  if (!base) return fallback;
  return base.endsWith("/") ? base : base + "/";
}

// False sends a full vector artifact on every compile. Deltas are much
// smaller (a few KB instead of ~120 KB for 20 pages) and cheaper to merge;
// the renderer takes both.
const INCREMENTAL = true;

type IncrementalServer = Parameters<
  Parameters<TypstCompiler["withIncrementalServer"]>[0]
>[0];

interface Session {
  compiler: TypstCompiler;
  incr: { server: IncrementalServer; release: () => void } | null;
  /** True until the incremental server has produced its first full output. */
  needsReset: boolean;
}

// The app's tsconfig uses the DOM lib; pulling in the webworker lib would
// change globals for every file, so the worker scope is typed by hand.
const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
};

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

/**
 * Fonts are large and immutable, so they go through Cache Storage: after
 * the first load the preview works without network (except for packages).
 */
async function cachedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  let cache: Cache | undefined;
  try {
    cache = await caches.open(FONT_CACHE);
    const hit = await cache.match(url);
    if (hit) return hit;
  } catch {
    // Cache Storage is unavailable in insecure contexts; just fetch.
  }
  const res = await fetch(input, init);
  // typst.ts feeds whatever body it gets into the font parser, so a 404 page
  // would surface as a confusing font error. Fail loudly instead.
  if (!res.ok) throw new Error(`Failed to load font ${url}: ${res.status}`);
  await cache?.put(url, res.clone()).catch(() => undefined);
  return res;
}

// Shared across reinits so downloaded packages survive a font change.
// FetchPackageRegistry uses synchronous XHR, which is only allowed in
// workers; another reason the compiler lives here.
const accessModel = new MemoryAccessModel();
const packages = new FetchPackageRegistry(accessModel);

type FileEntry =
  { kind: "text"; text: string } | { kind: "asset"; data: Uint8Array };
const files = new Map<string, FileEntry>();

let fonts: FontConfig = DEFAULT_FONTS;
let session: Promise<Session> | null = null;
/** The resolved latest session, or null while one is being built. */
let current: Session | null = null;
let nextId = 1;
let lastMainPath: string | null = null;
/**
 * Set when a panic rebuilt the compiler and the same compile runs again,
 * so a document that panics every time does not loop.
 */
let retryingAfterPanic = false;
/**
 * Like retryingAfterPanic, for a render that failed: one recompile with a
 * full reset update, and no more until a render works again.
 */
let retryingAfterRenderFailure = false;

const rendering = new RenderHost(createPreviewRenderer);
/**
 * A render may be skipped for a newer compile that is already waiting, but
 * only this soon after the last one went out. Otherwise a compile slower
 * than the typing (a title used on every page) always has a successor
 * waiting, and the preview would not move until the typing stops.
 */
const RENDER_SKIP_WINDOW_MS = 100;
let lastRenderAt = Number.NEGATIVE_INFINITY;

function applyFile(compiler: TypstCompiler, path: string, f: FileEntry): void {
  if (f.kind === "text") compiler.addSource(path, f.text);
  else compiler.mapShadow(path, f.data);
}

function openIncrementalServer(
  compiler: TypstCompiler,
): Promise<{ server: IncrementalServer; release: () => void }> {
  // withIncrementalServer frees the server when the callback settles, so the
  // callback parks on a promise that only release() resolves.
  return new Promise((resolve) => {
    void compiler.withIncrementalServer(
      (server) => new Promise<void>((release) => resolve({ server, release })),
    );
  });
}

async function buildSession(config: FontConfig): Promise<Session> {
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => wasmModuleRef(compilerWasmUrl),
    beforeBuild: [
      // loadFonts must be passed explicitly: in typst.ts 0.7 the implicit
      // default font loader is added to a copy of the options and never
      // runs, which leaves the compiler with no fonts at all.
      loadFonts(config.extra ?? [], {
        assets: config.assets.length > 0 ? config.assets : false,
        assetUrlPrefix: FONT_PREFIX,
        fetcher: cachedFetch,
      }),
      withAccessModel(accessModel),
      withPackageRegistry(packages),
    ],
  });
  const incr = INCREMENTAL ? await openIncrementalServer(compiler) : null;
  return { compiler, incr, needsReset: true };
}

function startSession(config: FontConfig): void {
  const previous = current;
  current = null;
  const pending = buildSession(config);
  session = pending;
  pending.then(
    (s) => {
      if (session !== pending) {
        s.incr?.release();
        return;
      }
      // Files that changed while the compiler was being built only exist in
      // the map, so the new compiler gets the whole set. Messages are
      // macrotasks, so none can slip in between this and `current = s`.
      for (const [path, f] of files) applyFile(s.compiler, path, f);
      current = s;
      post({ type: "ready" });
    },
    (err: unknown) => {
      if (session === pending)
        post({ type: "initError", message: String(err) });
    },
  );
  previous?.incr?.release();
}

/** A fresh compiler with the current fonts, compiling what was last asked. */
function restartSession(): void {
  startSession(fonts);
  if (lastMainPath) scheduler.request(lastMainPath);
}

/**
 * The current session once it is ready, or null when it failed to start
 * (initError was already reported) or a reinit replaced it meanwhile.
 */
async function readySession(): Promise<Session | null> {
  if (!session) startSession(fonts);
  try {
    const s = await session!;
    return s === current ? s : null;
  } catch {
    return null;
  }
}

async function compile(mainPath: string): Promise<void> {
  const s = await readySession();
  if (!s) return; // a reinit recompiles once its session is ready
  const id = nextId++;
  post({ type: "compiling", id });
  const started = performance.now();
  let diagnostics: WorkerDiagnostic[];
  let update: ArtifactUpdate | undefined;
  let crashed = false;
  try {
    // A world compile reports warnings too, which the vector export paths
    // drop. Typst memoizes, so the export below reuses this work.
    const check = await s.compiler.runWithWorld(
      { mainFilePath: mainPath },
      (world) => world.compile({ diagnostics: "full" }),
    );
    diagnostics = (check.diagnostics ?? []).map((d) =>
      normalizeDiagnostic(d as RawDiagnostic),
    );
    if (!check.hasError) update = await exportArtifact(s, mainPath);
  } catch (err) {
    // A panic inside the wasm may leave the compiler in a bad state, so the
    // next compile starts from a fresh one.
    console.error("typst compile crashed", err);
    diagnostics = [
      {
        path: "",
        package: "",
        severity: "error",
        message: `Compiler crashed: ${String(err)}`,
        range: null,
      },
    ];
    crashed = true;
  }
  if (!crashed) {
    retryingAfterPanic = false;
  } else if (s === current) {
    startSession(fonts);
    // The preview would otherwise show the crash until the next edit, even
    // when the panic came from state the fresh compiler does not have.
    if (!retryingAfterPanic && lastMainPath) {
      retryingAfterPanic = true;
      scheduler.request(lastMainPath);
    } else {
      retryingAfterPanic = false;
    }
  }
  const compileMs = performance.now() - started;
  // After the crash handling above: a crashed compile has nothing to render.
  const rendered = crashed
    ? null
    : await rendering.update(
        update,
        mainPath,
        () =>
          scheduler.hasWaiting &&
          performance.now() - lastRenderAt < RENDER_SKIP_WINDOW_MS,
      );
  if (rendered?.render) lastRenderAt = performance.now();
  if (rendered) afterRender(rendered);
  post({
    type: "result",
    id,
    mainPath,
    diagnostics,
    ...renderFields(rendered),
    compileMs,
    renderMs: rendered?.renderMs ?? 0,
  });
}

function renderFields(
  outcome: RenderOutcome | null,
): Pick<Extract<WorkerResponse, { type: "result" }>, "render" | "renderError"> {
  return {
    ...(outcome?.render ? { render: outcome.render } : {}),
    ...(outcome?.error ? { renderError: outcome.error } : {}),
  };
}

/**
 * A failed render leaves the renderer without an update the compiler
 * believes it has, so the compiler starts its stream over.
 */
function afterRender(outcome: RenderOutcome): void {
  if (outcome.desynced && current?.incr) {
    current.incr.server.reset();
    current.needsReset = true;
  }
  if (!outcome.error) {
    retryingAfterRenderFailure = false;
  } else if (
    // A failed load would only fail again right away; the client asks for a
    // rerender once the connection is back.
    outcome.error.kind === "render" &&
    !retryingAfterRenderFailure &&
    lastMainPath
  ) {
    retryingAfterRenderFailure = true;
    scheduler.request(lastMainPath);
  }
}

async function rerender(): Promise<void> {
  const mainPath = lastMainPath;
  const answer = await rendering.rerender(mainPath);
  if (answer.kind === "compile") {
    if (mainPath) scheduler.request(mainPath);
    return;
  }
  afterRender(answer.outcome);
  post({
    type: "render",
    mainPath: mainPath!,
    ...renderFields(answer.outcome),
    renderMs: answer.outcome.renderMs,
  });
}

async function exportArtifact(
  s: Session,
  mainPath: string,
): Promise<ArtifactUpdate | undefined> {
  if (!s.incr) {
    const { result } = await s.compiler.compile({ mainFilePath: mainPath });
    return result ? { action: "reset", data: result } : undefined;
  }
  const { result } = await s.compiler.compile({
    mainFilePath: mainPath,
    incrementalServer: s.incr.server,
  });
  if (!result) return undefined;
  const action = s.needsReset ? "reset" : "merge";
  s.needsReset = false;
  return { action, data: result };
}

async function exportPdf(id: number, mainPath: string): Promise<void> {
  const fail = (error: string) => post({ type: "pdf", id, error });
  const s = await readySession();
  if (!s) return fail("the compiler is not ready, try again");
  try {
    const { result, diagnostics } = await s.compiler.compile({
      mainFilePath: mainPath,
      format: CompileFormatEnum.pdf,
      diagnostics: "full",
    });
    if (result) {
      post({ type: "pdf", id, data: result }, [result.buffer as ArrayBuffer]);
      return;
    }
    const errors = (diagnostics ?? []).filter(
      (d) => normalizeDiagnostic(d as RawDiagnostic).severity === "error",
    ).length;
    fail(
      errors > 0
        ? `the document has ${errors} error${errors === 1 ? "" : "s"}`
        : "the compiler produced no output",
    );
  } catch (err) {
    // Like a panic in a preview compile: the compiler may be broken now.
    console.error("typst PDF export crashed", err);
    fail(String(err));
    if (s === current) restartSession();
  }
}

// Throttle, not a trailing debounce: a debounce adds its full delay to every
// keystroke and starves the preview while the user keeps typing. A compile
// starts as soon as the previous one has compiled and rendered, with the
// latest text, one running and one queued. The floor only matters when
// compiling is very fast: the client parses the pages of every result on the
// main thread, and 40 ms (25 results a second) keeps that work and the
// message traffic bounded without being perceptible while typing.
const scheduler = new CompileScheduler<string>(compile, {
  delayMs: 40,
  mode: "throttle",
});

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "setText":
    case "setAsset": {
      const entry: FileEntry =
        msg.type === "setText"
          ? { kind: "text", text: msg.text }
          : { kind: "asset", data: msg.data };
      files.set(msg.path, entry);
      if (current) applyFile(current.compiler, msg.path, entry);
      break;
    }
    case "remove":
      files.delete(msg.path);
      current?.compiler.unmapShadow(msg.path);
      break;
    case "compile":
      lastMainPath = msg.mainPath;
      scheduler.request(msg.mainPath);
      break;
    case "exportPdf":
      void exportPdf(msg.id, msg.mainPath);
      break;
    case "cancel":
      lastMainPath = null;
      scheduler.cancel();
      break;
    case "rerender":
      void rerender();
      break;
    case "reinit":
      fonts = msg.fonts;
      restartSession();
      break;
    case "restart":
      restartSession();
      break;
  }
});

startSession(fonts);
rendering.preload();
