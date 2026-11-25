"use strict";
// The browser and each installed desktop host must carry the same Stack assets.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "../..");
const read = name => new Uint8Array(fs.readFileSync(path.join(root, name)));
const text = name => fs.readFileSync(path.join(root, name), "utf8");
const pngSize = bytes => {
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};
for (const [source, names] of [
  ["web", ["favicon.svg", "favicon-16.png", "favicon.png", "icon-192.png"]],
  ["svg", ["waffle-lockup-eda-on-light.svg", "waffle-lockup-eda-on-dark.svg", "waffle-mark-butter.svg"]]
]) {
  for (const name of names) {
    assert.deepEqual(read("app/brand/" + name), read("brand/" + source + "/" + name), "webview copy of " + name);
  }
}
for (const [file, size] of Object.entries({
  "brand/macos/WaffleTemplate.png": 16,
  "brand/macos/WaffleTemplate@2x.png": 32,
  "native/windows/packaging/Assets/Square44x44Logo.png": 44,
  "native/windows/packaging/Assets/StoreLogo.png": 50,
  "native/windows/packaging/Assets/Square150x150Logo.png": 150
})) {
  assert.deepEqual(pngSize(read(file)), [size, size], file);
}
const index = text("app/index.html");
assert.match(index, /rel="icon"[^\n]+href="brand\/favicon\.svg"/);
assert.match(index, /rel="apple-touch-icon"[^\n]+href="brand\/icon-192\.png"/);
const ico = read("brand/windows/waffle.ico");
const directory = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
assert.deepEqual([directory.getUint16(2, true), directory.getUint16(4, true)], [1, 6]);
for (const [i, size] of [16, 24, 32, 48, 64, 256].entries()) {
  const pos = 6 + i * 16, length = directory.getUint32(pos + 8, true), start = directory.getUint32(pos + 12, true);
  assert.deepEqual(pngSize(ico.slice(start, start + length)), [size, size], "Windows icon slot " + size);
}
console.log("brand-assets: ok");
