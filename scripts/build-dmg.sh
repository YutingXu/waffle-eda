#!/bin/sh
# Packages Waffle.app into a drag-to-Applications disk image.
# Usage: scripts/build-dmg.sh [APP] [OUT_DIR]   (defaults: dist/Waffle.app, dist)
# Signing: ad hoc by default, or the stable self-signed identity with WAFFLE_SIGN_IDENTITY
# (scripts/mac-sign.sh). Read Me First explains how to approve the app on first launch.
# With ATRIUM_SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" the app is re-signed with the
# hardened runtime and a timestamp; with ATRIUM_NOTARY_PROFILE (a `xcrun notarytool store-credentials`
# profile name) the image is also notarised and stapled. No credentials are read from the repo.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app=${1:-"$root/dist/Waffle.app"}
out=${2:-"$root/dist"}
test -d "$app/Contents/MacOS" || { echo "not an app bundle: $app" >&2; exit 1; }
out=$(mkdir -p "$out" && cd "$out" && pwd)
version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist")
release_version=$(python3 -B "$root/scripts/release-version.py" --check)
[ "$version" = "$release_version" ] || { echo "App version differs from the release source" >&2; exit 1; }
about=app/editor/about.js
cmp "$root/$about" "$app/Contents/Resources/$about"
release_name=$(python3 -B "$root/scripts/release-version.py" --name)
identity=${ATRIUM_SIGN_IDENTITY:--}
notary_profile=${ATRIUM_NOTARY_PROFILE:-}
stage=$(mktemp -d "${TMPDIR:-/tmp}/waffle-dmg.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir "$stage/root"
ditto "$app" "$stage/root/Waffle.app"
if [ "$identity" = "-" ]; then
  "$root/scripts/mac-sign.sh" "$stage/root/Waffle.app" --identifier org.waffle.editor
else
  codesign --force --options runtime --timestamp --sign "$identity" --identifier org.waffle.editor "$stage/root/Waffle.app"
fi
codesign --verify --strict --deep "$stage/root/Waffle.app"

# Finder reads these bundled view settings on the mounted volume. The background
# reference in the layout uses this volume name and the path /.background.tiff.
# A build macOS has not notarised shows the Open Anyway steps in the window itself
# (scripts/installer-art.sh renders both backgrounds from native/macos/installer-background.html).
volume="Waffle EDA Installer"
unverified=; if [ "$identity" = "-" ] || [ -z "$notary_profile" ]; then unverified=1; fi
cp "$root/native/macos/installer-layout.dsstore" "$stage/root/.DS_Store"
cp "$root/native/macos/installer-background${unverified:+-preview}.tiff" "$stage/root/.background.tiff"
ln -s /Applications "$stage/root/Applications"
{
  printf 'Waffle EDA %s · %s\n\n' "$version" "$release_name"
  cat <<'EOF'
Install

1. In the installer window, drag the Waffle icon onto Applications.
   To update an existing install, quit Waffle first, then replace the old app.
2. When copying finishes, eject the installer disk in Finder.
3. Open Waffle from Applications (Finder › Applications, Launchpad or Spotlight).
EOF
  if [ -n "$unverified" ]; then
    cat <<'EOF'

Opening Waffle for the first time

Apple has not notarised this build, so macOS asks before it first opens.
Check that you got this copy from a source you trust before proceeding.

macOS 15 and later
1. Open Waffle from Applications. macOS says it cannot verify Waffle:
   click Done (not Move to Bin).
2. Open System Settings › Privacy & Security and scroll down to Security.
3. Next to the message about Waffle, click Open Anyway, then confirm with
   your password or Touch ID and click Open Anyway again.
   The button appears for about an hour after step 1; if it is gone, repeat
   step 1.

macOS 12 to 14
1. In Finder › Applications, Control-click (or right-click) Waffle and
   choose Open.
2. Click Open in the dialog.

macOS remembers the choice: later launches open Waffle directly.
EOF
  fi
  cat <<'EOF'

Keep or copy the whole Waffle project folder, including its .waffle manifest,
sheets, boards, libraries, models, assets and hidden .waffle directory when
present. Open the native 2.0 folder or its manifest in Waffle. For designs from
Waffle 1.x, re-import the original EDA source, such as the Altium or KiCad project.
Settings and private recovery data live in the app's Application Support and
WebKit directories. A folder save may also use .waffle/journal/ inside the
project while it finishes.
EOF
} > "$stage/root/Read Me First.txt"

dmg="$out/Waffle-$version.dmg"
rm -f "$dmg"
hdiutil create -quiet -volname "$volume" -srcfolder "$stage/root" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$dmg"
if [ "$identity" = "-" ]; then "$root/scripts/mac-sign.sh" "$dmg"; else codesign --force --sign "$identity" "$dmg"; fi
if [ "$identity" != "-" ] && [ -n "$notary_profile" ]; then
  xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$dmg"
fi
hdiutil verify -quiet "$dmg"
(cd "$out" && shasum -a 256 "$(basename "$dmg")") > "$dmg.sha256"
echo "$dmg"
