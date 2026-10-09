import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Overridable for running next to something else on the default port.
const backend = process.env.TYPSTRY_BACKEND ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  optimizeDeps: {
    // Both ship wasm-bindgen "bundler" output (ESM wasm imports). Pre-bundled,
    // the wasm module binds to a second copy of its JS glue and init crashes
    // in dev; served as-is it works. Builds are unaffected.
    exclude: ["codemirror-lang-typst", "loro-crdt"],
  },
  server: {
    proxy: {
      "/api": backend,
      "/ws": { target: backend, ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
