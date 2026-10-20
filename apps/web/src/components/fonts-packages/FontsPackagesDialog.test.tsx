import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { zipSync } from "fflate";

import type { ProjectAssets } from "@/assets/project-assets";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createAsset, getText } from "@/doc/fs-ops";
import { initProject, type PackageRecord, type ProjectDoc } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";
import { buildSfnt, type FontSpec } from "@/fonts/font-fixtures";
import { PackageError } from "@/packages/errors";
import { gzipDeterministic } from "@/packages/gzip";
import { putPackage } from "@/packages/records";
import { writeTar } from "@/packages/tar";
import { ProjectProvider } from "@/project/ProjectProvider";

import FontsPackagesDialog from "./FontsPackagesDialog";
import type { FontsPackagesTarget } from "./types";

const uploadFiles = vi.hoisted(() => vi.fn());
vi.mock("@/assets/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/assets/upload")>()),
  uploadFiles,
}));

const fetchUniverse = vi.hoisted(() => vi.fn());
vi.mock("@/packages/universe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/packages/universe")>()),
  fetchUniverse,
}));

const enc = new TextEncoder();
const MANIFEST = `[package]
name = "hello"
version = "0.1.0"
entrypoint = "lib.typ"
description = "Says hi"
license = "MIT"
`;

function font(family: string, weight: number): Uint8Array {
  const spec: FontSpec = {
    names: [{ id: 1, text: family }],
    os2: { weight, width: 5, selection: 0 },
  };
  return buildSfnt(spec);
}

function zipFile(name = "hello.zip"): File {
  const bytes = zipSync({
    "typst.toml": enc.encode(MANIFEST),
    "lib.typ": enc.encode("#let hi = [Hello]"),
  });
  return new File([bytes as Uint8Array<ArrayBuffer>], name);
}

function record(over: Partial<PackageRecord> = {}): PackageRecord {
  return {
    namespace: "local",
    name: "hello",
    version: "0.1.0",
    hash: "h-hello",
    size: 100,
    mime: "application/gzip",
    entrypoint: "lib.typ",
    description: "Says hi",
    license: "MIT",
    fileCount: 2,
    unpackedSize: 2048,
    source: "upload",
    addedAt: 1,
    ...over,
  };
}

function fakeAssets(blobs = new Map<string, Uint8Array>()) {
  let n = 0;
  const assets: ProjectAssets = {
    load: vi.fn(async (hash: string) => blobs.get(hash) ?? new Uint8Array()),
    store: vi.fn(async (file: File) => ({
      hash: `stored-${++n}`,
      size: file.size,
      mime: file.type,
    })),
  };
  return assets;
}

function renderDialog(
  project: ProjectDoc,
  {
    assets,
    readOnly = false,
    target = { tab: "fonts" },
  }: {
    assets?: ProjectAssets | null;
    readOnly?: boolean;
    target?: FontsPackagesTarget;
  } = {},
) {
  const onClose = vi.fn();
  render(
    <TooltipProvider>
      <ProjectProvider
        doc={project}
        readOnly={readOnly}
        assets={assets === null ? undefined : (assets ?? fakeAssets())}
      >
        <FontsPackagesDialog open={target} onClose={onClose} />
      </ProjectProvider>
      <Toaster />
    </TooltipProvider>,
  );
  return { onClose };
}

function newDoc() {
  return initProject(newProject(1), { title: "T" });
}

function pick(label: string, file: File) {
  fireEvent.change(screen.getByLabelText(label, { selector: "input" }), {
    target: { files: [file] },
  });
}

describe("FontsPackagesDialog", () => {
  beforeEach(() => {
    uploadFiles.mockReset();
    fetchUniverse.mockReset();
    // The zip reader would hand the archive to a worker, which jsdom lacks.
    vi.stubGlobal("Worker", undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows both tabs with counts and an empty state for each", async () => {
    const project = newDoc();
    putPackage(project, record());
    renderDialog(project);

    expect(
      screen.getByRole("dialog", { name: "Fonts & Packages" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Changes apply for every collaborator/),
    ).toBeVisible();
    expect(await screen.findByText("No custom fonts yet")).toBeVisible();
    expect(screen.getByRole("tab", { name: /Packages/ })).toHaveTextContent(
      "1",
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: /Packages/ }), {
      button: 0,
    });
    expect(
      await screen.findByRole("listitem", { name: "@local/hello:0.1.0" }),
    ).toBeVisible();
  });

  it("shows the packages empty state", async () => {
    renderDialog(newDoc(), { target: { tab: "packages" } });
    expect(await screen.findByText("No packages yet")).toBeVisible();
    expect(screen.getByPlaceholderText("@preview/cetz:0.4.2")).toBeVisible();
  });

  it("groups font files into families with a copyable snippet", async () => {
    const project = newDoc();
    const blobs = new Map([
      ["h1", font("Hook Sans", 700)],
      ["h2", font("Hook Sans", 400)],
    ]);
    createAsset(project, null, "bold.ttf", {
      hash: "h1",
      size: 5,
      mime: "font/ttf",
    });
    createAsset(project, null, "regular.otf", {
      hash: "h2",
      size: 5,
      mime: "font/otf",
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderDialog(project, { assets: fakeAssets(blobs) });

    expect(
      await screen.findByRole("heading", { name: "Hook Sans" }),
    ).toBeVisible();
    const faces = screen.getByRole("list", { name: "Faces of Hook Sans" });
    expect(within(faces).getAllByRole("listitem")).toHaveLength(2);
    expect(within(faces).getByText("Regular · 400")).toBeVisible();
    expect(within(faces).getByText("Bold · 700")).toBeVisible();
    expect(screen.getByRole("tab", { name: /Fonts/ })).toHaveTextContent("1");

    fireEvent.click(
      screen.getByRole("button", { name: "Copy font snippet for Hook Sans" }),
    );
    expect(writeText).toHaveBeenCalledWith('#set text(font: "Hook Sans")');
  });

  it("rejects WOFF files with a conversion tip and uploads nothing", async () => {
    renderDialog(newDoc());
    pick("Choose fonts", new File([new Uint8Array(8)], "web.woff2"));
    expect(
      await screen.findByText(/Typst can't read WOFF or WOFF2/),
    ).toBeVisible();
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("uploads a valid font into the fonts folder", async () => {
    uploadFiles.mockImplementation(async (_p, _a, files: File[]) => ({
      created: [{ id: "0@1", name: files[0]!.name, kind: "asset" }],
      errors: [],
    }));
    const project = newDoc();
    renderDialog(project);
    pick(
      "Choose fonts",
      new File([font("Hook Sans", 400) as Uint8Array<ArrayBuffer>], "hook.ttf"),
    );
    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    const [, , files] = uploadFiles.mock.calls[0]!;
    expect(files.map((f: File) => f.name)).toEqual(["hook.ttf"]);
    expect(await screen.findByText("Added 1 font file")).toBeVisible();
  });

  it("lists web fonts that are already in the project as unsupported", async () => {
    const project = newDoc();
    createAsset(project, null, "old.woff", {
      hash: "w",
      size: 5,
      mime: "font/woff",
    });
    renderDialog(project);
    expect(await screen.findByText("Web fonts Typst can't use")).toBeVisible();
    expect(screen.getByText("old.woff")).toBeVisible();
  });

  it("turns built-in font bundles on and off", async () => {
    const project = newDoc();
    renderDialog(project);
    fireEvent.click(screen.getByRole("button", { name: /Built-in fonts/ }));
    const cjk = await screen.findByRole("switch", { name: /CJK fonts/ });
    expect(screen.getByText("Downloaded once, then cached.")).toBeVisible();
    expect(cjk).not.toBeChecked();
    fireEvent.click(cjk);
    await waitFor(() => expect(cjk).toBeChecked());
    expect(
      screen.getByRole("switch", { name: /Color emoji/ }),
    ).not.toBeChecked();
  });

  it("adds an uploaded package after editing its namespace", async () => {
    const assets = fakeAssets();
    renderDialog(newDoc(), { assets, target: { tab: "packages" } });
    pick("Choose archive", zipFile());

    const review = await screen.findByRole("form", { name: "Review package" });
    expect(within(review).getByText("hello")).toBeVisible();
    expect(within(review).getByText("Says hi")).toBeVisible();
    const ns = within(review).getByLabelText("Namespace");
    expect(ns).toHaveValue("local");
    expect(
      within(review).getByText('#import "@local/hello:0.1.0": *'),
    ).toBeVisible();

    fireEvent.change(ns, { target: { value: "1bad" } });
    expect(within(review).getByRole("alert")).toBeVisible();
    expect(
      within(review).getByRole("button", { name: "Add package" }),
    ).toBeDisabled();

    fireEvent.change(ns, { target: { value: "acme" } });
    expect(
      within(review).getByText('#import "@acme/hello:0.1.0": *'),
    ).toBeVisible();
    fireEvent.click(
      within(review).getByRole("button", { name: "Add package" }),
    );

    const row = await screen.findByRole("listitem", {
      name: "@acme/hello:0.1.0",
    });
    expect(within(row).getByText("Uploaded")).toBeVisible();
    expect(within(row).getByText("@acme")).toBeVisible();
    expect(assets.store).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Added @acme/hello:0.1.0")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy import" })).toBeVisible();
    expect(screen.queryByRole("form", { name: "Review package" })).toBeNull();
  });

  it("rejects things that are not package archives", async () => {
    renderDialog(newDoc(), { target: { tab: "packages" } });
    pick("Choose archive", new File(["x"], "notes.txt"));
    expect(await screen.findByText(/not a package archive/)).toBeVisible();
  });

  it("follows packages added by a collaborator", async () => {
    const project = newDoc();
    const peer = fork(project, 2);
    renderDialog(project, { target: { tab: "packages" } });
    expect(await screen.findByText("No packages yet")).toBeVisible();

    act(() => {
      putPackage(peer, record({ name: "remote", description: "From afar" }));
      sync(project, peer);
    });
    expect(
      await screen.findByRole("listitem", { name: "@local/remote:0.1.0" }),
    ).toBeVisible();
    expect(screen.queryByText("No packages yet")).toBeNull();

    act(() => {
      peer.packages.delete("local/remote/0.1.0");
      peer.doc.commit();
      sync(project, peer);
    });
    await waitFor(() =>
      expect(screen.getByText("No packages yet")).toBeVisible(),
    );
  });

  it("asks before replacing an existing package", async () => {
    const project = newDoc();
    putPackage(project, record());
    const assets = fakeAssets();
    renderDialog(project, { assets, target: { tab: "packages" } });
    pick("Choose archive", zipFile());
    const review = await screen.findByRole("form", { name: "Review package" });
    fireEvent.click(
      within(review).getByRole("button", { name: "Add package" }),
    );

    const confirm = await screen.findByRole("dialog", {
      name: "Replace @local/hello:0.1.0?",
    });
    expect(assets.store).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(assets.store).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Added @local/hello:0.1.0")).toBeVisible();
  });

  it("removes a package after confirming", async () => {
    const project = newDoc();
    putPackage(project, record());
    renderDialog(project, { target: { tab: "packages" } });
    const row = await screen.findByRole("listitem", {
      name: "@local/hello:0.1.0",
    });
    fireEvent.keyDown(
      within(row).getByRole("button", {
        name: "Actions for @local/hello:0.1.0",
      }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));

    const confirm = await screen.findByRole("dialog", {
      name: "Remove @local/hello:0.1.0?",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(screen.getByText("No packages yet")).toBeVisible(),
    );
    expect(project.packages.keys()).toEqual([]);
  });

  it("copies a package's import line", async () => {
    const project = newDoc();
    putPackage(project, record({ source: "universe", namespace: "preview" }));
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderDialog(project, { target: { tab: "packages" } });
    const row = await screen.findByRole("listitem", {
      name: "@preview/hello:0.1.0",
    });
    expect(within(row).getByText("Universe")).toBeVisible();
    fireEvent.click(
      within(row).getByRole("button", { name: /Copy import for/ }),
    );
    expect(writeText).toHaveBeenCalledWith('#import "@preview/hello:0.1.0": *');
  });

  it("warns about packages that need a newer compiler", async () => {
    const project = newDoc();
    putPackage(project, record({ compiler: "9.0.0" }));
    renderDialog(project, { target: { tab: "packages" } });
    expect(await screen.findByText("Needs Typst 9.0.0")).toBeVisible();
  });

  it("validates the pin field before fetching", async () => {
    renderDialog(newDoc(), { target: { tab: "packages" } });
    const input = screen.getByPlaceholderText("@preview/cetz:0.4.2");
    const pin = screen.getByRole("button", { name: "Pin" });
    expect(pin).toBeDisabled();

    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.click(pin);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Enter a package like/,
    );

    fireEvent.change(input, { target: { value: "@acme/thing:1.0.0" } });
    fireEvent.click(pin);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only @preview/);
    expect(fetchUniverse).not.toHaveBeenCalled();

    fetchUniverse.mockRejectedValue(
      new PackageError("No package @preview/nope:1.0.0 on Typst Universe."),
    );
    fireEvent.change(input, { target: { value: "@preview/nope:1.0.0" } });
    fireEvent.click(pin);
    expect(
      await screen.findByText(
        "No package @preview/nope:1.0.0 on Typst Universe.",
      ),
    ).toBeVisible();
  });

  it("pins a Universe package and offers pins for unpinned imports", async () => {
    const project = newDoc();
    const tarball = gzipDeterministic(
      writeTar(
        new Map([
          ["typst.toml", enc.encode(MANIFEST.replace("hello", "cetz"))],
          ["lib.typ", enc.encode("#let hi = [Hello]")],
        ]),
      ),
    );
    fetchUniverse.mockResolvedValue(tarball);
    getText(project, project.mainFile!).insert(
      0,
      '#import "@preview/cetz:0.1.0": *',
    );
    project.doc.commit();

    renderDialog(project, { target: { tab: "packages" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Pin @preview/cetz:0.1.0" }),
    );

    expect(await screen.findByText("Added @preview/cetz:0.1.0")).toBeVisible();
    expect(fetchUniverse).toHaveBeenCalledWith("cetz", "0.1.0");
    const row = await screen.findByRole("listitem", {
      name: "@preview/cetz:0.1.0",
    });
    expect(within(row).getByText("Universe")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("Used in this project, not pinned")).toBeNull(),
    );
  });

  it("puts a preview prefill into the pin field", async () => {
    renderDialog(newDoc(), {
      target: { tab: "packages", prefill: "@preview/cetz:0.4.2" },
    });
    expect(
      await screen.findByPlaceholderText("@preview/cetz:0.4.2"),
    ).toHaveValue("@preview/cetz:0.4.2");
  });

  it("asks to upload a prefilled package outside the preview namespace", async () => {
    renderDialog(newDoc(), {
      target: { tab: "packages", prefill: "@acme/thing:1.0.0" },
    });
    expect(await screen.findByText(/not on Typst Universe/)).toBeVisible();
    expect(screen.getByPlaceholderText("@preview/cetz:0.4.2")).toHaveValue("");
  });

  it("hides every mutating control for read-only viewers", async () => {
    const project = newDoc();
    putPackage(project, record());
    createAsset(project, null, "old.woff", {
      hash: "w",
      size: 5,
      mime: "font/woff",
    });
    renderDialog(project, { readOnly: true });

    expect(
      await screen.findByText(
        "You can view fonts and packages. Ask an editor to change them.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose fonts…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Built-in fonts/ }));
    expect(
      await screen.findByRole("switch", { name: /CJK fonts/ }),
    ).toBeDisabled();

    fireEvent.mouseDown(screen.getByRole("tab", { name: /Packages/ }), {
      button: 0,
    });
    await screen.findByRole("listitem", { name: "@local/hello:0.1.0" });
    expect(screen.queryByPlaceholderText("@preview/cetz:0.4.2")).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Choose archive…" }),
    ).toBeNull();
  });

  it("explains that a local-only project cannot add files", async () => {
    renderDialog(newDoc(), { assets: null });
    expect(
      await screen.findByText(/can't be added to this project/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose fonts…" })).toBeNull();
  });
});
