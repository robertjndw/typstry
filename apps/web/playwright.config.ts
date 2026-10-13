import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Not the dev port, so the suite can run next to `pnpm dev`.
const port = 4787;
const baseURL = `http://127.0.0.1:${port}`;
const root = path.resolve(import.meta.dirname, "../..");
// Wiped on every server start so runs never see each other's projects.
const dataDir = path.join(os.tmpdir(), "typstry-e2e");

export default defineConfig({
  testDir: "e2e",
  // Fails fast when dist/ is older than src/, see the file.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // The first compile loads the Typst and tinymist wasm, which is slow on CI
  // runners.
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Tests run against the production build served by the real server, so
  // `pnpm build` has to run first; globalSetup checks that it did.
  webServer: {
    command: `rm -rf "${dataDir}" && cargo run --quiet -p typstry-server`,
    cwd: root,
    url: `${baseURL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      TYPSTRY_ADDR: `127.0.0.1:${port}`,
      TYPSTRY_DATA_DIR: dataDir,
      TYPSTRY_WEB_DIST: path.join(root, "apps/web/dist"),
    },
  },
});
