#!/bin/zsh
# Renders the Waffle EDA Installer window backgrounds from native/macos/installer-background.html in
# headless Chrome (playwright-core, as the browser tests use), at 1x and 2x, into multi-resolution
# TIFFs that scripts/build-dmg.sh copies:
#   native/macos/installer-background.tiff           Developer ID builds (notarised)
#   native/macos/installer-background-preview.tiff   ad hoc preview builds (adds the Open Anyway steps)
# Usage: scripts/installer-art.sh
# Env: CHROME (default: Google Chrome in /Applications); NODE_PATH must reach playwright-core.
# The icon positions live in native/macos/installer-layout.dsstore; the page draws around them.
set -eu
root=${0:A:h:h}
work=$(mktemp -d "${TMPDIR:-/tmp}/atrium-installer-art.XXXXXX")
trap 'rm -rf "$work"' EXIT
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"} node - "$root/native/macos/installer-background.html" "$work" <<'JS'
const {chromium} = require("playwright-core"), {pathToFileURL} = require("node:url");
const [page, out] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROME});
  try {
    for (const variant of ["release", "preview"]) for (const scale of [1, 2]) {
      const p = await browser.newPage({viewport: {width: 600, height: 440}, deviceScaleFactor: scale});
      await p.goto(pathToFileURL(page).href + (variant === "preview" ? "#preview" : ""));
      await p.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(img => img.decode())]));
      await p.screenshot({path: `${out}/${variant}-${scale}.png`});
      await p.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
JS
for variant in release preview; do
  for scale in 1 2; do
    # The 2x image keeps the 600 x 440 point size: 144 dpi.
    sips -s format tiff -s formatOptions lzw -s dpiWidth $((72 * scale)) -s dpiHeight $((72 * scale)) \
      "$work/$variant-$scale.png" --out "$work/$variant-$scale.tiff" >/dev/null
  done
  out="$root/native/macos/installer-background${${variant:#release}:+-$variant}.tiff"
  tiffutil -cat "$work/$variant-1.tiff" "$work/$variant-2.tiff" -out "$out" 2>/dev/null
  print "$out"
done
