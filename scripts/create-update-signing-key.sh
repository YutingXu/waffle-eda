#!/bin/sh
# Run once on the build Mac. Keep a secure backup of the key with the macOS signing secrets.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
secrets="$HOME/Library/Application Support/waffle-release-signing"
umask 077
[ -d "$secrets" ] && [ ! -L "$secrets" ] && [ "$(stat -f '%u:%Lp' "$secrets")" = "$(id -u):700" ] || {
  echo "Run scripts/create-signing-identity.sh first. The signing secrets folder must be owned by the build user with mode 0700." >&2
  exit 1
}
exec python3 -B "$root/scripts/release-manifest.py" keygen "$secrets/update-ed25519.pem"
