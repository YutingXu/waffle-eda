"use strict";
// Runs __NAME__ in Waffle's extension sandbox harness (a separate JS realm, the real
// permission checks, an in-memory example project).
//   macOS (no Node):  /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc __WAFFLE__/tests/jsc-shim.js -- "$PWD/test.cjs"
//   Node 18+:         node test.cjs
const WAFFLE = "__WAFFLE__"; // path to your Waffle checkout, relative to this folder
const harness = require(WAFFLE + "/extensions/examples/harness.cjs");

module.exports = async function test(h, dir) {
  const {assert, X} = h;
  await X.install(h.files(dir));
  assert.deepEqual(X.permissions("__ID__").declared, ["read:project", "ui:command", "ui:panel"]);
  h.open("pcb");
  const counts = await X.execute("__PREFIX__.show");
  assert.ok(counts.part > 0, "the example board has components");
  const view = h.panel("__ID__", "__PREFIX__");
  assert.ok(view.some(v => v.type === "table" && v.rows.some(r => r.kind === "part")), "the panel lists them");
  h.reset();
};

if (require.main === module) harness.run(module.exports, __dirname);
