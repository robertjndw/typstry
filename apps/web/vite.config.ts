import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Overridable for running next to something else on the default port.
const backend = process.env.TYPSTRY_BACKEND ?? "http://localhost:8787";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// woff2 and images are compressed already.
const COMPRESSIBLE = /\.(wasm|js|css|html|svg|json)$/;

/**
 * Writes .br and .gz copies of the build output for the server to send as
 * is (ServeDir's precompressed_*). The compiler and tinymist wasm are 30 MB
 * each and shrink to about 9; compressing per request would cost the server
 * seconds of CPU. Brotli quality 9 is within 10% of 11 at 1/25 of the time.
 * Gzip stays for plain-http origins, where Chrome does not offer br.
 */
function precompress(): Plugin {
  let outDir = "";
  return {
    name: "typstry:precompress",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async writeBundle() {
      const entries = await readdir(outDir, { recursive: true });
      await Promise.all(
        entries
          .filter((name) => COMPRESSIBLE.test(name))
          .map(async (name) => {
            const file = path.join(outDir, name);
            const data = await readFile(file);
            if (data.length < 1024) return;
            const [br, gz] = await Promise.all([
              brotli(data, {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
                  [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
                },
              }),
              gzip(data, { level: 9 }),
            ]);
            await Promise.all([
              writeFile(file + ".br", br),
              writeFile(file + ".gz", gz),
            ]);
          }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
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
    // e2e/ holds the Playwright suite.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
