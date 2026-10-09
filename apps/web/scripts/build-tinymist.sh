#!/usr/bin/env bash
# Builds tinymist's language server to wasm for the browser. The npm package
# "tinymist-web" is an empty stub (it only exports version()), so we build
# from source at a pinned commit. Output lands in apps/web/vendor/tinymist
# (ignored by git); the editor loads it from there.
#
# Needs: git, rustup, wasm-pack. The first build takes a while.
set -euo pipefail

TINYMIST_REPO="https://github.com/Myriad-Dreamin/tinymist.git"
# tinymist 0.15.8 (Typst 0.15.1). CI caches the build on this script's hash,
# so bumping the commit here is enough to rebuild it there.
TINYMIST_REV="6887d86a1c534659a93fd0e65dfb9c573fae6fe3"

web_dir="$(cd "$(dirname "$0")/.." && pwd)"
# The checkout goes under the repo's target/ rather than next to the output:
# it is a whole repo with its own JS and tests, which ESLint, Prettier and
# Vitest would otherwise pick up. target/ is ignored everywhere already.
src="${TINYMIST_SRC:-$web_dir/../../target/tinymist-src}"
out="$web_dir/vendor/tinymist"

if [ ! -d "$src/.git" ]; then
  git clone --filter=blob:none "$TINYMIST_REPO" "$src"
fi
git -C "$src" fetch --quiet origin "$TINYMIST_REV"
git -C "$src" checkout --quiet "$TINYMIST_REV"

# tinymist pins its own toolchain in rust-toolchain.toml.
(cd "$src" && rustup target add wasm32-unknown-unknown)

(cd "$src/crates/tinymist" &&
  wasm-pack build --target web --release --out-dir "$out" -- \
    --no-default-features --features web,no-content-hint)

# wasm-pack also writes a package.json, README and .gitignore we don't use.
rm -f "$out/package.json" "$out/README.md" "$out/.gitignore"
