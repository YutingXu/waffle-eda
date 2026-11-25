"use strict";
// Panel docking and workspace layouts (app/editor/dock.js): the pure layout model, the built-in layouts,
// and the wiring in the shared files (the eager snippet, the lazy registration, Window › Layouts,
// keys, preferences, headless coverage). The DOM side is checked in headless Chrome and WKWebView
//.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh dock).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "../.."), read = f => fs.readFileSync(path.join(root, f), "utf8");

require("../../app/editor/dock.js");
const D = globalThis.AtriumDock;
const ids = L => Object.fromEntries(["left", "right", "bottom"].map(a => [a, L.areas[a].map(g => g.panels.join("+"))]));
const previousDefault = {v:1, name:"Default", custom:false, areas:{
  left:[{panels:["projects"], auto:true}, {panels:["components", "library"]}], right:[{panels:["properties"]}],
  bottom:[{panels:["messages", "pcb-list", "scripting"]}]}};

// ---- built-ins ---------------------------------------------------------------------------------------
{
  const def = D.builtin("default");
  assert.deepEqual(ids(def), {left: ["projects"], right: ["properties+components+library+nets+messages+pcb-list+scripting"], bottom: []});
  assert.deepEqual(ids(D.restoreLayout(previousDefault)), ids(def), "untouched preview layouts gain the right-hand panels");
  assert.equal(D.locate(D.restoreLayout({...previousDefault, name:"My layout"}), "library").where, "left", "saved custom placements survive");
  assert.equal(def.name, "Default"); assert.equal(def.custom, false, "Default keeps the startup panels where index.html has them");
  assert.equal(def.areas.left[0].auto, true, "Projects sizes to its tree");
  for (const k of ["schematic", "pcb", "review"]) {
    const L = D.builtin(k);
    assert.ok(L.name && Array.isArray(L.open), k + " has a name and the panels it opens");
    for (const id of ["projects", "components", "properties"]) assert.ok(D.locate(L, id), k + " keeps " + id);
    // One docking convention: browse and tool panels on the right, the project tree and Navigator on the left.
    for (const id of ["properties", "components", "library", "nets", "filter", "comments", "messages", "pcb-list", "scripting"]) if (D.locate(L, id)) assert.equal(D.locate(L, id).where, "right", k + " docks " + id + " on the right");
    for (const id of ["projects", "navigator"]) if (D.locate(L, id)) assert.equal(D.locate(L, id).where, "left", k + " docks " + id + " on the left");
  }
  assert.equal(D.builtin("pcb").hide.left, true, "PCB Routing folds the left side bar");
  assert.deepEqual(D.builtin("pcb").open, ["nets"]);
  assert.equal(D.builtin("nope"), null);
  // Built-ins are frozen data: builtin() hands out copies.
  const a = D.builtin("default"); a.areas.left.length = 0; assert.equal(D.builtin("default").areas.left.length, 1);
}

// ---- normalize ---------------------------------------------------------------------------------------
{
  const L = D.normalize({areas: {left: [{panels: ["navigator", "navigator", 7, ""]}, {panels: []}], right: [{panels: ["navigator", "filter"], active: "zzz", size: 5}]},
    sizes: {left: 20, right: "300", bottom: "x"}, hide: {left: 1, bottom: true}, floats: [{panels: ["calc"], x: -50, w: 10}]});
  assert.deepEqual(L.areas.left.map(g => g.panels), [["projects"], ["navigator"]], "duplicates and junk dropped; core panels restored");
  assert.deepEqual(L.areas.right[0].panels, ["properties", "filter", "components"]);
  assert.equal(L.areas.right[0].active, "filter", "an unknown active tab falls back to the group's first panel (Properties joins after)");
  assert.equal(L.areas.right[0].size, D.MIN.group, "group sizes clamp");
  assert.deepEqual(L.sizes, {left: D.MIN.left, right: 300}, "side sizes clamp; junk dropped");
  assert.deepEqual(L.hide, {left: true}, "only the side bars collapse");
  assert.deepEqual([L.floats[0].x, L.floats[0].w], [0, D.MIN.floatW]);
  assert.equal(L.custom, true);
  assert.deepEqual(D.normalize(null).areas.right[0].panels, ["properties", "components"], "anything normalizes");
  assert.deepEqual(D.normalize(JSON.parse(JSON.stringify(D.builtin("review")))), D.builtin("review"), "idempotent");
}

// ---- move / remove / place / activate ----------------------------------------------------------------
{
  let L = D.place(D.normalize(previousDefault), "navigator", "left");
  assert.deepEqual(L.areas.left[1].panels, ["components", "library", "navigator"], "a new panel joins its side's last group as a tab");
  assert.equal(D.place(L, "navigator", "right"), L, "placing a known panel is a no-op");
  L = D.move(L, "navigator", {area: "right", mode: "tab", group: 0});
  assert.deepEqual(ids(L).right, ["properties+navigator"]); assert.equal(L.areas.right[0].active, "navigator");
  assert.equal(L.name, null, "a move makes the layout custom-named");
  L = D.move(L, "navigator", {area: "right", mode: "after", group: 0});
  assert.deepEqual(ids(L).right, ["properties", "navigator"], "split below");
  assert.deepEqual(ids(D.move(L, "navigator", {area: "right", mode: "before", group: 1})).right, ["properties", "navigator"], "splitting a lone panel off itself is a no-op");
  L = D.move(L, "navigator", {area: "bottom", mode: "before", group: 0});
  assert.deepEqual(ids(L).bottom, ["navigator", "messages+pcb-list+scripting"], "split left of a bottom group");
  assert.deepEqual(ids(L).right, ["properties"], "the emptied group is gone");
  L = D.move(L, "navigator", {area: "float", rect: {x: 10, y: 20, w: 300, h: 200}});
  assert.deepEqual(L.floats.map(f => [f.panels, f.x, f.y, f.w, f.h]), [[["navigator"], 10, 20, 300, 200]]);
  L = D.move(L, "filter", {area: "float", mode: "tab", group: 0});
  assert.deepEqual(L.floats[0].panels, ["navigator", "filter"], "a panel can join a floating window as a tab");
  L = D.move(L, "navigator", {area: "left", mode: "end"});
  assert.deepEqual(ids(L).left, ["projects", "components+library", "navigator"]);
  L = D.activate(L, "library"); assert.equal(L.areas.left[1].active, "library");
  L = D.remove(L, "library"); assert.equal(L.areas.left[1].active, "components", "removing the active tab picks a neighbour");
  L = D.move(L, "properties", {area: "left", mode: "tab", group: 1});
  assert.equal(L.custom, true, "Properties in the left side bar needs the module before first paint");
  assert.deepEqual(ids(L).right, []);
  L = D.remove(L, "properties");
  assert.deepEqual(ids(L).right, ["properties"], "core panels cannot be removed");
  assert.equal(D.move(L, "navigator", {area: "nowhere"}).areas.left.length, L.areas.left.length, "an unknown area changes nothing");
  assert.equal(D.locate(L, "missing"), null);
}

// ---- wiring in shared files --------------------------------------------------------------------------
{
  const html = read("app/index.html");
  const eager = html.match(/<script>\/\* dock: the saved workspace layout[\s\S]*?<\/script>/);
  assert.ok(eager, "eager snippet before first paint");
  assert.ok(eager[0].length < 1200, "the eager snippet stays tiny: " + eager[0].length);
  assert.ok(html.indexOf(eager[0]) < html.indexOf('<main id="workbench"'), "it runs before the workbench is parsed");
  assert.ok(/AtriumLazy\.register\("AtriumDock",\{scripts:\["editor\/dock\.js"\],css:\["editor\/dock\.css"\](?:,deps:\[[^\]]+\])?\}/.test(html), "dock.js is lazy");
  for (const a of ["layout-save", "layout-manage", "layout-default", "layout-schematic", "layout-pcb", "layout-review", "layout-auto", "move-panel", "zen-mode", "focus-pane-other"])
    assert.ok(html.includes('data-action="' + a + '"'), "Window menu has " + a);
  assert.ok(html.includes("<hr data-dock-user>"), "saved layouts have a place in Window › Layouts");
  const km = read("app/editor/keymap.js");
  assert.ok(km.includes('["F6","focus-part-next"],["Shift+F6","focus-part-prev"],["Mod+K Z","zen-mode"]'));
  assert.ok(!/\["F6","focus-pane-other"\]/.test(km), "F6 cycles parts (panes included), not only panes");
  const dock = read("app/editor/dock.js");
  assert.ok(dock.includes('"general.layoutByKind"') && read("app/editor/prefs.js").includes('"general.layoutByKind": ["editor/dock.js"]'), "Preferences reader for the auto switch");
  for (const a of ["move-panel", "zen-mode", "layout-save", "focus-part-next"]) assert.ok(read("mcp/commands.py").includes('"' + a + '": I(VIEW)'), "headless coverage: " + a);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(read("app/editor/dock.css")), "dock.css uses tokens only");
}
console.log("dock ok");
