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
import { initProject, type PackageRecord, type ProjectDoc } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";
import { FOLDER_ORIGIN } from "@/folder/origin";

import { deletePackage, putPackage, setFontBundle } from "@/packages/records";

import { CompilerClient } from "./compiler-client";
import type {
  RenderPayload,
  WorkerEvents,
  WorkerLike,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  /** The buffers handed over with each message, in order. */
  transfers: (Transferable[] | undefined)[] = [];
  terminated = false;
  private listeners = new Map<string, Set<(e: never) => void>>();
  postMessage(message: WorkerRequest, transfer?: Transferable[]) {
    this.sent.push(message);
    this.transfers.push(transfer);
  }
  addEventListener<K extends keyof WorkerEvents>(
    type: K,
    l: (e: WorkerEvents[K]) => void,
  ) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(l);
    this.listeners.set(type, set);
  }
  removeEventListener<K extends keyof WorkerEvents>(
    type: K,
    l: (e: WorkerEvents[K]) => void,
  ) {
    this.listeners.get(type)?.delete(l);
  }
  terminate() {
    this.terminated = true;
  }
  emit(message: WorkerResponse) {
    for (const l of this.listeners.get("message") ?? [])
      (l as (e: MessageEvent<WorkerResponse>) => void)({
        data: message,
      } as MessageEvent<WorkerResponse>);
  }
  crash() {
    for (const l of this.listeners.get("error") ?? [])
      (l as (e: Event) => void)(new Event("error"));
  }
  /** Returns and clears what was sent so far. */
  take(): WorkerRequest[] {
    const out = this.sent;
    this.sent = [];
    this.transfers = [];
    return out;
  }
}

const pageMarkup = (tid: string) =>
  `<g class="typst-page" transform="translate(0, 0)" data-tid="${tid}" data-page-width="100" data-page-height="200"><g/></g>`;
const rootTag =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">';

/** A render with every page and the defs, as after a worker restart. */
const fullRender = (...tids: string[]): RenderPayload => ({
  rootTag,
  defs: '<defs class="glyph"></defs>',
  pages: tids.map((tid) => ({
    tid,
    width: 100,
    height: 200,
    markup: pageMarkup(tid),
  })),
});

/** A render that only sends the given tids' markup, as the worker's diff does. */
const deltaRender = (sent: string[], ...tids: string[]): RenderPayload => ({
  rootTag,
  defs: null,
  pages: tids.map((tid) => ({
    tid,
    width: 100,
    height: 200,
    markup: sent.includes(tid) ? pageMarkup(tid) : null,
  })),
});

/** Lets Loro events and the client's debounce timer run. */
async function settle() {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(50);
}

function setup() {
  const project = initProject(newProject(1), { title: "T" });
  const worker = new FakeWorker();
  const client = new CompilerClient(project, { worker });
  return { project, worker, client };
}

function emitResult(
  worker: FakeWorker,
  id: number,
  render?: RenderPayload,
  mainPath = "/main.typ",
) {
  worker.emit({
    type: "result",
    id,
    mainPath,
    diagnostics: [],
    ...(render ? { render } : {}),
    compileMs: 1,
    renderMs: 1,
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
    });
    await expect(client.exportPdf()).rejects.toThrow("no main file");
  });
});

describe("CompilerClient asset retries", () => {
  function retrySetup() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const project = initProject(newProject(1), { title: "T" });
    const worker = new FakeWorker();
    let fail = true;
    const loader = vi.fn(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return new Uint8Array([1, 2, 3]);
    });
    const client = new CompilerClient(project, {
      worker,
      assetLoader: loader,
    });
    worker.take();
    const logo = createAsset(project, null, "logo.png", {
      hash: "abc",
      size: 3,
      mime: "image/png",
    });
    const setAssets = () => worker.take().filter((m) => m.type === "setAsset");
    return {
      project,
      client,
      worker,
      loader,
      logo,
      setAssets,
      heal: () => (fail = false),
    };
  }

  it("retries a failed asset load after a backoff", async () => {
    const { loader, setAssets, heal } = retrySetup();
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(setAssets()).toEqual([]);

    heal();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(setAssets()).toEqual([
      { type: "setAsset", path: "/logo.png", data: new Uint8Array([1, 2, 3]) },
    ]);
  });

  it("retries right away when asked to refresh its assets", async () => {
    const { client, loader, setAssets, heal } = retrySetup();
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);

    heal();
    client.refreshAssets();
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(setAssets()).toHaveLength(1);

    // Nothing failed any more, so another refresh loads nothing.
    client.refreshAssets();
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("retries right away once the browser is back online", async () => {
    const { loader, setAssets, heal } = retrySetup();
    await settle();
    heal();
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(setAssets()).toHaveLength(1);
  });

  it("does not retry an asset that was deleted meanwhile", async () => {
    const { project, worker, loader, logo, heal } = retrySetup();
    await settle();
    deleteNode(project, logo);
    await settle();
    expect(worker.take()).toContainEqual({ type: "remove", path: "/logo.png" });

    heal();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(worker.take()).toEqual([]);
  });
});

describe("CompilerClient pause", () => {
  it("holds edits and compiles while paused, then catches up", async () => {
    const { project, worker, client } = setup();
    worker.take();

    client.pause();
    expect(worker.take()).toEqual([{ type: "cancel" }]);
    const text = getText(project, mainId(project));
    text.insert(0, "x");
    project.doc.commit();
    createFile(project, null, "ch.typ", "text");
    await settle();
    expect(worker.take().filter((m) => m.type === "compile")).toEqual([]);

    client.resume();
    const sent = worker.take();
    expect(sent).toContainEqual({
      type: "setText",
      path: "/main.typ",
      text: text.toString(),
    });
    expect(sent.at(-1)).toEqual({ type: "compile", mainPath: "/main.typ" });
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
    });
    createAsset(project, null, "A.ttf", { hash: "h-a", size: 1, mime: "" });
    await settle();
    worker.take();

    client.reinit({ assets: ["text", "cjk"], extra: ["https://x/y.ttf"] });
    // The font bytes are not kept around, so a reinit loads them again.
    await settle();
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
  it("shows successful results and keeps the last good render on errors", async () => {
    const { worker, client } = setup();
    worker.emit({ type: "ready" });
    worker.emit({ type: "compiling", id: 1 });
    expect(client.getState().status).toBe("compiling");

    emitResult(worker, 1, fullRender("p1", "p2"));
    expect(client.getState().status).toBe("idle");
    const good = client.getState().document;
    expect(good?.pages.map((p) => p.tid)).toEqual(["p1", "p2"]);

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
      renderMs: 0,
    });
    expect(client.getState().status).toBe("error");
    expect(client.getState().document).toBe(good);
    expect(client.getState().diagnostics).toEqual([
      expect.objectContaining({
        path: "main.typ",
        message: "unknown variable: x",
      }),
    ]);
  });

  it("reuses pages the worker left out and builds on superseded renders", () => {
    const { worker, client } = setup();
    worker.emit({ type: "compiling", id: 1 });
    worker.emit({ type: "compiling", id: 2 });
    worker.emit({ type: "compiling", id: 3 });
    emitResult(worker, 1, fullRender("a", "b"));
    // Superseded, so not shown, but the next delta is relative to it.
    expect(client.getState().document).toBeNull();
    emitResult(worker, 2, deltaRender(["c"], "a", "c"));
    expect(client.getState().document).toBeNull();
    emitResult(worker, 3, deltaRender(["d"], "a", "c", "d"));

    const doc = client.getState().document!;
    expect(doc.pages.map((p) => p.tid)).toEqual(["a", "c", "d"]);
    expect(worker.sent).not.toContainEqual({ type: "rerender" });
  });

  it("keeps unchanged page elements between results", () => {
    const { worker, client } = setup();
    worker.emit({ type: "compiling", id: 1 });
    emitResult(worker, 1, fullRender("a", "b"));
    const first = client.getState().document!;
    worker.emit({ type: "compiling", id: 2 });
    emitResult(worker, 2, deltaRender(["c"], "a", "c"));
    const second = client.getState().document!;
    expect(second.defs).toBe(first.defs);
    expect(second.pages[0]).toBe(first.pages[0]);
  });

  it("asks for a rerender when a render leaves out what it never had", () => {
    const { worker, client } = setup();
    worker.emit({ type: "compiling", id: 1 });
    emitResult(worker, 1, deltaRender([], "a"));
    expect(worker.sent).toContainEqual({ type: "rerender" });
    expect(client.getState()).toMatchObject({ status: "idle", document: null });

    // The worker's answer is the whole document.
    worker.emit({
      type: "render",
      mainPath: "/main.typ",
      render: fullRender("a"),
      renderMs: 1,
    });
    expect(client.getState().document?.pages.map((p) => p.tid)).toEqual(["a"]);
  });

  it("does not show a rerender's document while a compile is running", () => {
    const { worker, client } = setup();
    worker.emit({ type: "compiling", id: 1 });
    worker.emit({
      type: "render",
      mainPath: "/main.typ",
      render: fullRender("a"),
      renderMs: 1,
    });
    expect(client.getState().document).toBeNull();
    // It still counts as the base of the next delta.
    emitResult(worker, 1, deltaRender([], "a"));
    expect(client.getState().document?.pages.map((p) => p.tid)).toEqual(["a"]);
  });

  it("shows a failed render and clears it with the next good one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { worker, client } = setup();
    worker.emit({ type: "compiling", id: 1 });
    worker.emit({
      type: "result",
      id: 1,
      mainPath: "/main.typ",
      diagnostics: [],
      renderError: { kind: "render", message: "bad delta" },
      compileMs: 1,
      renderMs: 0,
    });
    expect(client.getState().status).toBe("error");
    expect(client.getState().error).toMatch(/Rendering failed: bad delta/);
    // The worker recovers on its own; there is nothing to request.
    expect(worker.sent).not.toContainEqual({ type: "rerender" });

    worker.emit({ type: "compiling", id: 2 });
    emitResult(worker, 2, fullRender("p1"));
    expect(client.getState()).toMatchObject({ status: "idle", error: null });
  });

  it("explains a failed renderer load and rerenders once back online", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { worker, client } = setup();
    worker.take();

    worker.emit({ type: "compiling", id: 1 });
    worker.emit({
      type: "result",
      id: 1,
      mainPath: "/main.typ",
      diagnostics: [],
      renderError: { kind: "load", message: "TypeError: Failed to fetch" },
      compileMs: 1,
      renderMs: 0,
    });
    expect(client.getState().status).toBe("error");
    expect(client.getState().error).toMatch(/Could not load the preview/);
    // Rerendering now would only fail the same way.
    expect(worker.take()).not.toContainEqual({ type: "rerender" });

    window.dispatchEvent(new Event("online"));
    expect(worker.take()).toContainEqual({ type: "rerender" });

    worker.emit({
      type: "render",
      mainPath: "/main.typ",
      render: fullRender("p1"),
      renderMs: 1,
    });
    expect(client.getState()).toMatchObject({ status: "idle", error: null });
    expect(client.getState().document?.pages.map((p) => p.tid)).toEqual(["p1"]);
  });

  it("stops waiting for the connection once disposed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { worker, client } = setup();
    worker.emit({ type: "compiling", id: 1 });
    worker.emit({
      type: "result",
      id: 1,
      mainPath: "/main.typ",
      diagnostics: [],
      renderError: { kind: "load", message: "Failed to fetch" },
      compileMs: 1,
      renderMs: 0,
    });
    expect(client.getState().status).toBe("error");

    client.dispose();
    worker.take();
    window.dispatchEvent(new Event("online"));
    expect(worker.take()).toEqual([]);
  });

  it("asks for a rerender and a compile on retry", () => {
    const { worker, client } = setup();
    worker.emit({ type: "ready" });
    worker.take();
    client.retry();
    expect(worker.take()).toEqual([
      { type: "rerender" },
      { type: "compile", mainPath: "/main.typ" },
    ]);
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

describe("CompilerClient superseded results", () => {
  const error = {
    path: "/main.typ",
    package: "",
    severity: "error" as const,
    message: "unknown variable: x",
    range: { startLine: 0, startCol: 1, endLine: 0, endCol: 2 },
  };

  it("keeps the diagnostics of the newest compile only", () => {
    const { worker, client } = setup();
    worker.emit({ type: "ready" });
    worker.emit({ type: "compiling", id: 1 });
    worker.emit({ type: "compiling", id: 2 });
    const published = vi.fn();
    client.subscribe(published);
    worker.emit({
      type: "result",
      id: 1,
      mainPath: "/main.typ",
      diagnostics: [error],
      compileMs: 1,
      renderMs: 0,
    });
    expect(published).not.toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ message: error.message })],
      }),
    );
    expect(client.getState()).toMatchObject({
      status: "compiling",
      diagnostics: [],
    });

    emitResult(worker, 2, fullRender("p1"));
    expect(client.getState().status).toBe("idle");
    expect(client.getState().diagnostics).toEqual([]);
  });

  it("drops a result for the previous main file but builds on its render", async () => {
    const { project, worker, client } = setup();
    const other = createFile(project, null, "other.typ", "text");
    setMainFile(project, other);
    project.doc.commit();
    await settle();
    expect(client.getState().mainPath).toBe("other.typ");

    worker.emit({ type: "compiling", id: 1 });
    worker.emit({
      type: "result",
      id: 1,
      mainPath: "/main.typ",
      diagnostics: [error],
      render: fullRender("old"),
      compileMs: 1,
      renderMs: 1,
    });
    expect(client.getState().diagnostics).toEqual([]);
    expect(client.getState().document).toBeNull();

    // The worker diffs against that render, so this one reuses its page.
    worker.emit({ type: "compiling", id: 2 });
    emitResult(worker, 2, deltaRender([], "old"), "/other.typ");
    expect(client.getState().document?.pages.map((p) => p.tid)).toEqual([
      "old",
    ]);
    expect(worker.sent).not.toContainEqual({ type: "rerender" });
  });
});

describe("CompilerClient worker failures", () => {
  function crashSetup() {
    const project = initProject(newProject(1), { title: "T" });
    const workers: FakeWorker[] = [];
    const client = new CompilerClient(project, {
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    workers[0]!.emit({ type: "ready" });
    return { project, client, workers };
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("replaces a crashed worker and mirrors the project into the new one", async () => {
    const { client, workers } = crashSetup();
    const pdf = client.exportPdf();
    await settle();

    workers[0]!.crash();
    await expect(pdf).rejects.toThrow("crashed");
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.sent).toEqual([
      { type: "setText", path: "/main.typ", text: expect.any(String) },
      { type: "compile", mainPath: "/main.typ" },
    ]);
    expect(client.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/crashed/),
    });

    workers[1]!.emit({ type: "ready" });
    expect(client.getState()).toMatchObject({ status: "idle", error: null });
  });

  it("flags a long silent compile without killing the worker", async () => {
    const { client, workers } = crashSetup();
    workers[0]!.emit({ type: "compiling", id: 1 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(client.getState().stalled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.getState()).toMatchObject({
      status: "compiling",
      stalled: true,
      error: null,
    });

    // Like a big package download: slow, but it finishes.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    emitResult(workers[0]!, 1, fullRender("p1"));
    expect(client.getState().stalled).toBe(false);
  });

  it("restarts a stalled worker when asked, without counting it as a crash", async () => {
    const { client, workers } = crashSetup();
    for (let i = 0; i < 2; i++) workers.at(-1)!.crash();
    expect(workers).toHaveLength(3);
    workers[2]!.emit({ type: "ready" });
    workers[2]!.emit({ type: "compiling", id: 1 });
    const pdf = client.exportPdf();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(client.getState().stalled).toBe(true);

    client.retry();
    await expect(pdf).rejects.toThrow("restarted");
    expect(workers[2]!.terminated).toBe(true);
    expect(workers).toHaveLength(4);
    expect(workers[3]!.sent).toContainEqual({
      type: "compile",
      mainPath: "/main.typ",
    });
    expect(client.getState().stalled).toBe(false);

    // Two crashes so far without a finished compile; had the manual restart
    // counted, this third crash would make the client give up.
    workers[3]!.crash();
    expect(workers).toHaveLength(5);
    expect(client.getState().error).toMatch(/Restarting it/);
  });

  it("does not time out while idle", async () => {
    const { workers } = crashSetup();
    workers[0]!.emit({ type: "compiling", id: 1 });
    emitResult(workers[0]!, 1, fullRender("p1"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(workers).toHaveLength(1);
  });

  it("gives up after repeated crashes until retried", async () => {
    const { client, workers } = crashSetup();
    for (let i = 0; i < 4; i++) workers.at(-1)!.crash();
    expect(workers).toHaveLength(4);
    expect(workers[3]!.terminated).toBe(true);
    expect(client.getState().error).toMatch(/4 times in a row/);
    await expect(client.exportPdf()).rejects.toThrow("not running");

    client.retry();
    expect(workers).toHaveLength(5);
    expect(workers[4]!.sent).toContainEqual({
      type: "compile",
      mainPath: "/main.typ",
    });
  });

  it("asks the worker to restart a compiler that failed to start", async () => {
    const project = initProject(newProject(1), { title: "T" });
    const worker = new FakeWorker();
    const client = new CompilerClient(project, {
      worker,
    });
    worker.emit({ type: "initError", message: "TypeError: Failed to fetch" });
    expect(client.getState()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/Failed to fetch/),
    });
    worker.take();

    window.dispatchEvent(new Event("online"));
    expect(worker.take()).toEqual([{ type: "restart" }]);
    worker.emit({ type: "ready" });
    expect(client.getState()).toMatchObject({ status: "idle", error: null });

    // The manual retry does the same.
    worker.emit({ type: "initError", message: "offline" });
    worker.take();
    client.retry();
    expect(worker.take()).toEqual([{ type: "restart" }]);
  });
});

/** A one page render whose blocks are given as [tid, y]. */
const blockRender = (tid: string, ...blocks: [string, number][]) => ({
  rootTag,
  defs: '<defs class="glyph"></defs>',
  pages: [
    {
      tid,
      width: 100,
      height: 200,
      markup: `<g class="typst-page" data-tid="${tid}" data-page-width="100" data-page-height="200"><g class="typst-group">${blocks
        .map(([t, y]) => `<g transform="translate(0, ${y})" data-tid="${t}"/>`)
        .join("")}</g></g>`,
    },
  ],
});

const typeInto = (project: ProjectDoc, at = 0) => {
  getText(project, mainId(project)).insert(at, "x");
  project.doc.commit();
};

describe("CompilerClient following edits", () => {
  const compileWith = (
    worker: FakeWorker,
    id: number,
    render: RenderPayload,
  ) => {
    worker.emit({ type: "compiling", id });
    emitResult(worker, id, render);
  };

  it("reports where the document changed after a local edit", async () => {
    const { project, worker, client } = setup();
    worker.emit({ type: "ready" });
    compileWith(worker, 1, blockRender("p1", ["a", 10], ["b", 50]));
    expect(client.getState().follow).toBeNull();

    typeInto(project);
    await settle();
    compileWith(worker, 2, blockRender("p2", ["a", 10], ["B", 50]));
    expect(client.getState().follow).toEqual({
      seq: 1,
      changes: [{ page: 0, top: 50, bottom: 200 }],
    });

    typeInto(project);
    await settle();
    compileWith(worker, 3, blockRender("p3", ["A", 10], ["B", 50]));
    expect(client.getState().follow?.seq).toBe(2);
  });

  it("ignores changes nobody edited for", async () => {
    const { project, worker, client } = setup();
    worker.emit({ type: "ready" });
    compileWith(worker, 1, blockRender("p1", ["a", 10]));
    // A font or asset finishing loading changes the output without an edit.
    await vi.advanceTimersByTimeAsync(5000);
    compileWith(worker, 2, blockRender("p2", ["A", 10]));
    expect(client.getState().follow).toBeNull();

    // An edit that was compiled long ago does not claim later changes.
    typeInto(project);
    await settle();
    compileWith(worker, 3, blockRender("p3", ["a", 10]));
    expect(client.getState().follow?.seq).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    compileWith(worker, 4, blockRender("p4", ["b", 10]));
    expect(client.getState().follow?.seq).toBe(1);
  });

  it("does not follow a collaborator's edits", async () => {
    const { project, worker, client } = setup();
    worker.emit({ type: "ready" });
    compileWith(worker, 1, blockRender("p1", ["a", 10]));
    await vi.advanceTimersByTimeAsync(5000);

    const remote = fork(project, 2);
    typeInto(remote);
    sync(project, remote);
    await settle();
    compileWith(worker, 2, blockRender("p2", ["A", 10]));
    expect(client.getState().follow).toBeNull();
  });

  describe("animation kind", () => {
    const shown = async (edit: (project: ProjectDoc) => void) => {
      const { project, worker, client } = setup();
      worker.emit({ type: "ready" });
      compileWith(worker, 1, blockRender("p1", ["a", 10], ["b", 50]));
      expect(client.getState().animation).toBeNull();
      edit(project);
      await settle();
      compileWith(worker, 2, blockRender("p2", ["a", 10], ["B", 50]));
      return { client, worker, project };
    };

    it("calls the user's own edit typed", async () => {
      const { client } = await shown((p) => typeInto(p));
      expect(client.getState().animation).toEqual({
        seq: 1,
        kind: "typed",
        changes: [{ page: 0, top: 50, bottom: 200 }],
      });
    });

    it("calls a folder sync commit external but still follows it", async () => {
      const { client } = await shown((p) => {
        getText(p, mainId(p)).insert(0, "x");
        p.doc.commit({ origin: FOLDER_ORIGIN });
      });
      expect(client.getState().animation?.kind).toBe("external");
      expect(client.getState().follow?.seq).toBe(1);
    });

    it("calls a collaborator's edit external", async () => {
      const { project, worker, client } = setup();
      worker.emit({ type: "ready" });
      compileWith(worker, 1, blockRender("p1", ["a", 10]));
      await vi.advanceTimersByTimeAsync(5000);
      const remote = fork(project, 2);
      typeInto(remote);
      sync(project, remote);
      await settle();
      compileWith(worker, 2, blockRender("p2", ["A", 10]));
      expect(client.getState().animation?.kind).toBe("external");
      expect(client.getState().follow).toBeNull();
    });

    it("prefers typed when both happened before the result", async () => {
      const { project, worker, client } = setup();
      worker.emit({ type: "ready" });
      compileWith(worker, 1, blockRender("p1", ["a", 10]));
      const remote = fork(project, 2);
      typeInto(remote);
      sync(project, remote);
      typeInto(project);
      await settle();
      compileWith(worker, 2, blockRender("p2", ["A", 10]));
      expect(client.getState().animation?.kind).toBe("typed");
    });

    it("clears the animation when nobody edited for a change", async () => {
      const { client, worker } = await shown((p) => typeInto(p));
      await vi.advanceTimersByTimeAsync(5000);
      compileWith(worker, 3, blockRender("p3", ["A", 10], ["B", 50]));
      expect(client.getState().animation).toBeNull();
    });
  });

  it("carries the changes of superseded results into the next one", async () => {
    const { project, worker, client } = setup();
    worker.emit({ type: "ready" });
    compileWith(worker, 1, blockRender("p1", ["a", 10], ["b", 50]));

    typeInto(project);
    await settle();
    worker.emit({ type: "compiling", id: 2 });
    worker.emit({ type: "compiling", id: 3 });
    emitResult(worker, 2, blockRender("p2", ["A", 10], ["b", 50]));
    emitResult(worker, 3, blockRender("p3", ["A", 10], ["b", 50], ["c", 90]));
    // Two separate spots on the page stay two ranges.
    expect(client.getState().follow?.changes).toEqual([
      { page: 0, top: 10, bottom: 50 },
      { page: 0, top: 90, bottom: 200 },
    ]);
  });
});

describe("CompilerClient error settling", () => {
  const typo = {
    path: "/main.typ",
    package: "",
    severity: "error" as "error" | "warning",
    message: "unclosed delimiter",
    range: { startLine: 0, startCol: 1, endLine: 0, endCol: 2 },
  };
  const warning = { ...typo, severity: "warning" as const, message: "w" };
  type Diagnostic = typeof typo;

  let nextId = 1;
  const compileWith = (
    worker: FakeWorker,
    diagnostics: Diagnostic[],
    render?: RenderPayload,
  ) => {
    const id = nextId++;
    worker.emit({ type: "compiling", id });
    worker.emit({
      type: "result",
      id,
      mainPath: "/main.typ",
      diagnostics,
      ...(render ? { render } : {}),
      compileMs: 4,
      renderMs: 0,
    });
  };

  async function started() {
    nextId = 1;
    const ctx = setup();
    ctx.worker.emit({ type: "ready" });
    compileWith(ctx.worker, [warning], fullRender("p1"));
    return ctx;
  }

  it("holds new errors back while the user types, then publishes them", async () => {
    const { project, worker, client } = await started();
    typeInto(project);
    await settle();
    const before = client.getState();

    await vi.advanceTimersByTimeAsync(200);
    compileWith(worker, [typo, warning]);
    expect(client.getState().diagnostics).toBe(before.diagnostics);
    expect(client.getState().status).toBe("idle");
    expect(client.getState().document).toBe(before.document);

    // The deadline counts from the last edit, so another keystroke moves it.
    await vi.advanceTimersByTimeAsync(700);
    typeInto(project);
    await settle();
    await vi.advanceTimersByTimeAsync(900);
    expect(client.getState().status).toBe("idle");

    await vi.advanceTimersByTimeAsync(100);
    expect(client.getState().status).toBe("error");
    expect(client.getState().diagnostics).toEqual([
      expect.objectContaining({ message: "unclosed delimiter" }),
      expect.objectContaining({ message: "w" }),
    ]);
    expect(client.getState().compileMs).toBe(4);
  });

  it("shows errors right away when typing has paused", async () => {
    const { project, worker, client } = await started();
    typeInto(project);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    compileWith(worker, [typo]);
    expect(client.getState().status).toBe("error");
  });

  it("shows fixes, and changes to warnings alone, immediately", async () => {
    const { project, worker, client } = await started();
    typeInto(project);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    compileWith(worker, [typo]);
    expect(client.getState().status).toBe("error");

    typeInto(project);
    await settle();
    // Same error, different warnings.
    compileWith(worker, [typo, warning]);
    expect(client.getState().diagnostics).toHaveLength(2);
    // The error goes away mid-typing.
    compileWith(worker, [warning], fullRender("p2"));
    expect(client.getState().status).toBe("idle");
    expect(client.getState().diagnostics).toEqual([
      expect.objectContaining({ message: "w" }),
    ]);

    // A fix also cancels an error that was still held back.
    typeInto(project);
    await settle();
    compileWith(worker, [typo]);
    compileWith(worker, [], fullRender("p3"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.getState().status).toBe("idle");
    expect(client.getState().diagnostics).toEqual([]);
  });

  it("holds errors back while assets load, and drops them when the load fixes them", async () => {
    nextId = 1;
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
    });
    worker.emit({ type: "ready" });
    // The first compile runs before the image is there.
    compileWith(worker, [{ ...typo, message: "file not found" }]);
    expect(client.getState().status).not.toBe("error");
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getState().diagnostics).toEqual([]);

    finish(new Uint8Array([1]));
    await settle();
    compileWith(worker, [], fullRender("p1"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.getState().status).toBe("idle");
    expect(client.getState().diagnostics).toEqual([]);
  });

  it("shows held errors after a load that failed", async () => {
    nextId = 1;
    const project = initProject(newProject(1), { title: "T" });
    createAsset(project, null, "logo.png", {
      hash: "abc",
      size: 3,
      mime: "image/png",
    });
    const worker = new FakeWorker();
    let fail!: (err: Error) => void;
    const client = new CompilerClient(project, {
      worker,
      assetLoader: () => new Promise((_, reject) => (fail = reject)),
    });
    worker.emit({ type: "ready" });
    compileWith(worker, [{ ...typo, message: "file not found" }]);
    expect(client.getState().status).not.toBe("error");

    vi.spyOn(console, "error").mockImplementation(() => {});
    fail(new Error("offline"));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getState().status).toBe("error");
    expect(client.getState().diagnostics).toEqual([
      expect.objectContaining({ message: "file not found" }),
    ]);
  });

  it("does not hold errors back for a collaborator's typing", async () => {
    const { project, worker, client } = await started();
    const remote = fork(project, 2);
    typeInto(remote);
    sync(project, remote);
    await settle();
    compileWith(worker, [typo]);
    expect(client.getState().status).toBe("error");
  });

  it("keeps the diagnostics array when nothing changed", async () => {
    const { project, worker, client } = await started();
    const shown = client.getState().diagnostics;
    typeInto(project);
    await settle();
    compileWith(worker, [warning]);
    expect(client.getState().diagnostics).toBe(shown);
  });
});

function pkgRecord(hash: string, name = "hello"): PackageRecord {
  return {
    namespace: "local",
    name,
    version: "0.1.0",
    hash,
    size: 3,
    mime: "application/gzip",
    entrypoint: "lib.typ",
    fileCount: 1,
    unpackedSize: 10,
    source: "upload",
    addedAt: 0,
  };
}

describe("CompilerClient packages", () => {
  function pkgSetup(createWorker?: () => FakeWorker) {
    const project = initProject(newProject(1), { title: "T" });
    const workers: FakeWorker[] = [];
    const loader = vi.fn(async (hash: string) =>
      new TextEncoder().encode(hash),
    );
    const client = new CompilerClient(project, {
      createWorker: () => {
        const w = createWorker?.() ?? new FakeWorker();
        workers.push(w);
        return w;
      },
      assetLoader: loader,
    });
    workers[0]!.take();
    const sentOf = <T extends WorkerRequest["type"]>(type: T, i = 0) =>
      workers[i]!.take().filter(
        (m): m is Extract<WorkerRequest, { type: T }> => m.type === type,
      );
    return { project, client, workers, loader, sentOf };
  }

  const decode = (data: Uint8Array) => new TextDecoder().decode(data);

  it("sends a package with its buffer transferred and compiles", async () => {
    const { project, workers, loader } = pkgSetup();
    putPackage(project, pkgRecord("h1"));
    await settle();
    expect(loader).toHaveBeenCalledWith("h1", "local/hello/0.1.0.tar.gz");
    const w = workers[0]!;
    const i = w.sent.findIndex((m) => m.type === "setPackage");
    const msg = w.sent[i]!;
    expect(msg).toMatchObject({
      type: "setPackage",
      key: "local/hello/0.1.0",
      hash: "h1",
    });
    if (msg.type !== "setPackage") return;
    expect(decode(msg.data)).toBe("h1");
    expect(w.transfers[i]).toEqual([msg.data.buffer]);
    expect(w.sent.slice(i + 1)).toContainEqual({
      type: "compile",
      mainPath: "/main.typ",
    });
  });

  it("sends the replacement when the archive changes, and a removal when it goes", async () => {
    const { project, sentOf } = pkgSetup();
    putPackage(project, pkgRecord("h1"));
    await settle();
    sentOf("setPackage");

    putPackage(project, pkgRecord("h2"));
    await settle();
    expect(sentOf("setPackage").map((m) => [m.hash, decode(m.data)])).toEqual([
      ["h2", "h2"],
    ]);

    deletePackage(project, "local/hello/0.1.0");
    await settle();
    const sent = sentOf("removePackage");
    expect(sent).toEqual([{ type: "removePackage", key: "local/hello/0.1.0" }]);
  });

  it("retries a failed package load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { project, loader, sentOf } = pkgSetup();
    loader.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    putPackage(project, pkgRecord("h1"));
    await settle();
    expect(sentOf("setPackage")).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(sentOf("setPackage")).toHaveLength(1);
  });

  it("loads failed packages again on refreshAssets", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { project, client, loader, sentOf } = pkgSetup();
    loader.mockRejectedValueOnce(new Error("link expired"));
    putPackage(project, pkgRecord("h1"));
    await settle();
    client.refreshAssets();
    await settle();
    expect(sentOf("setPackage")).toHaveLength(1);
  });

  it("holds a PDF export until the package is loaded", async () => {
    const project = initProject(newProject(1), { title: "T" });
    putPackage(project, pkgRecord("h1"));
    const worker = new FakeWorker();
    let finish!: (data: Uint8Array) => void;
    const client = new CompilerClient(project, {
      worker,
      assetLoader: () => new Promise((resolve) => (finish = resolve)),
    });
    worker.take();
    const pdf = client.exportPdf();
    await settle();
    expect(worker.take().map((m) => m.type)).not.toContain("exportPdf");

    finish(new Uint8Array([1]));
    await settle();
    const sent = worker.take().map((m) => m.type);
    expect(sent.indexOf("exportPdf")).toBeGreaterThan(
      sent.indexOf("setPackage"),
    );
    worker.emit({ type: "pdf", id: 1, data: new Uint8Array([9]) });
    await expect(pdf).resolves.toEqual(new Uint8Array([9]));
  });

  it("sends every package again to a replacement worker", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { project, workers, loader } = pkgSetup();
    putPackage(project, pkgRecord("h1"));
    putPackage(project, pkgRecord("h2", "other"));
    await settle();
    loader.mockClear();

    workers[0]!.crash();
    await settle();
    expect(workers).toHaveLength(2);
    // The old worker took the buffers, so they are loaded afresh.
    expect(loader).toHaveBeenCalledTimes(2);
    expect(
      workers[1]!.sent
        .filter((m) => m.type === "setPackage")
        .map((m) => (m.type === "setPackage" ? m.key : ""))
        .sort(),
    ).toEqual(["local/hello/0.1.0", "local/other/0.1.0"]);
  });
});

describe("CompilerClient font bundles", () => {
  function bundleSetup() {
    const project = initProject(newProject(1), { title: "T" });
    const workers: FakeWorker[] = [];
    const client = new CompilerClient(project, {
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      assetLoader: async (hash) => new TextEncoder().encode(hash),
    });
    workers[0]!.take();
    const reinits = (i = 0) =>
      workers[i]!.take().filter(
        (m): m is Extract<WorkerRequest, { type: "reinit" }> =>
          m.type === "reinit",
      );
    return { project, client, workers, reinits };
  }

  it("reinits with the enabled bundles and drops them again", async () => {
    const { project, reinits } = bundleSetup();
    setFontBundle(project, "cjk", true);
    await settle();
    expect(reinits().map((m) => m.fonts.assets)).toEqual([["text", "cjk"]]);

    setFontBundle(project, "emoji", true);
    await settle();
    expect(reinits().map((m) => m.fonts.assets)).toEqual([
      ["text", "cjk", "emoji"],
    ]);

    setFontBundle(project, "cjk", false);
    setFontBundle(project, "emoji", false);
    await settle();
    expect(reinits().map((m) => m.fonts.assets)).toEqual([["text"]]);
  });

  it("merges the bundles with a manual reinit", async () => {
    const project = initProject(newProject(1), { title: "T" });
    setFontBundle(project, "emoji", true);
    const worker = new FakeWorker();
    const client = new CompilerClient(project, {
      worker,
      assetLoader: async () => new Uint8Array(),
    });
    await settle();
    worker.take();
    client.reinit({ assets: ["text", "cjk"] });
    await settle();
    const msg = worker.take().find((m) => m.type === "reinit");
    expect(msg?.type === "reinit" && msg.fonts.assets).toEqual([
      "text",
      "cjk",
      "emoji",
    ]);
  });

  it("asks a replacement worker for the bundles too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { project, workers, reinits } = bundleSetup();
    setFontBundle(project, "cjk", true);
    await settle();
    reinits();
    workers[0]!.crash();
    await settle();
    expect(reinits(1).map((m) => m.fonts.assets)).toEqual([["text", "cjk"]]);
  });

  it("shows the worker's font warning until a compiler loads the fonts", () => {
    const worker = new FakeWorker();
    const client = new CompilerClient(
      initProject(newProject(1), { title: "T" }),
      { worker },
    );
    expect(client.getState().fontWarning).toBeNull();
    worker.emit({ type: "ready", fontWarning: "no CJK" });
    expect(client.getState().fontWarning).toBe("no CJK");
    worker.emit({ type: "ready" });
    expect(client.getState().fontWarning).toBeNull();
  });

  it("loads the bundles again on retry after a font warning", async () => {
    const { project, client, workers, reinits } = bundleSetup();
    setFontBundle(project, "cjk", true);
    await settle();
    reinits();
    workers[0]!.emit({ type: "ready", fontWarning: "no CJK" });
    client.retry();
    await settle();
    expect(reinits().map((m) => m.fonts.assets)).toEqual([["text", "cjk"]]);
  });
});

describe("CompilerClient jumps", () => {
  it("answers each jump with the response carrying its id", async () => {
    const { worker, client } = setup();
    worker.take();
    const first = client.jumpFromClick(1, 20, 30);
    const second = client.jumpFromClick(0, 5, 6);
    const [a, b] = worker.take();
    expect(a).toEqual({ type: "jumpFromClick", id: 1, page: 1, x: 20, y: 30 });
    expect(b).toMatchObject({ type: "jumpFromClick", id: 2 });

    // Out of order, and with an id nobody waits for in between.
    worker.emit({ type: "jump", id: 7, target: null });
    worker.emit({
      type: "jump",
      id: 2,
      target: { kind: "url", url: "https://example.com" },
    });
    worker.emit({
      type: "jump",
      id: 1,
      target: { kind: "position", page: 1, x: 3, y: 4 },
    });
    await expect(second).resolves.toEqual({
      kind: "url",
      url: "https://example.com",
    });
    await expect(first).resolves.toEqual({
      kind: "position",
      page: 1,
      x: 3,
      y: 4,
    });
  });

  it("turns typst paths into project paths and keeps package files apart", async () => {
    const { worker, client } = setup();
    worker.take();
    const local = client.jumpFromClick(0, 1, 1);
    const pkg = client.jumpFromClick(0, 2, 2);
    worker.emit({
      type: "jump",
      id: 1,
      target: {
        kind: "source",
        path: "/chapters/intro.typ",
        package: "",
        offset: 12,
      },
    });
    worker.emit({
      type: "jump",
      id: 2,
      target: {
        kind: "source",
        path: "/lib.typ",
        package: "@preview/cetz:0.3.4",
        offset: 3,
      },
    });
    await expect(local).resolves.toEqual({
      kind: "source",
      path: "chapters/intro.typ",
      offset: 12,
    });
    await expect(pkg).resolves.toEqual({
      kind: "package",
      package: "@preview/cetz:0.3.4",
      path: "/lib.typ",
      offset: 3,
    });
  });

  it("asks for cursor jumps with the typst path", async () => {
    const { worker, client } = setup();
    worker.take();
    const positions = client.jumpFromCursor("chapters/intro.typ", 40);
    expect(worker.take()).toEqual([
      {
        type: "jumpFromCursor",
        id: 1,
        path: "/chapters/intro.typ",
        offset: 40,
      },
    ]);
    worker.emit({
      type: "jumpPositions",
      id: 1,
      positions: [{ page: 2, x: 10, y: 20 }],
    });
    await expect(positions).resolves.toEqual([{ page: 2, x: 10, y: 20 }]);
  });

  it("settles pending jumps as nothing on dispose", async () => {
    const { worker, client } = setup();
    const click = client.jumpFromClick(0, 1, 1);
    const cursor = client.jumpFromCursor("main.typ", 0);
    client.dispose();
    await expect(click).resolves.toBeNull();
    await expect(cursor).resolves.toEqual([]);
    // A late answer from the old worker changes nothing.
    worker.emit({ type: "jump", id: 1, target: null });
    await expect(client.jumpFromClick(0, 1, 1)).resolves.toBeNull();
  });

  it("settles pending jumps as nothing when the worker is replaced", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const project = initProject(newProject(1), { title: "T" });
    const workers: FakeWorker[] = [];
    const client = new CompilerClient(project, {
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    workers[0]!.emit({ type: "ready" });
    const beforeCrash = client.jumpFromCursor("main.typ", 0);
    workers[0]!.crash();
    await expect(beforeCrash).resolves.toEqual([]);

    // A user restart of a stalled worker drops them too.
    workers[1]!.emit({ type: "ready" });
    workers[1]!.emit({ type: "compiling", id: 1 });
    await vi.advanceTimersByTimeAsync(61_000);
    const beforeRestart = client.jumpFromClick(0, 1, 1);
    client.retry();
    await expect(beforeRestart).resolves.toBeNull();
    expect(workers).toHaveLength(3);
  });
});
