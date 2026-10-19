// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { CASE_PROBE_PREFIX, handleFs } from "./folder-fs";
import { fakeFolder } from "./test-utils";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("handleFs", () => {
  it("stats and reads files", async () => {
    const folder = fakeFolder({ "a/b.typ": "hello" });
    const fs = handleFs(folder.handle);
    expect(await fs.stat("a/b.typ")).toEqual({
      size: 5,
      mtime: folder.clock.now(),
    });
    expect(await fs.stat("a/missing.typ")).toBeNull();
    expect(await fs.stat("nope/x.typ")).toBeNull();
    expect(await fs.stat("a")).toBeNull();
    expect(new TextDecoder().decode(await fs.read("a/b.typ"))).toBe("hello");
  });

  it("writes files and creates parent folders", async () => {
    const folder = fakeFolder();
    const fs = handleFs(folder.handle);
    folder.clock.advance();
    await fs.write("x/y/z.typ", bytes("one"));
    await fs.write("x/y/z.typ", bytes("two!"));
    expect(folder.text("x/y/z.typ")).toBe("two!");
    expect((await fs.stat("x/y/z.typ"))!.mtime).toBe(folder.clock.now());
  });

  it("leaves the file alone when a write fails", async () => {
    const folder = fakeFolder({ "a.typ": "old" });
    const file = await folder.handle.getFileHandle("a.typ");
    const create = vi.spyOn(file, "createWritable").mockResolvedValue({
      write: async () => {
        throw new Error("disk full");
      },
      abort: async () => {},
    } as never);
    await expect(
      handleFs(folder.handle).write("a.typ", bytes("new")),
    ).rejects.toThrow("disk full");
    create.mockRestore();
    expect(folder.text("a.typ")).toBe("old");
  });

  it("makes folders", async () => {
    const folder = fakeFolder();
    await handleFs(folder.handle).mkdir("a/b");
    expect(folder.dirs()).toEqual(["a", "a/b"]);
  });

  it("removes files and the folders they leave empty, not the root", async () => {
    const folder = fakeFolder({
      "a/b/c.typ": "c",
      "a/keep.typ": "k",
      "solo/x/y.typ": "y",
    });
    const fs = handleFs(folder.handle);
    await fs.remove("a/b/c.typ");
    expect(folder.dirs()).toEqual(["a", "solo", "solo/x"]);
    await fs.remove("solo/x/y.typ");
    expect(folder.dirs()).toEqual(["a"]);
    await fs.remove("a/keep.typ");
    expect(folder.dirs()).toEqual([]);
    expect(folder.files()).toEqual([]);
  });

  it("removes a folder with its contents and ignores missing paths", async () => {
    const folder = fakeFolder({
      "d/x/1.typ": "1",
      "d/2.typ": "2",
      "e.typ": "e",
    });
    const fs = handleFs(folder.handle);
    await fs.remove("d");
    await fs.remove("d");
    await fs.remove("nope/deeper.typ");
    expect(folder.files()).toEqual(["e.typ"]);
  });

  it("probes case sensitivity and cleans up after itself", async () => {
    for (const caseInsensitive of [true, false]) {
      const folder = fakeFolder({}, { caseInsensitive });
      const fs = handleFs(folder.handle);
      expect(await fs.caseInsensitive()).toBe(caseInsensitive);
      expect(folder.files()).toEqual([]);
    }
  });

  it("falls back to the platform when the probe cannot run", async () => {
    const folder = fakeFolder();
    vi.spyOn(folder.handle, "getFileHandle").mockRejectedValue(
      new DOMException("no", "NotAllowedError"),
    );
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)" });
    expect(await handleFs(folder.handle).caseInsensitive()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux)" });
    expect(await handleFs(folder.handle).caseInsensitive()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("names its probe with the exported prefix", async () => {
    const folder = fakeFolder();
    const spy = vi.spyOn(folder.handle, "getFileHandle");
    await handleFs(folder.handle).caseInsensitive();
    expect(spy.mock.calls[0]![0].startsWith(CASE_PROBE_PREFIX)).toBe(true);
  });
});
