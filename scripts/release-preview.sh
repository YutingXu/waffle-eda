#!/bin/sh
# Build and verify the local preview from HEAD. No uploads or notarisation.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec python3 -B "$root/scripts/release-preview.py" "$@"
