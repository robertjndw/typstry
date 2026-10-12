import "@testing-library/jest-dom/vitest";
// Projects persist to IndexedDB, which jsdom lacks.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach } from "vitest";
import path from "node:path";

import { resetDirectory } from "./directory/store";
import { initSync } from "../vendor/typstry-wasm/typstry_wasm.js";

// The wasm build of the crypto, compiled from the file instead of fetched:
// loadWasm() finds it initialized already. Run `pnpm --filter web wasm` first.
initSync({
  module: readFileSync(
    path.resolve(
      import.meta.dirname,
      "../vendor/typstry-wasm/typstry_wasm_bg.wasm",
    ),
  ),
});

// jsdom lacks ResizeObserver, which react-resizable-panels needs to mount.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom lacks matchMedia, which sonner's Toaster reads for the theme. Some
// suites run in the node environment, where there is no window at all.
if (typeof window !== "undefined")
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

// jsdom has no Worker; the preview's compile worker just never answers.
if (typeof window !== "undefined")
  globalThis.Worker ??= class {
    postMessage() {}
    addEventListener() {}
    removeEventListener() {}
    terminate() {}
  } as unknown as typeof Worker;

// The directory is a page-wide singleton over the shared fake IndexedDB, so
// without this one test's projects would show up in the next.
afterEach(() => resetDirectory());
