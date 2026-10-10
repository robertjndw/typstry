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
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";

import type { TinymistRequest, TinymistResponse } from "./protocol";
import { TinymistClient, type TinymistWorker } from "./tinymist-client";

const ROOT = "file:///project/";

class FakeWorker {
  sent: { message: TinymistRequest; transfer: Transferable[] }[] = [];
  private listeners = new Set<(e: MessageEvent<TinymistResponse>) => void>();
  postMessage(message: TinymistRequest, transfer: Transferable[] = []) {
    this.sent.push({ message, transfer });
  }
  addEventListener(
    _type: "message",
    l: (e: MessageEvent<TinymistResponse>) => void,
  ) {
    this.listeners.add(l);
  }
  removeEventListener(
    _type: "message",
    l: (e: MessageEvent<TinymistResponse>) => void,
  ) {
    this.listeners.delete(l);
  }
  terminate() {}
  emit(message: TinymistResponse) {
    for (const l of this.listeners)
      l({ data: message } as MessageEvent<TinymistResponse>);
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
