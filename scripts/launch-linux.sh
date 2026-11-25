#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if command -v python3 >/dev/null 2>&1; then
  case "${1:-}" in
    --help|--version|-h) ;;
    *) python3 -B "$root/scripts/prepare-assets.py" ;;
  esac
  exec python3 "$root/native/linux/waffle.py" "$@"
fi
if [ "$#" -gt 0 ]; then
  echo 'Opening a project from this launcher requires Python 3 and the Waffle desktop host.' >&2
  exit 1
fi
if [ ! -f "$root/app/translator-table.js" ]; then
  echo 'Install Python 3 to prepare the editor from this source checkout.' >&2
  exit 1
fi
exec xdg-open "$root/app/index.html"
