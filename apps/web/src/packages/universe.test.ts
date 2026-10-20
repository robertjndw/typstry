// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { PackageError } from "./errors";
import { MAX_PACKAGE_ARCHIVE_BYTES } from "./archive-limit";
import { fetchUniverse, findPreviewImports } from "./universe";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: () => Promise<Response> | Response) {
  const fn = vi.fn<typeof fetch>(async () => impl());
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("fetchUniverse", () => {
  it("downloads the archive from the registry", async () => {
    const fn = stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    expect(await fetchUniverse("cetz", "0.4.2")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(fn.mock.calls[0]![0]).toBe(
      "https://packages.typst.org/preview/cetz-0.4.2.tar.gz",
    );
  });

  it("explains a 404", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await expect(fetchUniverse("nope", "1.2.3")).rejects.toThrow(
      "No package @preview/nope:1.2.3 on Typst Universe.",
    );
  });

  it("reports other statuses", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    await expect(fetchUniverse("a", "1.0.0")).rejects.toThrow(/503/);
  });

  it("turns a network failure into a friendly error", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const err = await fetchUniverse("a", "1.0.0").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackageError);
    expect((err as Error).message).toMatch(/Could not reach Typst Universe/);
  });

  it("lets an abort through unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await expect(
      fetchUniverse("a", "1.0.0", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a declared size over the cap without reading", async () => {
    stubFetch(
      () =>
        new Response("x", {
          headers: { "content-length": String(MAX_PACKAGE_ARCHIVE_BYTES + 1) },
        }),
    );
    await expect(fetchUniverse("a", "1.0.0")).rejects.toThrow(/larger than/);
  });

  it("counts streamed bytes when the header is missing", async () => {
    const chunk = new Uint8Array(MAX_PACKAGE_ARCHIVE_BYTES / 2 + 1);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 3) controller.enqueue(chunk);
        else controller.close();
      },
    });
    stubFetch(() => new Response(body));
    await expect(fetchUniverse("a", "1.0.0")).rejects.toThrow(/larger than/);
  });

  it("rejects specs that would not make a safe URL", async () => {
    const fn = stubFetch(() => new Response(""));
    await expect(fetchUniverse("../x", "1.0.0")).rejects.toThrow(PackageError);
    await expect(fetchUniverse("a", "1.0")).rejects.toThrow(PackageError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("findPreviewImports", () => {
  it("finds pinned imports with the files that use them", () => {
    const found = findPreviewImports([
      { path: "b.typ", text: '#import "@preview/cetz:0.4.2": canvas' },
      {
        path: "a.typ",
        text: '#import "@preview/cetz:0.4.2"\n#import "@preview/tablex:0.0.8": *',
      },
      { path: "a.typ", text: '#import "@preview/cetz:0.4.2"' },
    ]);
    expect(found).toEqual([
      {
        spec: "@preview/cetz:0.4.2",
        namespace: "preview",
        name: "cetz",
        version: "0.4.2",
        paths: ["a.typ", "b.typ"],
      },
      {
        spec: "@preview/tablex:0.0.8",
        namespace: "preview",
        name: "tablex",
        version: "0.0.8",
        paths: ["a.typ"],
      },
    ]);
  });

  it("ignores other namespaces and unpinned or malformed versions", () => {
    expect(
      findPreviewImports([
        {
          path: "a.typ",
          text: '#import "@local/x:1.0.0"\n#import "@preview/y:1.0"\n#import "@preview/z:1.0.0.1"\n#import "@preview/w"',
        },
      ]),
    ).toEqual([]);
  });

  it("accepts any iterable", () => {
    function* gen() {
      yield { path: "m.typ", text: '"@preview/a-b_c:10.20.30"' };
    }
    expect(findPreviewImports(gen()).map((i) => i.spec)).toEqual([
      "@preview/a-b_c:10.20.30",
    ]);
  });
});
