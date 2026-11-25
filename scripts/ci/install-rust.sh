#!/bin/sh
# Installs the Rust toolchain that engine/rust-toolchain.toml pins, with the wasm32-unknown-unknown
# target, in user space (no sudo, no shell profile changes). Used by scripts/ci-local.sh rust on
# macOS; the Linux job builds in the pinned rust image instead (scripts/ci/linux.Dockerfile, stage
# rust). rustup-init 1.28.2 is checked against its SHA-256 below; rustup then checks every toolchain
# component against the channel manifest it downloads over HTTPS.
# Env: CARGO_HOME, RUSTUP_HOME (default ~/.cache/atrium-rust/{cargo,rustup}).
# Prints the path of cargo on stdout; everything else goes to stderr.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
channel=$(sed -n 's/^channel *= *"\(.*\)".*/\1/p' "$root/engine/rust-toolchain.toml")
[ -n "$channel" ] || { echo "engine/rust-toolchain.toml has no channel" >&2; exit 2; }
: "${CARGO_HOME:=$HOME/.cache/atrium-rust/cargo}" "${RUSTUP_HOME:=$HOME/.cache/atrium-rust/rustup}"
export CARGO_HOME RUSTUP_HOME
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  case $(uname -s)-$(uname -m) in
    Darwin-arm64) target=aarch64-apple-darwin sum=20ef5516c31b1ac2290084199ba77dbbcaa1406c45c1d978ca68558ef5964ef5 ;;
    Darwin-x86_64) target=x86_64-apple-darwin sum=9c331076f62b4d0edeae63d9d1c9442d5fe39b37b05025ec8d41c5ed35486496 ;;
    *) echo "install-rust.sh: no pinned rustup-init for $(uname -s)-$(uname -m); install rustup and set CARGO" >&2; exit 2 ;;
  esac
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-rustup.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/rustup-init" "https://static.rust-lang.org/rustup/archive/1.28.2/$target/rustup-init"
  echo "$sum  $tmp/rustup-init" | shasum -a 256 -c - >&2
  chmod 755 "$tmp/rustup-init"
  "$tmp/rustup-init" -y --quiet --no-modify-path --profile minimal --default-toolchain none >&2
fi
"$CARGO_HOME/bin/rustup" toolchain install "$channel" --profile minimal --target wasm32-unknown-unknown --no-self-update >&2
echo "$CARGO_HOME/bin/cargo"
