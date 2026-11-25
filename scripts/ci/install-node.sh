#!/bin/sh
# Installs a pinned Node.js release into $PREFIX (default /usr/local) after checking its SHA-256
# against the value recorded here (copied from https://nodejs.org/dist/vX/SHASUMS256.txt).
# Used by the Linux CI image (scripts/ci/linux.Dockerfile); also works in user space, on Linux or
# macOS (scripts/typecheck.sh installs it under ~/.cache/atrium-ci this way):
#   PREFIX=$HOME/.local/node scripts/ci/install-node.sh
set -eu
NODE_VERSION=v24.22.3
PREFIX=${PREFIX:-/usr/local}
case "$(uname -s)-$(uname -m)" in
  Linux-aarch64|Linux-arm64) arch=linux-arm64;  sha=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;;
  Linux-x86_64|Linux-amd64)  arch=linux-x64;    sha=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;;
  Darwin-arm64)              arch=darwin-arm64; sha=1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5 ;;
  Darwin-x86_64)             arch=darwin-x64;   sha=4daeec962855c1a6e66cda398a25037319dc1bbd4a0939188b3547afbbfb6490 ;;
  *) echo "install-node: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
file=node-$NODE_VERSION-$arch.tar.xz
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$file" "https://nodejs.org/dist/$NODE_VERSION/$file"
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/$file" | cut -d' ' -f1); else actual=$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1); fi
[ "$actual" = "$sha" ] || { echo "install-node: SHA-256 mismatch for $file" >&2; exit 1; }
mkdir -p "$PREFIX"
tar -xJf "$tmp/$file" -C "$PREFIX" --strip-components=1 --no-same-owner
"$PREFIX/bin/node" --version >&2
