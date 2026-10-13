import fs from "node:fs";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (!/\.test\.tsx?$/.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * The suite runs against the production build, which nothing rebuilds on
 * the way. A build older than the sources makes tests fail (or pass) for
 * code that is not there any more, so this stops early instead. CI builds
 * from the same commit right before, and artifact downloads do not keep
 * their mtimes, so the check only runs locally.
 */
export default function globalSetup() {
  if (process.env.CI || process.env.TYPSTRY_E2E_SKIP_BUILD_CHECK) return;
  const index = path.join(web, "dist/index.html");
  if (!fs.existsSync(index)) {
    throw new Error(
      "No production build in apps/web/dist. Run `pnpm build` first.",
    );
  }
  const built = fs.statSync(index).mtimeMs;
  const changed = Math.max(
    newestMtime(path.join(web, "src")),
    fs.statSync(path.join(web, "index.html")).mtimeMs,
  );
  if (changed > built) {
    throw new Error(
      "apps/web/dist is older than the sources. Run `pnpm build` first " +
        "(or set TYPSTRY_E2E_SKIP_BUILD_CHECK=1 to test the old build anyway).",
    );
  }
}
