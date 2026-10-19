import type { ArtifactUpdate } from "./protocol";
import type { PreviewRenderer } from "./renderer";
import { RenderDiff, RenderHost } from "./render-state";
import { splitSvgString } from "./svg-split";

const root = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">';
const page = (tid: string) =>
  `<g class="typst-page" transform="translate(0, 0)" data-tid="${tid}" data-page-width="100" data-page-height="200"><g/></g>`;
const svg = (tids: string[], defs = "<defs/>") =>
  root + defs + tids.map(page).join("") + "</svg>";

describe("RenderDiff", () => {
  it("sends everything the first time", () => {
    const render = new RenderDiff().diff(splitSvgString(svg(["a", "b"])));
    expect(render.defs).toBe("<defs/>");
    expect(render.pages.map((p) => [p.tid, p.markup === null])).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(render.rootTag).toBe(root);
  });

  it("leaves out unchanged defs and pages", () => {
    const diff = new RenderDiff();
    diff.diff(splitSvgString(svg(["a", "b"])));
    const render = diff.diff(splitSvgString(svg(["a", "c"])));
    expect(render.defs).toBeNull();
    expect(render.pages).toEqual([
      { tid: "a", width: 100, height: 200, markup: null },
      { tid: "c", width: 100, height: 200, markup: page("c") },
    ]);

    const changed = diff.diff(
      splitSvgString(svg(["a", "c"], "<defs>x</defs>")),
    );
    expect(changed.defs).toBe("<defs>x</defs>");
  });

  it("counts repeated tids per occurrence", () => {
    const diff = new RenderDiff();
    diff.diff(splitSvgString(svg(["a", "a"])));
    const more = diff.diff(splitSvgString(svg(["a", "a", "a"])));
    expect(more.pages.map((p) => p.markup === null)).toEqual([
      true,
      true,
      false,
    ]);
    const fewer = diff.diff(splitSvgString(svg(["a"])));
    expect(fewer.pages.map((p) => p.markup === null)).toEqual([true]);
  });

  it("never reuses a page without a tid", () => {
    const diff = new RenderDiff();
    diff.diff(splitSvgString(svg([""])));
    expect(
      diff.diff(splitSvgString(svg([""]))).pages[0]!.markup,
    ).not.toBeNull();
  });

  it("sends the next render in full after a reset", () => {
    const diff = new RenderDiff();
    diff.diff(splitSvgString(svg(["a"])));
    diff.reset();
    const render = diff.diff(splitSvgString(svg(["a"])));
    expect(render.defs).toBe("<defs/>");
    expect(render.pages[0]!.markup).toBe(page("a"));
  });
});

const update = (action: "reset" | "merge"): ArtifactUpdate => ({
  action,
  data: new Uint8Array([1]),
});

function fakeRenderer() {
  const applied: ArtifactUpdate[] = [];
  let doc = svg([]);
  const renderer: PreviewRenderer = {
    apply: vi.fn((u) => void applied.push(u)),
    renderSvg: vi.fn(async () => doc),
    dispose: vi.fn(),
  };
  return { applied, renderer, show: (tids: string[]) => (doc = svg(tids)) };
}

const never = () => false;

describe("RenderHost", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("applies an update, renders, and then sends only changes", async () => {
    const r = fakeRenderer();
    const host = new RenderHost(async () => r.renderer);
    r.show(["a", "b"]);
    const first = await host.update(update("reset"), "/main.typ", never);
    expect(first.render?.pages).toHaveLength(2);
    expect(first.error).toBeNull();

    r.show(["a", "c"]);
    const second = await host.update(update("merge"), "/main.typ", never);
    expect(r.applied.map((u) => u.action)).toEqual(["reset", "merge"]);
    expect(second.render?.defs).toBeNull();
    expect(second.render?.pages.map((p) => p.markup === null)).toEqual([
      true,
      false,
    ]);
  });

  it("applies a deferred update but renders it with the next result", async () => {
    const r = fakeRenderer();
    const host = new RenderHost(async () => r.renderer);
    r.show(["a"]);
    const deferred = await host.update(
      update("reset"),
      "/main.typ",
      () => true,
    );
    expect(deferred.render).toBeNull();
    expect(r.renderer.renderSvg).not.toHaveBeenCalled();

    // The newer compile failed, so it has no update of its own.
    const next = await host.update(undefined, "/main.typ", never);
    expect(next.render?.pages.map((p) => p.tid)).toEqual(["a"]);

    const idle = await host.update(undefined, "/main.typ", never);
    expect(idle.render).toBeNull();
    expect(r.renderer.renderSvg).toHaveBeenCalledTimes(1);
  });

  it("drops the renderer and reports a desync when a merge fails", async () => {
    const r = fakeRenderer();
    const created = vi.fn(async () => r.renderer);
    const host = new RenderHost(created);
    vi.mocked(r.renderer.apply).mockImplementationOnce(() => {
      throw new Error("bad delta");
    });
    const outcome = await host.update(update("merge"), "/main.typ", never);
    expect(outcome).toMatchObject({
      render: null,
      desynced: true,
      error: { kind: "render", message: expect.stringContaining("bad delta") },
    });
    expect(r.renderer.dispose).toHaveBeenCalled();

    // A fresh renderer takes the reset the compiler sends next.
    r.show(["a"]);
    const retry = await host.update(update("reset"), "/main.typ", never);
    expect(retry.render?.pages).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(2);
  });

  it("reports a failed load and retries it with the next update", async () => {
    const r = fakeRenderer();
    let online = false;
    const created = vi.fn(async () => {
      if (!online) throw new TypeError("Failed to fetch");
      return r.renderer;
    });
    const host = new RenderHost(created);
    host.preload();
    const failed = await host.update(update("reset"), "/main.typ", never);
    expect(failed).toMatchObject({
      render: null,
      desynced: true,
      error: { kind: "load" },
    });

    online = true;
    r.show(["a"]);
    const ok = await host.update(update("reset"), "/main.typ", never);
    expect(ok.render?.pages).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(3);
  });

  describe("rerender", () => {
    it("sends the document in full without a compile", async () => {
      const r = fakeRenderer();
      const host = new RenderHost(async () => r.renderer);
      r.show(["a", "b"]);
      await host.update(update("reset"), "/main.typ", never);

      const answer = await host.rerender("/main.typ");
      expect(answer.kind).toBe("render");
      if (answer.kind !== "render") return;
      expect(answer.outcome.render?.defs).toBe("<defs/>");
      expect(answer.outcome.render?.pages.every((p) => p.markup)).toBe(true);
      expect(r.applied).toHaveLength(1);
    });

    it("asks for a compile when the renderer lacks the document", async () => {
      const r = fakeRenderer();
      const host = new RenderHost(async () => r.renderer);
      expect(await host.rerender("/main.typ")).toEqual({ kind: "compile" });

      r.show(["a"]);
      await host.update(update("reset"), "/main.typ", never);
      // Another main file than the one the session holds.
      expect(await host.rerender("/other.typ")).toEqual({ kind: "compile" });
      expect(await host.rerender(null)).toEqual({ kind: "compile" });
    });

    it("asks for a compile after the update never made it into the renderer", async () => {
      const r = fakeRenderer();
      let online = false;
      const host = new RenderHost(async () => {
        if (!online) throw new TypeError("Failed to fetch");
        return r.renderer;
      });
      await host.update(update("reset"), "/main.typ", never);
      online = true;
      expect(await host.rerender("/main.typ")).toEqual({ kind: "compile" });
    });
  });
});
