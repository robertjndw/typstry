#!/usr/bin/env bash
# Builds crates/typstry-wasm (the encryption and MLS code the web app shares
# with the CLI) for the browser. Output lands in apps/web/vendor/typstry-wasm,
# which git ignores; the app loads it from there.
#
# Needs: rustup and wasm-pack. Rerun it after changing typstry-wire or
# typstry-wasm.
set -euo pipefail

web_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo="$web_dir/../.."
out="$web_dir/vendor/typstry-wasm"

(cd "$repo" && rustup target add wasm32-unknown-unknown)

# The workspace has no release profile of its own, and the size of this
# download matters more than speed. wasm-opt is off in the crate's metadata:
# it made the gzipped file larger.
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z
export CARGO_PROFILE_RELEASE_LTO=true
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_PROFILE_RELEASE_PANIC=abort
export CARGO_PROFILE_RELEASE_STRIP=true

rm -rf "$out"
(cd "$repo/crates/typstry-wasm" &&
  wasm-pack build --target web --release --out-dir "$out" --out-name typstry_wasm)

# wasm-pack also writes a package.json, README and .gitignore we don't use.
rm -f "$out/package.json" "$out/README.md" "$out/.gitignore"
