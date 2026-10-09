import "@testing-library/jest-dom/vitest";
// Projects persist to IndexedDB, which jsdom lacks.
import "fake-indexeddb/auto";

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
