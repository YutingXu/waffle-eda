"use strict";
// The customisable bars model (app/editor/bars.js, headless): normalising stored values, the default
// read from the static #tools markup, unknown ids, limits, malformed data and per-kind storage.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {appFile} = require("../support/app-source-paths.cjs");
const B = require(appFile("editor/bars.js"));
const {SEP, LIMITS} = B;

// The markup's entries, as bars.js reads them from the DOM: [{id, scope} | {sep:true}].
const html = fs.readFileSync(appFile("index.html"), "utf8");
const bar = html.slice(html.indexOf('<div id="tools"'), html.indexOf("</div>", html.indexOf('<div id="tools"')));
const entries = [...bar.matchAll(/<span class="tool-divider"[^>]*>|<button\b([^>]*)>/g)].map(m => {
  if (!m[1]) return {sep:true};
  const attr = name => (new RegExp("\\s" + name + '="([^"]*)"').exec(m[1]) || [])[1];
  return {id:attr("data-power-net") ? "power:" + attr("data-power-net") : attr("data-action"), scope:attr("data-scope") || ""};
});

{
  // The default is the markup, per kind: scoped buttons only on their kind, separators tidied.
  assert.deepEqual(B.defaults(entries, "schematic"),
    ["select", "pan", SEP, "library", "route", "junction", "label", "power:GND", "power:VDD", "insert-palette", SEP, "measure", "comment-mode"]);
  assert.deepEqual(B.defaults(entries, "pcb"), ["select", "pan", SEP, "library", "route", "via", "label", SEP, "measure", "comment-mode"]);
  assert.deepEqual(B.defaults(entries, "drawing").filter(id => id.startsWith("drawing-")),
    ["drawing-view", "drawing-dim-linear", "drawing-callout", "drawing-table", "drawing-text", "drawing-line"]);
  // Extension buttons follow, for the kinds their context allows.
  const extra = [{id:"ext.a", when:""}, {id:"ext.pcb", when:"pcb"}];
  const allows = (when, kind) => !when || when === kind;
  assert.deepEqual(B.defaults(entries, "schematic", extra, allows).slice(-2), ["comment-mode", "ext.a"]);
  assert.deepEqual(B.defaults(entries, "pcb", extra, allows).slice(-2), ["ext.a", "ext.pcb"]);
}
{
  // Malformed values are no bar at all: the editor draws the default.
  for (const bad of [null, undefined, 3, "x", [], {}, {version:2, active:{}}, {active:[]}, {active:"pcb"}, {version:"1", active:{}}])
    assert.equal(B.normalize(bad), null, JSON.stringify(bad));
  // Items keep their shape; anything else is dropped, kinds must look like kinds.
  const v = B.normalize({version:1, active:{
    pcb:["select", SEP, {face:"route", more:["route-diffpair", 7, "", "length-tune"]}, {face:3}, {more:["x"]}, "", " spaced ", "a\"b", null, ["nested"], "power:+3V3"],
    "Bad Kind":["select"], schematic:"select", drawing:[]}});
  assert.deepEqual(v, {version:1, active:{
    pcb:["select", SEP, {face:"route", more:["route-diffpair", "length-tune"]}, "power:+3V3"], drawing:[]}});
  // A missing version reads as version 1.
  assert.deepEqual(B.normalize({active:{pcb:["pan"]}}), {version:1, active:{pcb:["pan"]}});
  // Unknown ids are kept: the registry decides later whether they draw.
  assert.deepEqual(B.normalize({version:1, active:{pcb:["ext.switched-off.command", "butter.macros.alias.gone"]}}).active.pcb,
    ["ext.switched-off.command", "butter.macros.alias.gone"]);
}
{
  // Limits: 24 items per bar, 16 per flyout.
  const many = Array.from({length:40}, (_, i) => "cmd-" + i);
  const v = B.normalize({version:1, active:{pcb:[...many, {face:"route", more:many}]}});
  assert.equal(LIMITS.bar, 24); assert.equal(LIMITS.flyout, 16);
  assert.equal(v.active.pcb.length, 24);
  assert.equal(B.normalize({version:1, active:{pcb:[{face:"route", more:many}]}}).active.pcb[0].more.length, 16);
}
{
  // Storing: only kinds that differ from the default, nothing at all when no kind differs.
  const def = B.defaults(entries, "pcb");
  assert.equal(B.put(null, "pcb", def, def), null, "a bar equal to the default is not stored");
  const one = B.put(null, "pcb", ["select", "via"], def);
  assert.deepEqual(one, {version:1, active:{pcb:["select", "via"]}});
  const two = B.put(one, "schematic", ["select"], B.defaults(entries, "schematic"));
  assert.deepEqual(Object.keys(two.active).sort(), ["pcb", "schematic"]);
  assert.deepEqual(B.put(two, "pcb", null, def), {version:1, active:{schematic:["select"]}}, "null restores one kind");
  assert.equal(B.put({version:1, active:{pcb:["x"]}}, "pcb", def, def), null);
  // A malformed stored value is replaced, not merged.
  assert.deepEqual(B.put("garbage", "pcb", ["pan"], def), {version:1, active:{pcb:["pan"]}});
}
{
  // Flyouts and separators.
  assert.deepEqual(B.members({face:"route", more:["a", "b"]}), ["route", "a", "b"]);
  assert.deepEqual(B.members({face:"route", more:["a", "route", "b"]}), ["a", "route", "b"], "the list may place the face");
  assert.deepEqual(B.members("route"), []);
  assert.deepEqual(B.tidy([SEP, "a", SEP, SEP, "b", SEP]), ["a", SEP, "b"]);
}
{
  // Sticky flyout faces: per kind and button; ids or provided entries; junk dropped.
  assert.deepEqual(B.cleanFaces({schematic:{select:"pan", "insert-palette":{id:"widget:todo", label:"To-do list", icon:"", group:"widgets"}, bad:3},
    pcb:{}, drawing:"x", nope:{"a b":"c"}}),
    {schematic:{select:"pan", "insert-palette":{id:"widget:todo", label:"To-do list", icon:"", group:"widgets"}}});
  assert.deepEqual(B.cleanFaces("[]"), {});
}
console.log("bars model: ok");
