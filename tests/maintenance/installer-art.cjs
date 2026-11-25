"use strict";
// The macOS installer window (scripts/build-dmg.sh, preview feedback 20 November 2026): both
// backgrounds hold a 1x and a 2x image, 600 × 440 points (taller than the 600 × 394 window's content); an ad hoc or un-notarised
// build shows the one with the Open Anyway steps; Read Me First repeats them; and the icons sit
// where the background expects them (installer-layout.dsstore, documented in the page source).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const mac = path.join(__dirname, "../../native/macos"), read = f => new Uint8Array(fs.readFileSync(f));
const text = f => fs.readFileSync(f, "utf8");

// TIFF: every image file directory's width, height and resolution.
function tiffImages(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), le = bytes[0] === 0x49;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le), out = [];
  for (let ifd = u32(4); ifd; ) {
    const n = u16(ifd), img = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + 12 * i, tag = u16(e), type = u16(e + 2);
      const value = type === 3 ? u16(e + 8) : type === 5 ? u32(u32(e + 8)) / u32(u32(e + 8) + 4) : u32(e + 8);
      if (tag === 256) img.width = value; else if (tag === 257) img.height = value; else if (tag === 282) img.dpi = value;
    }
    out.push(img);
    ifd = u32(ifd + 2 + 12 * n);
  }
  return out;
}
for (const name of ["installer-background.tiff", "installer-background-preview.tiff"]) {
  assert.deepEqual(tiffImages(read(path.join(mac, name))), [{width: 600, height: 440, dpi: 72}, {width: 1200, height: 880, dpi: 144}], name + ": 1x and 2x");
}

// .DS_Store icon locations ("Iloc" blobs: x and y of each icon's centre).
function iconLocations(bytes) {
  const out = {}, dec = new TextDecoder("utf-16be");
  for (let i = 8; i + 24 < bytes.length; i++) {
    if (String.fromCharCode(...bytes.subarray(i, i + 8)) !== "Ilocblob") continue;
    for (let n = 1; n < 64 && i - 4 - 2 * n >= 0; n++) {
      const at = i - 2 * n - 4, len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
      if (len !== n) continue;
      const v = new DataView(bytes.buffer, bytes.byteOffset + i + 12, 8);
      out[dec.decode(bytes.subarray(at + 4, i))] = [v.getUint32(0), v.getUint32(4)];
      break;
    }
  }
  return out;
}
const layout = read(path.join(mac, "installer-layout.dsstore"));
const icons = iconLocations(layout);
const page = text(path.join(mac, "installer-background.html"));
assert.deepEqual(Object.keys(icons), ["Applications", "Read Me First.txt", "Waffle.app"], "Finder B-tree keys stay sorted after the rename");
for (const [name, [x, y]] of Object.entries({"Waffle.app": [143, 120], "Applications": [457, 120], "Read Me First.txt": [457, 262]})) {
  assert.deepEqual(icons[name], [x, y], name + " where the installer layout puts it");
  assert.ok(page.includes(name + " (" + x + ", " + y + ")"), "the background page draws around " + name);
}
assert.match(page, /Open Anyway/, "the preview background explains Open Anyway");

// build-dmg.sh: the preview background and the Read Me steps for builds macOS has not notarised.
const dmg = text(path.join(__dirname, "../../scripts/build-dmg.sh"));
const volume = /^volume="([^"]+)"$/m.exec(dmg)?.[1];
assert.equal(volume, "Waffle EDA Installer");
assert.ok(new TextDecoder().decode(layout).includes("/Volumes/" + volume), "Finder can locate the background on the named volume");
assert.match(dmg, /if \[ "\$identity" = "-" \] \|\| \[ -z "\$notary_profile" \]; then unverified=1; fi/);
assert.ok(dmg.includes('installer-background${unverified:+-preview}.tiff'), "an unverified build copies the preview background");
for (const step of ["click Done", "Privacy & Security", "Open Anyway", "Control-click"]) assert.ok(dmg.includes(step), "Read Me First: " + step);
console.log("installer-art: ok");
