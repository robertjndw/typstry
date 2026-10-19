import { defineConfig, devices } from "@playwright/test";

// Not the dev port nor the server suite's, so the suites can run side by side.
const port = 4788;
// Pages serves the app from /<repo>/, so the suite does too; the build has to
// use the same TYPSTRY_BASE.
const base = "/typstry/";

export default defineConfig({
  testDir: "e2e-static",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // The first compile loads the Typst and tinymist wasm, which is slow on CI
  // runners.
  expect: { timeout: 15_000 },
  use: {
    // Ends in a slash and tests navigate with relative paths: an absolute
    // one such as "/p/x" would resolve against the origin and drop the base.
    baseURL: `http://127.0.0.1:${port}${base}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Serves the output of `TYPSTRY_BASE=/typstry/ pnpm build:static`. There is
  // no up-to-date check like the server suite has, so rebuild before running.
  webServer: {
    command: `vite preview --outDir dist-static --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}${base}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // vite preview takes its base from the config, which reads this.
    env: { TYPSTRY_BASE: base },
  },
});
