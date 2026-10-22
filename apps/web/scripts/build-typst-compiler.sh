#!/usr/bin/env bash
# Builds typst.ts's web compiler to wasm with patches/typst-ts-jump.patch,
# which adds click-to-source and cursor-to-preview jumps. The npm build has
# no way to map a preview point back to source. Output lands in
# apps/web/vendor/typst-ts-web-compiler (ignored by git) in the npm
# package's layout, and Vite aliases the package name to it.
#
# Needs: git, rustup, wasm-pack, node. The first build takes a while.
set -euo pipefail

TYPST_TS_REPO="https://github.com/Myriad-Dreamin/typst.ts.git"
# Tag v0.8.0-rc3, which @myriaddreamin/typst-ts-web-compiler 0.8.0-rc3 was
# published from. The JS wrapper (@myriaddreamin/typst.ts) stays on npm, so
# bump this together with the npm packages or the glue stops matching it.
TYPST_TS_REV="e1974e566ba63dcf8ecdd6730cff25de26c7dbd2"

web_dir="$(cd "$(dirname "$0")/.." && pwd)"
# Under the repo's target/ for the same reason as build-tinymist.sh: tools
# would otherwise pick up the checkout's own JS and tests.
src="${TYPST_TS_SRC:-$web_dir/../../target/typst-ts-src}"
out="$web_dir/vendor/typst-ts-web-compiler"
patch="$web_dir/patches/typst-ts-jump.patch"

if [ ! -d "$src/.git" ]; then
  git clone --filter=blob:none --no-checkout "$TYPST_TS_REPO" "$src"
fi
git -C "$src" fetch --quiet origin "$TYPST_TS_REV"
# A previous run left the patch applied; start from the pinned tree again.
git -C "$src" checkout --quiet --force "$TYPST_TS_REV"
git -C "$src" clean --quiet -fd
git -C "$src" apply "$patch"

# typst.ts pins its own toolchain in rust-toolchain.toml. Installed
# explicitly: rustup's install-on-first-use is deprecated, and images like
# the Dockerfile's only come with their own Rust version.
(cd "$src" && rustup toolchain install && rustup target add wasm32-unknown-unknown)

# The same features and post-processing as the package's own "build" script.
# wasm-debundle turns the glue into .mjs whose wasm loader is injected,
# which the typst.ts wrapper relies on (setImportWasmModule).
(cd "$src/packages/compiler" &&
  rm -rf pkg &&
  wasm-pack build --target web --release --scope myriaddreamin -- \
    --no-default-features --features web,misc &&
  node ../tools/wasm-debundle.mjs)

rm -rf "$out"
mkdir -p "$out/pkg"
# Only what the npm package ships; pkg/ also has a package.json and README.
for f in wasm-pack-shim.mjs typst_ts_web_compiler.mjs \
  typst_ts_web_compiler.d.ts typst_ts_web_compiler_bg.wasm \
  typst_ts_web_compiler_bg.wasm.d.ts; do
  cp "$src/packages/compiler/pkg/$f" "$out/pkg/"
done

# src/typst/jump.wasm.test.ts needs a real font to lay out text, and CI
# restores this directory from its cache without the cargo registry the
# build read it from. The app never loads this file.
assets="$(cd "$src" && cargo metadata --format-version 1 --locked \
  --filter-platform wasm32-unknown-unknown |
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const pkg = JSON.parse(s).packages.find((p) => p.name === "typst-assets");
    console.log(require("path").dirname(pkg.manifest_path));
  })')"
mkdir -p "$out/test-fonts"
cp "$assets/files/fonts/LibertinusSerif-Regular.otf" "$out/test-fonts/"
