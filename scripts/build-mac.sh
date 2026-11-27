#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python3 -B "$root/scripts/prepare-assets.py"
out=${1:-"$root/dist"}
out=$(mkdir -p "$out" && cd "$out" && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/waffle-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
contents="$stage/Waffle.app/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources" "$stage/cache"
test -f "$root/app/index.html" || { echo "app/index.html is missing" >&2; exit 1; }
cp "$root/native/macos/Info.plist" "$contents/Info.plist"
cp "$root/native/bridge.js" "$contents/Resources/bridge.js"
cp "$root/LICENSE" "$root/THIRD_PARTY_NOTICES.md" "$contents/Resources/"
cp -R "$root/app" "$contents/Resources/app"
python3 -B "$root/scripts/package_payload.py" stage "$contents/Resources"
brand="$root/brand/macos"
icon=Waffle.icns
flavour=${WAFFLE_RELEASE_FLAVOUR:-}
if [ -n "$flavour" ]; then
  slug=$(printf '%s' "$flavour" | LC_ALL=C tr '[:upper:] ' '[:lower:]-')
  case "$slug" in *[!a-z-]*|-*|*-) echo "Invalid release flavour: $flavour" >&2; exit 1 ;; esac
  icon="Waffle-$slug.icns"
fi
test -f "$brand/$icon" || { echo "No app icon for release flavour: $flavour" >&2; exit 1; }
cp "$brand/$icon" "$contents/Resources/Waffle.icns"
cp "$brand/WaffleTemplate.png" "$brand/WaffleTemplate@2x.png" "$contents/Resources/"
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "${arch}-apple-macos12.0" -module-cache-path "$stage/cache" "$root/native/macos/main.swift" "$root/native/macos/FolderTransactions.swift" "$root/native/macos/FolderWatch.swift" "$root/native/macos/ProjectWrites.swift" "$root/native/macos/HostState.swift" "$root/native/macos/ExternalTools.swift" "$root/native/macos/LanRelay.swift" "$root/native/macos/NotebookMedia.swift" "$root/native/macos/NotebookFolderMedia.swift" -o "$stage/Waffle-$arch"
done
xcrun lipo -create "$stage/Waffle-arm64" "$stage/Waffle-x86_64" -output "$contents/MacOS/Waffle"
"$root/scripts/mac-sign.sh" "$stage/Waffle.app" --identifier org.waffle.editor
codesign --verify --strict "$stage/Waffle.app"
# ditto preserves the bundle's executable mode and signing metadata.
ditto "$stage/Waffle.app" "$out/Waffle.app"
echo "$out/Waffle.app"
