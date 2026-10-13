#!/bin/sh
# Installs the typstry CLI from the GitHub release binaries.
#
#   curl -fsSL https://raw.githubusercontent.com/robertjndw/typstry/main/install.sh | sh
#
# TYPSTRY_VERSION  release tag, defaults to the latest one (nightly if there is none)
# TYPSTRY_BIN_DIR  install location, defaults to ~/.local/bin
#
# Set them for sh, not curl: ... | TYPSTRY_VERSION=nightly sh
set -eu

repo=robertjndw/typstry
bin_dir=${TYPSTRY_BIN_DIR:-$HOME/.local/bin}

need() {
  if ! command -v "$1" > /dev/null 2>&1; then
    echo "typstry: $1 is required but was not found" >&2
    exit 1
  fi
}
need curl
need tar
if command -v sha256sum > /dev/null 2>&1; then
  sha256='sha256sum'
elif command -v shasum > /dev/null 2>&1; then
  sha256='shasum -a 256'
else
  echo "typstry: sha256sum or shasum is required but neither was found" >&2
  exit 1
fi

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
name=typstry-$target.tar.gz
if [ -n "${TYPSTRY_VERSION:-}" ]; then
  url=$base/download/$TYPSTRY_VERSION
else
  # GitHub redirects latest/download whenever a stable release exists, even
  # if the asset is missing, and answers 404 when there is none.
  status=$(curl -sI -o /dev/null -w '%{http_code}' "$base/latest/download/$name") || status=000
  case $status in
    3*)
      url=$base/latest/download
      if ! curl -fsIL "$url/$name" > /dev/null 2>&1; then
        echo "typstry: the latest release has no $name (yet)." >&2
        echo "Try again in a few minutes, or install the main build with TYPSTRY_VERSION=nightly." >&2
        exit 1
      fi
      ;;
    404)
      # nothing stable yet
      url=$base/download/nightly
      ;;
    *)
      echo "typstry: could not reach GitHub (HTTP $status)" >&2
      exit 1
      ;;
  esac
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $url/$name"
if ! curl -fsSL "$url/$name" -o "$tmp/$name" || ! curl -fsSL "$url/$name.sha256" -o "$tmp/$name.sha256"; then
  echo "typstry: could not download $url/$name" >&2
  exit 1
fi

# the .sha256 file names the archive without a path, so check from inside tmp
(cd "$tmp" && $sha256 -c "$name.sha256")

tar -xzf "$tmp/$name" -C "$tmp"
mkdir -p "$bin_dir"
install -m 755 "$tmp/typstry-$target/typstry" "$bin_dir/typstry"

echo "Installed typstry to $bin_dir/typstry"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "$bin_dir is not on your PATH" ;;
esac
