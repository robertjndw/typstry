import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { ProjectAssets } from "@/assets/project-assets";
import {
  createAsset,
  createFile,
  deleteNode,
  getText,
  rename,
} from "@/doc/fs-ops";
import { initProject, type PackageRecord } from "@/doc/schema";
import { deletePackage, putPackage } from "@/packages/records";
import { newProject } from "@/doc/test-utils";

import type { TinymistRequest, TinymistResponse } from "./protocol";
import { TinymistClient, type TinymistWorker } from "./tinymist-client";

const ROOT = "file:///project/";

class FakeWorker {
  sent: { message: TinymistRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  private listeners = new Map<string, Set<(e: never) => void>>();
  postMessage(message: TinymistRequest, transfer: Transferable[] = []) {
    this.sent.push({ message, transfer });
  }
  addEventListener(type: string, l: (e: never) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(l);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, l: (e: never) => void) {
    this.listeners.get(type)?.delete(l);
  }
  terminate() {
    this.terminated = true;
  }
  emit(message: TinymistResponse) {
    for (const l of this.listeners.get("message") ?? [])
      (l as (e: MessageEvent<TinymistResponse>) => void)({
        data: message,
      } as MessageEvent<TinymistResponse>);
  }
  crash() {
    for (const l of this.listeners.get("error") ?? [])
      (l as (e: Event) => void)(new Event("error"));
  }
  /** File messages sent so far, LSP traffic left out; clears the log. */
  takeFiles() {
    const out = this.sent.filter((s) => s.message.type !== "lsp");
    this.sent = [];
    return out;
  }
}

const decode = (m: TinymistRequest) =>
  m.type === "setFile" ? new TextDecoder().decode(m.data) : undefined;

function setup(assets: ProjectAssets | null = null) {
  const project = initProject(newProject(1), { title: "T" });
  const other = createFile(project, null, "other.typ", "text", "Other");
  const worker = new FakeWorker();
  const client = new TinymistClient(project, assets, {
    worker: worker as unknown as TinymistWorker,
  });
  return { project, other, worker, client };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TinymistClient file mirror", () => {
  it("leaves files open in an editor to the LSP client until they close", async () => {
    const { project, other, worker, client } = setup();
    worker.takeFiles();
    const view = new EditorView({
      state: EditorState.create({ extensions: client.plugin("main.typ") }),
    });

    const main = getText(project, project.mainFile!);
    main.insert(0, "x");
    getText(project, other).insert(0, "y");
    project.doc.commit();
    await vi.advanceTimersByTimeAsync(200);
    let sent = worker.takeFiles();
    expect(
      sent.map((s) => s.message.type === "setFile" && s.message.uri),
    ).toEqual([`${ROOT}other.typ`]);
    expect(decode(sent[0]!.message)).toBe("yOther");
    // Encoded just for the message, so the buffer moves instead of copying.
    expect(sent[0]!.transfer).toHaveLength(1);

    view.destroy();
    await vi.advanceTimersByTimeAsync(200);
    sent = worker.takeFiles();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({
      type: "setFile",
      uri: `${ROOT}main.typ`,
    });
    expect(decode(sent[0]!.message)).toBe(main.toString());
    client.dispose();
  });

  it("holds edits while paused", async () => {
    const { project, worker, client } = setup();
    worker.takeFiles();
    client.pause();
    getText(project, project.mainFile!).insert(0, "x");
    project.doc.commit();
    await vi.advanceTimersByTimeAsync(500);
    expect(worker.takeFiles()).toEqual([]);

    client.resume();
    await vi.advanceTimersByTimeAsync(200);
    expect(worker.takeFiles().map((s) => s.message.type)).toEqual(["setFile"]);
    client.dispose();
  });

  it("removes old files before writing ones that took their path", async () => {
    const { project, other, worker, client } = setup();
    const third = createFile(project, null, "third.typ", "text", "Third");
    await vi.advanceTimersByTimeAsync(200);
    worker.takeFiles();

    // Within one sync window: other.typ goes away and third.typ takes its
    // name. The worker must end up holding third.typ's text there.
    deleteNode(project, other);
    rename(project, third, "other.typ");
    await vi.advanceTimersByTimeAsync(200);
    const sent = worker.takeFiles().map((s) => s.message);
    const removed = sent
      .slice(0, 2)
      .map((m) => m.type === "removeFile" && m.uri);
    expect(removed.sort()).toEqual([`${ROOT}other.typ`, `${ROOT}third.typ`]);
    expect(sent.slice(2)).toMatchObject([
      { type: "setFile", uri: `${ROOT}other.typ` },
    ]);
    expect(decode(sent[2]!)).toBe("Third");
    client.dispose();
  });
});

describe("TinymistClient assets", () => {
  it("retries an asset tinymist asked for when loading it failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return new Uint8Array([7]);
    });
    const assets = { load, store: vi.fn() } as unknown as ProjectAssets;
    const { project, worker, client } = setup(assets);
    createAsset(project, null, "logo.png", {
      hash: "h",
      size: 1,
      mime: "image/png",
    });
    await vi.advanceTimersByTimeAsync(200);
    worker.takeFiles();

    worker.emit({ type: "needFile", uri: `${ROOT}logo.png` });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(worker.takeFiles()).toEqual([]);

    fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(worker.takeFiles().map((s) => s.message)).toEqual([
      { type: "setFile", uri: `${ROOT}logo.png`, data: new Uint8Array([7]) },
    ]);
    client.dispose();
  });

  it("retries a replaced asset when its new version fails to load too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const load = vi.fn(async (hash: string) => {
      if (fail) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(hash);
    });
    const assets = { load, store: vi.fn() } as unknown as ProjectAssets;
    const { project, worker, client } = setup(assets);
    const logo = createAsset(project, null, "logo.png", {
      hash: "old",
      size: 1,
      mime: "image/png",
    });
    await vi.advanceTimersByTimeAsync(200);
    worker.emit({ type: "needFile", uri: `${ROOT}logo.png` });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    deleteNode(project, logo);
    createAsset(project, null, "logo.png", {
      hash: "new",
      size: 1,
      mime: "image/png",
    });
    await vi.advanceTimersByTimeAsync(200);
    worker.takeFiles();

    fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    const sent = worker.takeFiles().map((s) => s.message);
    expect(sent.map((m) => decode(m))).toEqual(["new"]);
    client.dispose();
  });
});

describe("TinymistClient worker failures", () => {
  it("replaces a failed worker once, then reports language features as unavailable", async () => {
    const { toast } = await import("sonner");
    const warning = vi.spyOn(toast, "warning").mockImplementation(() => 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const project = initProject(newProject(1), { title: "T" });
    const workers: FakeWorker[] = [];
    const client = new TinymistClient(project, null, {
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as TinymistWorker;
      },
    });

    workers[0]!.emit({ type: "initError", message: "no wasm" });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    // The new worker gets the project again and a fresh LSP handshake.
    const sent = workers[1]!.sent.map((s) => s.message);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "setFile", uri: `${ROOT}main.typ` }),
    );
    expect(
      sent.some((m) => m.type === "lsp" && m.message.includes('"initialize"')),
    ).toBe(true);
    expect(warning).not.toHaveBeenCalled();

    workers[1]!.crash();
    expect(workers[1]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(warning).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});

describe("TinymistClient packages", () => {
  const record = (hash: string): PackageRecord => ({
    namespace: "local",
    name: "demo",
    version: "1.0.0",
    hash,
    size: 1,
    mime: "application/gzip",
    entrypoint: "lib.typ",
    fileCount: 1,
    unpackedSize: 1,
    source: "upload",
    addedAt: 0,
  });
  const key = "local/demo/1.0.0";
  const packageMessages = (worker: FakeWorker) =>
    worker.sent
      .map((s) => s.message)
      .filter((m) => m.type === "setPackage" || m.type === "removePackage");

  function setupWithWorkers() {
    const load = vi.fn(async (hash: string) => new TextEncoder().encode(hash));
    const assets = { load, store: vi.fn() } as unknown as ProjectAssets;
    const project = initProject(newProject(1), { title: "T" });
    const workers: FakeWorker[] = [];
    const client = new TinymistClient(project, assets, {
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as TinymistWorker;
      },
    });
    return { project, workers, client, load };
  }

  it("sends packages already in the project without restarting", async () => {
    const project = initProject(newProject(1), { title: "T" });
    putPackage(project, record("h1"));
    const workers: FakeWorker[] = [];
    const assets = {
      load: async (hash: string) => new TextEncoder().encode(hash),
    } as unknown as ProjectAssets;
    const client = new TinymistClient(project, assets, {
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as TinymistWorker;
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(workers).toHaveLength(1);
    expect(packageMessages(workers[0]!)).toMatchObject([
      { type: "setPackage", key, hash: "h1" },
    ]);
    client.dispose();
  });

  it("restarts quietly once, debounced, when the package set changes", async () => {
    const { project, workers, client } = setupWithWorkers();
    putPackage(project, record("h1"));
    await vi.advanceTimersByTimeAsync(200);
    expect(packageMessages(workers[0]!)).toHaveLength(1);
    expect(workers).toHaveLength(1);

    putPackage(project, { ...record("h2"), name: "other" });
    await vi.advanceTimersByTimeAsync(200);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);

    // The new worker gets both packages, the files, and a new handshake.
    const sent = workers[1]!.sent.map((s) => s.message);
    expect(packageMessages(workers[1]!)).toHaveLength(2);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "setFile", uri: `${ROOT}main.typ` }),
    );
    expect(
      sent.some((m) => m.type === "lsp" && m.message.includes('"initialize"')),
    ).toBe(true);

    // The failure budget is untouched: one crash still gets a worker.
    vi.spyOn(console, "error").mockImplementation(() => {});
    workers[1]!.crash();
    expect(workers).toHaveLength(3);
    client.dispose();
  });

  it("tells the worker about a removed package and restarts", async () => {
    const { project, workers, client } = setupWithWorkers();
    putPackage(project, record("h1"));
    await vi.advanceTimersByTimeAsync(200);
    deletePackage(project, "local/demo/1.0.0");
    await vi.advanceTimersByTimeAsync(200);
    expect(packageMessages(workers[0]!).map((m) => m.type)).toEqual([
      "setPackage",
      "removePackage",
    ]);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(workers).toHaveLength(2);
    expect(packageMessages(workers[1]!)).toEqual([]);
    client.dispose();
  });

  it("retries a package archive that failed to load, then restarts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { project, workers, client, load } = setupWithWorkers();
    load.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    putPackage(project, record("h1"));
    await vi.advanceTimersByTimeAsync(200);
    expect(packageMessages(workers[0]!)).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(packageMessages(workers[0]!)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(workers).toHaveLength(2);
    client.dispose();
  });
});
