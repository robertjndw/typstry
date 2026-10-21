import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { ProjectAssets } from "@/assets/project-assets";
import { createAsset } from "@/doc/fs-ops";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { ProjectContext, type ProjectContextValue } from "@/project/context";

import { buildSfnt, type FontSpec } from "./font-fixtures";
import { useFontSample } from "./useFontSample";
import { useProjectFonts } from "./useProjectFonts";

function font(family: string, weight: number): Uint8Array {
  const spec: FontSpec = {
    names: [{ id: 1, text: family }],
    os2: { weight, width: 5, selection: 0 },
  };
  return buildSfnt(spec);
}

describe("useProjectFonts", () => {
  it("groups faces by family and lists web fonts as unsupported", async () => {
    const project = initProject(newProject(1), { title: "T" });
    const blobs = new Map<string, Uint8Array>([
      ["h1", font("Hook Sans", 700)],
      ["h2", font("Hook Sans", 400)],
      ["h3", new Uint8Array(40)],
    ]);
    const asset = (hash: string) => ({ hash, size: 1, mime: "font/ttf" });
    createAsset(project, null, "bold.ttf", asset("h1"));
    createAsset(project, null, "regular.otf", asset("h2"));
    createAsset(project, null, "broken.ttf", asset("h3"));
    createAsset(project, null, "web.woff2", asset("h4"));
    const assets: ProjectAssets = {
      load: async (hash) => blobs.get(hash)!,
      store: () => Promise.reject(new Error("unused")),
    };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        ProjectContext.Provider,
        { value: { project, assets } as unknown as ProjectContextValue },
        children,
      );

    const { result } = renderHook(() => useProjectFonts(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const [group] = result.current.families;
    expect(result.current.families).toHaveLength(1);
    expect(group!.family).toBe("Hook Sans");
    expect(group!.faces.map((f) => [f.path, f.info.weight])).toEqual([
      ["regular.otf", 400],
      ["bold.ttf", 700],
    ]);
    expect(result.current.unsupported.map((u) => u.path)).toEqual([
      "web.woff2",
    ]);
    expect(Object.keys(result.current.errors)).toEqual(["broken.ttf"]);
  });
});

describe("useFontSample", () => {
  const added: unknown[] = [];

  beforeEach(() => {
    added.length = 0;
    class FakeFace {
      family: string;
      constructor(family: string) {
        this.family = family;
      }
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: unknown) => added.push(face),
        delete: (face: unknown) => {
          added.splice(added.indexOf(face), 1);
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const bytes = () => Promise.resolve(new Uint8Array(4));

  it("stays idle until visible, then registers and cleans up", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ visible }) => useFontSample(bytes, "abc", 0, visible),
      { initialProps: { visible: false } },
    );
    expect(result.current.status).toBe("idle");
    expect(added).toHaveLength(0);

    rerender({ visible: true });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.family).toBe("typstry-sample-abc-0");
    expect(added).toHaveLength(1);

    act(() => unmount());
    expect(added).toHaveLength(0);
  });

  it("cannot sample later faces of a collection", () => {
    const { result } = renderHook(() => useFontSample(bytes, "abc", 1, true));
    expect(result.current).toEqual({ status: "unsupported" });
    expect(added).toHaveLength(0);
  });
});
