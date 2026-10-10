import type { TreeID } from "loro-crdt";

import {
  createAsset,
  createFile,
  deleteNode,
  getText,
  move,
  rename,
  setMainFile,
} from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import { CompilerClient } from "./compiler-client";
import type {
  ArtifactUpdate,
  WorkerLike,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";
import type { PreviewRenderer } from "./renderer";

class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listeners = new Set<(e: MessageEvent<WorkerResponse>) => void>();
  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }
  addEventListener(
    _type: "message",
    l: (e: MessageEvent<WorkerResponse>) => void,
  ) {
    this.listeners.add(l);
  }
  removeEventListener(
    _type: "message",
    l: (e: MessageEvent<WorkerResponse>) => void,
  ) {
    this.listeners.delete(l);
  }
  terminate() {}
  emit(message: WorkerResponse) {
    for (const l of this.listeners)
      l({ data: message } as MessageEvent<WorkerResponse>);
  }
  /** Returns and clears what was sent so far. */
  take(): WorkerRequest[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
}

function fakeRenderer() {
  const applied: ArtifactUpdate[] = [];
  let svg = "";
  const renderer: PreviewRenderer = {
    apply: (u) => void applied.push(u),
    renderSvg: async () => svg,
    dispose: () => {},
  };
  return {
    applied,
    renderer,
    setSvg: (s: string) => (svg = s),
  };
}

const page = (tid: string) =>
  `<g class="typst-page" transform="translate(0, 0)" data-tid="${tid}" data-page-width="100" data-page-height="200"><g/></g>`;
const svgDoc = (...tids: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><defs class="glyph"></defs>${tids.map(page).join("")}</svg>`;

/** Lets Loro events and the client's debounce timer run. */
async function settle() {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(50);
}

/** `createRenderer` gets the fake renderer, to resolve with or not. */
function setup(
  createRenderer: (
    renderer: PreviewRenderer,
  ) => Promise<PreviewRenderer> = async (renderer) => renderer,
) {
  const project = initProject(newProject(1), { title: "T" });
  const worker = new FakeWorker();
  const r = fakeRenderer();
  const client = new CompilerClient(project, {
    worker,
    createRenderer: () => createRenderer(r.renderer),
  });
  return { project, worker, client, ...r };
}

function emitResult(
  worker: FakeWorker,
  id: number,
  action: "reset" | "merge" = "reset",
) {
  worker.emit({
    type: "result",
    id,
    mainPath: "/main.typ",
    diagnostics: [],
    update: { action, data: new Uint8Array([id]) },
    compileMs: 1,
  });
}

function mainId(project: ProjectDoc): TreeID {
  return project.mainFile!;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CompilerClient mirroring", () => {
  it("sends every text file and compiles the main file on start", () => {
    const project = initProject(newProject(1), { title: "T" });
    const dir = createFile(project, null, "chapters", "dir");
    const intro = createFile(project, dir, "intro.typ", "text");
    getText(project, intro).insert(0, "Intro");
    project.doc.commit();

    const worker = new FakeWorker();
    new CompilerClient(project, {
      worker,
      createRenderer: async () => fakeRenderer().renderer,
    });

    const sent = worker.take();
    expect(sent).toContainEqual({
      type: "setText",
      path: "/chapters/intro.typ",
      text: "Intro",
    });
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "setText", path: "/main.typ" }),
    );
    expect(sent.at(-1)).toEqual({ type: "compile", mainPath: "/main.typ" });
  });

  it("sends a debounced setText for edits, then a compile", async () => {
    const { project, worker } = setup();
    worker.take();
    const text = getText(project, mainId(project));
    text.insert(0, "a");
    project.doc.commit();
    text.insert(1, "b");
    project.doc.commit();
    await Promise.resolve();
    expect(worker.take()).toEqual([]);

    await settle();
    expect(worker.take()).toEqual([
      { type: "setText", path: "/main.typ", text: text.toString() },
      { type: "compile", mainPath: "/main.typ" },
    ]);
  });

  it("turns a rename into remove + add and recompiles", async () => {
    const { project, worker } = setup();
    const ch = createFile(project, null, "ch.typ", "text");
    getText(project, ch).insert(0, "Chapter");
    project.doc.commit();
    await settle();
    worker.take();

    rename(project, ch, "chapter.typ");
    await settle();
    expect(worker.take()).toEqual([
      { type: "remove", path: "/ch.typ" },
      { type: "setText", path: "/chapter.typ", text: "Chapter" },
      { type: "compile", mainPath: "/main.typ" },
    ]);
  });

  it("compiles a batch that edits and removes files only once it is all applied", async () => {
    const { project, worker } = setup();
    const main = mainId(project);
    const extra = createFile(project, null, "extra.typ", "text", "x");
    getText(project, main).insert(0, '#include "extra.typ"\n');
    project.doc.commit();
    await settle();
    worker.take();

    // Like checking out an older version: the include and its file go
    // away in the same batch.
    getText(project, main).delete(0, '#include "extra.typ"\n'.length);
    deleteNode(project, extra);
    project.doc.commit();
    // No settle: the compile must not wait for the text debounce, nor run
    // before the text arrived.
    await Promise.resolve();
    const sent = worker.take();
    const compile = sent.findIndex((m) => m.type === "compile");
    const remove = sent.findIndex(
      (m) => m.type === "remove" && m.path === "/extra.typ",
    );
    const text = sent.findIndex(
      (m) => m.type === "setText" && m.path === "/main.typ",
    );
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(text).toBeGreaterThanOrEqual(0);
    expect(compile).toBeGreaterThan(Math.max(remove, text));
    expect(sent[text]).not.toMatchObject({
      text: expect.stringMatching(/include/),
    });
  });

  it("removes a freed path before another file takes it over", async () => {
    const { project, worker } = setup();
    const a = createFile(project, null, "a.typ", "text", "old");
    const b = createFile(project, null, "b.typ", "text", "new");
    await settle();
    worker.take();

    // One commit, so the client sees both changes in a single batch.
    project.fs.delete(a);
    project.fs.getNodeByID(b)!.data.set("name", "a.typ");
    project.doc.commit();
    await settle();
    const sent = worker.take();
    const lastRemove = sent.findLastIndex(
      (m) => m.type === "remove" && m.path === "/a.typ",
    );
    const set = sent.findIndex(
      (m) => m.type === "setText" && m.path === "/a.typ",
    );
    expect(set).toBeGreaterThan(lastRemove);
    expect(sent[set]).toEqual({ type: "setText", path: "/a.typ", text: "new" });
  });

  it("follows moves into folders, including the main file", async () => {
    const { project, worker } = setup();
    const dir = createFile(project, null, "src", "dir");
    await settle();
    worker.take();

    move(project, mainId(project), dir);
    await settle();
    const sent = worker.take();
    expect(sent).toContainEqual({ type: "remove", path: "/main.typ" });
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "setText", path: "/src/main.typ" }),
    );
    expect(sent.at(-1)).toEqual({ type: "compile", mainPath: "/src/main.typ" });
  });

  it("maps edits to the file's current path after a rename", async () => {
    const { project, worker } = setup();
    const ch = createFile(project, null, "a.typ", "text");
    await settle();
    rename(project, ch, "b.typ");
    await settle();
    worker.take();

    getText(project, ch).insert(0, "x");
    project.doc.commit();
    await settle();
    expect(worker.take()).toContainEqual({
      type: "setText",
      path: "/b.typ",
      text: "x",
    });
  });

  it("removes deleted files and stops compiling when the main file goes", async () => {
    const { project, worker, client } = setup();
    worker.emit({ type: "ready" });
    await settle();
    worker.take();

    deleteNode(project, mainId(project));
    await settle();
    expect(worker.take()).toEqual([
      { type: "remove", path: "/main.typ" },
      { type: "cancel" },
    ]);
    expect(client.getState()).toMatchObject({
      mainPath: null,
      document: null,
      diagnostics: [],
    });
  });

  it("switches the compile target when the main file changes", async () => {
    const { project, worker } = setup();
    const other = createFile(project, null, "other.typ", "text");
    await settle();
    worker.take();

    setMainFile(project, other);
    await settle();
    expect(worker.take()).toEqual([
      { type: "compile", mainPath: "/other.typ" },
    ]);
  });

  it("does not mirror assets without a loader, and loads them with one", async () => {
    const project = initProject(newProject(1), { title: "T" });
    const worker = new FakeWorker();
    const loader = vi.fn(async () => new Uint8Array([1, 2, 3]));
    new CompilerClient(project, {
      worker,
      assetLoader: loader,
      createRenderer: async () => fakeRenderer().renderer,
    });
    worker.take();
    const { createAsset } = await import("@/doc/fs-ops");
    createAsset(project, null, "logo.png", {
      hash: "abc",
      size: 3,
      mime: "image/png",
    });
    await settle();
    expect(loader).toHaveBeenCalledWith("abc", "logo.png");
    expect(worker.take()).toContainEqual({
      type: "setAsset",
      path: "/logo.png",
      data: new Uint8Array([1, 2, 3]),
    });
  });
});

describe("CompilerClient PDF export", () => {
  it("waits for assets still loading before it compiles", async () => {
    const project = initProject(newProject(1), { title: "T" });
    createAsset(project, null, "logo.png", {
      hash: "abc",
      size: 3,
      mime: "image/png",
    });
    const worker = new FakeWorker();
    let finish!: (data: Uint8Array) => void;
    const client = new CompilerClient(project, {
      worker,
      assetLoader: () => new Promise((resolve) => (finish = resolve)),
      createRenderer: async () => fakeRenderer().renderer,
    });
    worker.take();

    const pdf = client.exportPdf();
    await settle();
    expect(worker.take().map((m) => m.type)).not.toContain("exportPdf");

    finish(new Uint8Array([1]));
    await settle();
    const sent = worker.take().map((m) => m.type);
    expect(sent.indexOf("setAsset")).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf("exportPdf")).toBeGreaterThan(sent.indexOf("setAsset"));

    worker.emit({ type: "pdf", id: 1, data: new Uint8Array([9]) });
    await expect(pdf).resolves.toEqual(new Uint8Array([9]));
  });

  it("rejects without a main file", async () => {
    const project = initProject(newProject(1), { title: "T" });
    setMainFile(project, null);
    const client = new CompilerClient(project, {
      worker: new FakeWorker(),
      createRenderer: async () => fakeRenderer().renderer,
    });
    await expect(client.exportPdf()).rejects.toThrow("no main file");
  });
});

describe("CompilerClient fonts", () => {
  function fontSetup() {
    const project = initProject(newProject(1), { title: "T" });
    const worker = new FakeWorker();
    const loader = vi.fn(async (hash: string) =>
      new TextEncoder().encode(hash),
    );
    new CompilerClient(project, {
      worker,
      assetLoader: loader,
      createRenderer: async () => fakeRenderer().renderer,
    });
    worker.take();
    const reinits = () =>
      worker
        .take()
        .filter(
          (m): m is Extract<WorkerRequest, { type: "reinit" }> =>
            m.type === "reinit",
        );
    const asset = (name: string, hash: string, parent: TreeID | null = null) =>
      createAsset(project, parent, name, { hash, size: 1, mime: "font/ttf" });
    return { project, worker, loader, reinits, asset };
  }

  const decode = (fonts: (string | Uint8Array)[] | undefined) =>
    (fonts ?? []).map((f) =>
      typeof f === "string" ? f : new TextDecoder().decode(f),
    );

  it("reinits with the project's fonts when the set changes", async () => {
    const { project, reinits, asset } = fontSetup();
    asset("logo.png", "img");
    await settle();
    expect(reinits()).toEqual([]);

    const inter = asset("Inter.ttf", "h-inter");
    await settle();
    let sent = reinits();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.fonts.assets).toEqual(["text"]);
    expect(decode(sent[0]!.fonts.extra)).toEqual(["h-inter"]);

    asset("Mono.OTF", "h-mono");
    await settle();
    sent = reinits();
    expect(sent).toHaveLength(1);
    expect(decode(sent[0]!.fonts.extra)).toEqual(["h-inter", "h-mono"]);

    // Same content under another name or place is not a new font set.
    rename(project, inter, "InterRegular.ttf");
    asset("Copy.ttf", "h-inter");
    await settle();
    expect(reinits()).toEqual([]);

    // WOFF is not a format Typst can load.
    asset("web.woff2", "h-woff");
    await settle();
    expect(reinits()).toEqual([]);
  });

  it("reinits without a font once its file is deleted", async () => {
    const { project, reinits, asset } = fontSetup();
    const only = asset("A.ttf", "h-a");
    await settle();
    reinits();

    deleteNode(project, only);
    await settle();
    const sent = reinits();
    expect(sent).toHaveLength(1);
    expect(decode(sent[0]!.fonts.extra)).toEqual([]);
  });

  it("adds project fonts to a manual reinit", async () => {
    const project = initProject(newProject(1), { title: "T" });
    const worker = new FakeWorker();
    const client = new CompilerClient(project, {
      worker,
      assetLoader: async (hash) => new TextEncoder().encode(hash),
      createRenderer: async () => fakeRenderer().renderer,
    });
    createAsset(project, null, "A.ttf", { hash: "h-a", size: 1, mime: "" });
    await settle();
    worker.take();

    client.reinit({ assets: ["text", "cjk"], extra: ["https://x/y.ttf"] });
    const [msg] = worker.take();
    expect(msg?.type).toBe("reinit");
    if (msg?.type !== "reinit") return;
    expect(msg.fonts.assets).toEqual(["text", "cjk"]);
    expect(decode(msg.fonts.extra)).toEqual(["https://x/y.ttf", "h-a"]);
  });

  it("ignores a font load that finished after the set changed", async () => {
    const project = initProject(newProject(1), { title: "T" });
    const worker = new FakeWorker();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    new CompilerClient(project, {
      worker,
      assetLoader: async (hash) => {
        if (hash === "h-slow") await slow;
        return new TextEncoder().encode(hash);
      },
      createRenderer: async () => fakeRenderer().renderer,
    });
    const slowId = createAsset(project, null, "S.ttf", {
      hash: "h-slow",
      size: 1,
      mime: "",
    });
    await settle();
    deleteNode(project, slowId);
    createAsset(project, null, "F.ttf", { hash: "h-fast", size: 1, mime: "" });
    await settle();
    release();
    await settle();
    const reinits = worker.sent.filter((m) => m.type === "reinit");
    expect(reinits).toHaveLength(1);
    if (reinits[0]?.type !== "reinit") return;
    expect(decode(reinits[0].fonts.extra)).toEqual(["h-fast"]);
  });
});

describe("CompilerClient results", () => {
  it("renders successful results and keeps the last good render on errors", async () => {
    const { worker, client, applied, setSvg } = setup();
    worker.emit({ type: "ready" });
    worker.emit({ type: "compiling", id: 1 });
    expect(client.getState().status).toBe("compiling");

    setSvg(svgDoc("p1", "p2"));
    worker.emit({
      type: "result",
      id: 1,
      mainPath: "/main.typ",
      diagnostics: [],
      update: { action: "reset", data: new Uint8Array([1]) },
      compileMs: 5,
    });
    await vi.waitFor(() => expect(client.getState().status).toBe("idle"));
    const good = client.getState().document;
    expect(good?.pages.map((p) => p.tid)).toEqual(["p1", "p2"]);
    expect(applied).toHaveLength(1);

    worker.emit({ type: "compiling", id: 2 });
    worker.emit({
      type: "result",
      id: 2,
      mainPath: "/main.typ",
      diagnostics: [
        {
          path: "/main.typ",
          package: "",
          severity: "error",
          message: "unknown variable: x",
          range: { startLine: 0, startCol: 1, endLine: 0, endCol: 2 },
        },
      ],
      compileMs: 3,
    });
    await vi.waitFor(() => expect(client.getState().status).toBe("error"));
    expect(client.getState().document).toBe(good);
    expect(client.getState().diagnostics).toEqual([
      expect.objectContaining({
        path: "main.typ",
        message: "unknown variable: x",
      }),
    ]);
  });

  it("applies stale deltas but only renders the newest one", async () => {
    const { worker, client, applied, setSvg } = setup();
    worker.emit({ type: "compiling", id: 1 });
    worker.emit({ type: "compiling", id: 2 });
    setSvg(svgDoc("new"));
    emitResult(worker, 1, "reset");
    emitResult(worker, 2, "merge");
    await vi.waitFor(() => expect(client.getState().status).toBe("idle"));
    expect(applied.map((u) => u.action)).toEqual(["reset", "merge"]);
    expect(client.getState().document?.pages.map((p) => p.tid)).toEqual([
      "new",
    ]);
  });

  it("asks the worker for a full resync when a merge fails", async () => {
    const { worker, client, renderer } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderer.apply = () => {
      throw new Error("bad delta");
    };
    worker.emit({ type: "compiling", id: 1 });
    worker.emit({
      type: "result",
      id: 1,
      mainPath: "/main.typ",
      diagnostics: [],
      update: { action: "merge", data: new Uint8Array([1]) },
      compileMs: 1,
    });
    await vi.waitFor(() => expect(client.getState().status).toBe("error"));
    expect(client.getState().error).toMatch(/bad delta/);
    expect(worker.sent).toContainEqual({ type: "resync" });
  });

  it("retries a failed renderer load and resyncs once back online", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let online = false;
    const createRenderer = vi.fn(async (renderer: PreviewRenderer) => {
      if (!online) throw new TypeError("Failed to fetch");
      return renderer;
    });
    const { worker, client, setSvg } = setup(createRenderer);
    setSvg(svgDoc("p1"));
    worker.take();

    worker.emit({ type: "compiling", id: 1 });
    emitResult(worker, 1);
    await vi.waitFor(() => expect(client.getState().status).toBe("error"));
    expect(client.getState().error).toMatch(/Could not load the preview/);
    // Resyncing now would only recompile into the same failure.
    expect(worker.take()).not.toContainEqual({ type: "resync" });

    online = true;
    window.dispatchEvent(new Event("online"));
    expect(worker.take()).toContainEqual({ type: "resync" });

    worker.emit({ type: "compiling", id: 2 });
    emitResult(worker, 2);
    await vi.waitFor(() => expect(client.getState().status).toBe("idle"));
    expect(client.getState().document?.pages.map((p) => p.tid)).toEqual(["p1"]);
    // The eager load at startup, the failed one for result 1, the retry.
    expect(createRenderer).toHaveBeenCalledTimes(3);
  });

  it("stops waiting for the connection once disposed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { worker, client } = setup(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    worker.emit({ type: "compiling", id: 1 });
    emitResult(worker, 1);
    await vi.waitFor(() => expect(client.getState().status).toBe("error"));

    client.dispose();
    worker.take();
    window.dispatchEvent(new Event("online"));
    expect(worker.take()).toEqual([]);
  });
});

describe("CompilerClient PDF export", () => {
  it("flushes pending edits, then resolves with the worker's PDF", async () => {
    const { project, worker, client } = setup();
    worker.take();
    const text = getText(project, mainId(project));
    text.insert(0, "x");
    project.doc.commit();
    await Promise.resolve();

    const pdf = client.exportPdf();
    const sent = worker.take();
    expect(sent).toEqual([
      { type: "setText", path: "/main.typ", text: text.toString() },
      { type: "exportPdf", id: 1, mainPath: "/main.typ" },
    ]);
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    worker.emit({ type: "pdf", id: 1, data });
    await expect(pdf).resolves.toBe(data);
  });

  it("rejects with the worker's error", async () => {
    const { worker, client } = setup();
    const pdf = client.exportPdf();
    worker.emit({ type: "pdf", id: 1, error: "the document has 2 errors" });
    await expect(pdf).rejects.toThrow("the document has 2 errors");
  });

  it("rejects without a main file and on dispose", async () => {
    const { client } = setup();
    const pending = client.exportPdf();
    client.dispose();
    await expect(pending).rejects.toThrow("disposed");

    const other = setup();
    deleteNode(other.project, mainId(other.project));
    await expect(other.client.exportPdf()).rejects.toThrow("no main file");
  });
});
