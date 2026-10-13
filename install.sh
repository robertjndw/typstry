#!/bin/sh
# Installs the typstry CLI from the GitHub release binaries.
#
#   curl -fsSL https://raw.githubusercontent.com/robertjndw/typstry/main/install.sh | sh
#
# TYPSTRY_VERSION  release tag, defaults to the latest one (nightly if there is none)
# TYPSTRY_BIN_DIR  install location, defaults to ~/.local/bin
set -eu

repo=robertjndw/typstry
bin_dir=${TYPSTRY_BIN_DIR:-$HOME/.local/bin}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-gnu ;;
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  *)
    echo "typstry: no prebuilt binary for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

base=https://github.com/$repo/releases
if [ -n "${TYPSTRY_VERSION:-}" ]; then
  url=$base/download/$TYPSTRY_VERSION
elif curl -fsI "$base/latest/download/typstry-$target.tar.gz" > /dev/null 2>&1; then
  url=$base/latest/download
else
  # nothing stable yet
  url=$base/download/nightly
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
name=typstry-$target.tar.gz

echo "Downloading $url/$name"
curl -fsSL "$url/$name" -o "$tmp/$name"
curl -fsSL "$url/$name.sha256" -o "$tmp/$name.sha256"

# the .sha256 file names the archive without a path, so check from inside tmp
(
  cd "$tmp"
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum -c "$name.sha256"
  else
    shasum -a 256 -c "$name.sha256"
  fi
)

tar -xzf "$tmp/$name" -C "$tmp"
mkdir -p "$bin_dir"
install -m 755 "$tmp/typstry-$target/typstry" "$bin_dir/typstry"

echo "Installed typstry to $bin_dir/typstry"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "$bin_dir is not on your PATH" ;;
esac
