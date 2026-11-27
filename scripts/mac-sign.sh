#!/bin/sh
# Sign one macOS app bundle or disk image for a Waffle build.
#
#   scripts/mac-sign.sh PATH [--identifier ID]
#
# WAFFLE_SIGN_IDENTITY unset: ad hoc (the identity is the build's own hash, so macOS treats
#   every release as a new app).
# WAFFLE_SIGN_IDENTITY="Waffle EDA": the stable self-signed identity from
#   scripts/create-signing-identity.sh. Its keychain is unlocked with the password that script
#   keeps in ~/Library/Application Support/waffle-release-signing. The designated requirement is the identifier plus the certificate, the same
#   for every release, so approvals and permissions carry over. The signature must carry the
#   certificate in native/macos/signing-leaf.txt (WAFFLE_SIGN_LEAF overrides it, e.g. for tests).
# Developer ID signing and notarisation stay in build-dmg.sh (ATRIUM_SIGN_IDENTITY).
set -eu
path=$1; shift
identity=${WAFFLE_SIGN_IDENTITY:-}
if [ -z "$identity" ]; then
  codesign --force --sign - "$@" "$path"
  exit 0
fi
keychain=${WAFFLE_SIGN_KEYCHAIN:-"$HOME/Library/Keychains/waffle-release-signing.keychain-db"}
[ -f "$keychain" ] || { echo "No signing keychain at $keychain; run scripts/create-signing-identity.sh" >&2; exit 1; }
secret="$HOME/Library/Application Support/waffle-release-signing/keychain-password"
[ -f "$secret" ] || { echo "No signing keychain password at $secret" >&2; exit 1; }
password=$(cat "$secret")
security unlock-keychain -p "$password" "$keychain"
codesign --force --sign "$identity" --keychain "$keychain" --timestamp=none "$@" "$path"
requirement=$(codesign -d -r- "$path" 2>&1)
case "$requirement" in *"certificate leaf = H\""*) ;; *) echo "$path: expected a certificate designated requirement" >&2; exit 1 ;; esac
# The release certificate's public SHA-1 (native/macos/signing-leaf.txt) unless WAFFLE_SIGN_LEAF says otherwise.
leaf=${WAFFLE_SIGN_LEAF:-$(cat "$(dirname -- "$0")/../native/macos/signing-leaf.txt")}
case "$requirement" in *"certificate leaf = H\"$leaf\""*) ;; *) echo "$path: signed with a different certificate than $leaf" >&2; exit 1 ;; esac
