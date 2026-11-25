#!/bin/sh
# Type check the JavaScript listed in types/baseline.json with TypeScript (tsc --noEmit; no build
# step, nothing is emitted or written into the repository). Fails on any error the baseline does
# not already allow. See docs/typing.md.
#
# Usage: scripts/typecheck.sh [--update]      (--update: record the current error counts)
# Finds tsc, in order:
#   $TSC                                       a command, e.g. TSC="node /path/to/typescript/bin/tsc"
#   node_modules/typescript                    in the checkout (the Linux CI image links it there)
#   scripts/ci/node_modules/typescript
#   ~/.cache/atrium-ci/ci-node-<lockfile hash> otherwise installed there from scripts/ci/package-lock.json
#                                              (npm ci, integrity-checked), with Node from PATH or a
#                                              pinned, SHA-checked Node (scripts/ci/install-node.sh)
#                                              under ~/.cache/atrium-ci/node-<version>.
# Env: ATRIUM_CI_CACHE (default ~/.cache/atrium-ci).
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
python3 -B scripts/prepare-assets.py || exit 2
cache=${ATRIUM_CI_CACHE:-$HOME/.cache/atrium-ci}

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  ver=$(sed -n 's/^NODE_VERSION=//p' scripts/ci/install-node.sh)
  dir=$cache/node-$ver
  if [ ! -x "$dir/bin/node" ]; then
    echo "typecheck: installing Node $ver into $dir" >&2
    PREFIX=$dir sh scripts/ci/install-node.sh >&2 || return 1
  fi
  echo "$dir/bin/node"
}

tsc=${TSC:-}
if [ -z "$tsc" ]; then
  for d in node_modules scripts/ci/node_modules; do
    if [ -f "$d/typescript/bin/tsc" ]; then node=$(find_node) && tsc="$node $root/$d/typescript/bin/tsc"; break; fi
  done
fi
if [ -z "$tsc" ]; then
  if command -v sha256sum >/dev/null 2>&1; then hash=$(sha256sum scripts/ci/package-lock.json | cut -c1-12)
  else hash=$(shasum -a 256 scripts/ci/package-lock.json | cut -c1-12); fi
  dir=$cache/ci-node-$hash
  node=$(find_node)
  if [ ! -f "$dir/node_modules/typescript/bin/tsc" ]; then
    echo "typecheck: installing the pinned TypeScript (scripts/ci/package-lock.json) into $dir" >&2
    rm -rf "$dir.tmp" && mkdir -p "$dir.tmp"
    cp scripts/ci/package.json scripts/ci/package-lock.json "$dir.tmp/"
    npm=$(dirname "$node")/npm
    [ -x "$npm" ] || npm=npm
    (cd "$dir.tmp" && PATH=$(dirname "$node"):$PATH "$npm" ci --ignore-scripts --no-audit --no-fund >&2) || { rm -rf "$dir.tmp"; exit 1; }
    rm -rf "$dir" && mv "$dir.tmp" "$dir"
  fi
  tsc="$node $dir/node_modules/typescript/bin/tsc"
fi
exec python3 types/typecheck.py "$tsc" "$@"
