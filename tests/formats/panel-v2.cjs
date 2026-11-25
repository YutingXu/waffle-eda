"use strict";
// Panelisation v2 (app/pcb/panel.js): presets, separate X/Y gaps, alternating rotation,
// dragged (manual) tabs, copper thieving, routing-bit fillets, the component checks (tabs on
// components and edge connectors, V-score through components, overhangs), the panel drawing,
// fill-a-size, the headless report/setup and format compatibility (old panels unchanged, unknown
// fields kept).
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "altium-rules", "rules", "connectivity", "drc", "messages", "erc", "spatial", "stackup", "pcb-pours", "pcb-appearance", "board-shape",
  "rigid-flex", "zip", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "bom", "panel"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const {check: gerberCheck} = require("./gerber-check.cjs");
const A = Atrium, P = AtriumPanel;
const date = new Date(Date.UTC(2026, 10, 19, 12));
const boardOf = p => p.documents.find(d => d.kind === "pcb");
function withPanel(options = {}) { const p = AtriumParts.example(), b = boardOf(p), d = P.create(p, {board: b.id, ...options}); p.documents.push(d); return {p, b, d}; }
const rectangular = b => { b.outline = [[0, 0], [36, 0], [36, 22], [0, 22]]; delete b.boardShape; return b; };
const gerbersClean = r => { for (const f of r.files.filter(f => f.kind === "gerber")) assert.deepEqual(gerberCheck(f.content).issues, [], f.name); };
const codes = c => c.items.map(i => i.code);

// ---- format: old panels are unchanged, new fields optional, unknown fields kept ----------------
{
  const {p, d} = withPanel({rows: 2, cols: 3});
  const n = P.normalize(d.panel);
  for (const k of ["spacingY", "alternate", "thieving", "mill", "preset"]) assert.ok(!(k in n), k + " is absent unless set");
  assert.ok(!("manual" in n.tabs));
  const G = P.layout(p, d, null, {date});
  assert.deepEqual([G.W, G.H], [112, 60], "a version-1 panel lays out as before");
  // A newer Waffle's field survives normalize and validation (forward compatibility).
  d.panel = {...d.panel, futureField: {x: 1}};
  assert.deepEqual(P.normalize(d.panel).futureField, {x: 1});
  A.validate(JSON.parse(JSON.stringify(p)));
  assert.throws(() => P.validate({board: "b", alternate: "diagonal"}), /alternate/);
  assert.throws(() => P.validate({board: "b", spacingY: "3"}), /spacingY/);
  assert.throws(() => P.validate({board: "b", tabs: {manual: []}}), /manual/);
  // Equal X and Y gaps store one value; out-of-range manual keys are dropped.
  const m = P.normalize({board: "b", rows: 2, cols: 2, spacing: 2, spacingY: 2, tabs: {manual: {"5,5:top": [.5], "0,0:left": [.9, .1, 2]}}});
  assert.ok(!("spacingY" in m));
  assert.deepEqual(m.tabs.manual, {"0,0:left": [.1, .9, 1]});
}

// ---- separate X / Y gaps and alternating rotation ------------------------------------------
{
  const {p, d} = withPanel({rows: 2, cols: 2, spacing: 2, spacingY: 5});
  const G = P.layout(p, d);
  assert.equal(G.spacingX, 2); assert.equal(G.spacingY, 5);
  assert.equal(G.instances[2].box[1] - G.instances[0].box[3], 5, "row gap");
  assert.equal(G.instances[1].box[0] - G.instances[0].box[2], 2, "column gap");
  // Rails keep the row gap as their routing gap.
  assert.equal(G.instances[0].box[1] - G.rails.find(r => r.side === "top").rect[3], 5);
  for (const [alt, want] of [["rows", "0,0,180,180"], ["cols", "0,180,0,180"], ["both", "0,180,180,0"]]) {
    d.panel = P.normalize({...d.panel, alternate: alt});
    assert.equal(P.layout(p, d).instances.map(i => i.rotation).join(), want, alt);
  }
  // A cell's own rotation wins over the alternation.
  d.panel = P.normalize({...d.panel, alternate: "both", cells: {"0,1": {rotation: 90}}});
  assert.equal(P.layout(p, d).instances[1].rotation, 90);
  gerbersClean(P.build(p, d, {date}));
}

// ---- dragged tabs -------------------------------------------------------------------------
{
  const {p, d} = withPanel({rows: 1, cols: 2, rails: {top: false, bottom: false, left: false, right: false, width: 5}, tabs: {perEdge: 2, width: 3}});
  let G = P.layout(p, d);
  const between = G.tabs.filter(t => t.key === "0,0:right");
  assert.equal(between.length, 2); assert.deepEqual(between.map(t => r4(t.frac)), [.3333, .6667]);
  d.panel = P.normalize({...d.panel, tabs: {...d.panel.tabs, manual: {"0,0:right": [.25]}}});
  G = P.layout(p, d);
  const t = G.tabs.filter(t => t.key === "0,0:right");
  assert.equal(t.length, 1); assert.ok(t[0].manual);
  const inst = G.instances[0], centre = (t[0].rect[1] + t[0].rect[3]) / 2;
  assert.ok(Math.abs(centre - (inst.box[1] + .25 * 22)) < 1e-6, "the tab sits where it was dragged");
  // Near the end of the edge the tab is clamped onto the board edge; an empty list removes the edge's tabs.
  d.panel = P.normalize({...d.panel, tabs: {...d.panel.tabs, manual: {"0,0:right": [0]}}});
  assert.ok(Math.abs(P.layout(p, d).tabs.find(x => x.key === "0,0:right").rect[1] - inst.box[1]) < 1e-6);
  d.panel = P.normalize({...d.panel, tabs: {...d.panel.tabs, manual: {"0,0:right": []}}});
  const C = P.check(p, d);
  assert.ok(codes(C).includes("pieces") || codes(C).includes("no-tabs"), "no tab holds the two boards: " + codes(C));
}
function r4(v) { return Math.round(v * 1e4) / 1e4; }

// ---- copper thieving ----------------------------------------------------------------------
{
  const {p, d} = withPanel({rows: 2, cols: 2});
  d.panel = P.applyPreset(d.panel, "assembly-frame");
  const G = P.layout(p, d);
  assert.ok(G.thieving.dots.length > 100);
  const T = d.panel.thieving;
  for (const q of G.thieving.dots) {
    assert.ok(G.rails.some(r => q[0] - T.size / 2 >= r.rect[0] + T.clearance - 1e-6 && q[0] + T.size / 2 <= r.rect[2] - T.clearance + 1e-6 &&
      q[1] - T.size / 2 >= r.rect[1] + T.clearance - 1e-6 && q[1] + T.size / 2 <= r.rect[3] - T.clearance + 1e-6), "dot inside a rail");
    for (const f of G.fiducials) assert.ok(Math.hypot(q[0] - f.at[0], q[1] - f.at[1]) > f.opening / 2 + T.clearance + T.size / 2 - 1e-6, "clear of fiducials");
    for (const h of G.tooling) assert.ok(Math.hypot(q[0] - h.at[0], q[1] - h.at[1]) > h.d / 2 + T.clearance + T.size / 2 - 1e-6, "clear of tooling holes");
  }
  assert.equal(new Set(G.thieving.dots.map(q => q.join())).size, G.thieving.dots.length, "one dot per spot where rails overlap");
  const m = P.analyse(p, d, {date});
  for (const layer of m.stack) assert.ok(m.layers.get(layer).filter(f => f.fn === "NonConductor").length >= G.thieving.dots.length, layer);
  assert.ok(!P.check(p, d).items.some(i => i.level === "error"));
  d.panel = P.normalize({...d.panel, thieving: {...d.panel.thieving, pattern: "hatch"}});
  const H = P.layout(p, d);
  assert.ok(H.thieving.hatch.length > 10 && !H.thieving.dots.length);
  gerbersClean(P.build(p, d, {date}));
  // Off by default and in old panels.
  assert.equal(P.layout(p, withPanel().d).thieving.dots.length, 0);
}

// ---- routing-bit fillets --------------------------------------------------------------------
{
  const {p, d} = withPanel({rows: 2, cols: 2, mill: {radius: .8}});
  const G = P.layout(p, d), arcs = [...G.profile.segs.outer.flat(), ...G.profile.segs.holes.flat()].filter(s => s.kind === "arc");
  assert.ok(arcs.length >= 8, "inside corners filleted");
  assert.ok(arcs.every(a => a.r <= .8 + 1e-9 && a.r > 0));
  // Every segment chains end to start (a closed, continuous contour).
  const at = (c, r, a) => [c[0] + r * Math.cos(a * Math.PI / 180), c[1] - r * Math.sin(a * Math.PI / 180)];
  for (const loop of [...G.profile.segs.outer, ...G.profile.segs.holes]) loop.forEach((s, i) => {
    const n = loop[(i + 1) % loop.length], end = s.kind === "arc" ? at(s.c, s.r, s.end) : s.b, start = n.kind === "arc" ? at(n.c, n.r, n.start) : n.a;
    assert.ok(Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-4, "continuous at " + i);
  });
  const r = P.build(p, d, {date});
  gerbersClean(r);
  assert.match(r.files.find(f => /\.GM1$/.test(f.name)).content, /G0[23]/);
  assert.ok(AtriumBoardShape.fresh(P.flatten(p, d).doc), "the flat preview's shape is current");
  // A bit wider than the gap is an error.
  d.panel = P.normalize({...d.panel, mill: {radius: 1.5}});
  assert.ok(codes(P.check(p, d)).includes("mill-gap"));
  // Square concave corner: fillet geometry.
  const f = P.fillet([[0, 0], [10, 0], [10, 10], [5, 10], [5, 5], [0, 5]].reverse(), 1);
  assert.ok(f.segs.some(s => s.kind === "arc" && Math.abs(s.r - 1) < 1e-9));
}

// ---- component checks ----------------------------------------------------------------------
{
  // An edge connector (pads on the edge) where a tab lands is an error.
  const {p, b, d} = withPanel({rows: 1, cols: 2, rails: {top: false, bottom: false, left: false, right: false, width: 5}, tabs: {perEdge: 1, width: 3}});
  b.items.push({id: "gf1", kind: "pad", x: 35.6, y: 11, w: 1.5, h: 2, shape: "rect", layer: "Top", number: "1", net: "GND"});
  let c = P.check(p, d);
  assert.ok(c.items.some(i => i.code === "tab-edge-connector" && i.level === "error" && i.at), JSON.stringify(codes(c)));
  // Dragging the tab away clears it.
  d.panel = P.normalize({...d.panel, tabs: {...d.panel.tabs, manual: {"0,0:right": [.15]}}});
  assert.ok(!codes(P.check(p, d)).includes("tab-edge-connector"));
  // A component next to a tab is a warning.
  b.items.pop();
  const def = p.library.find(x => x.footprint?.pads?.length);
  b.items.push({id: "near", kind: "part", def: def.id, ref: "X9", x: 33.5, y: 3.6, angle: 0});
  c = P.check(p, d);
  assert.ok(c.items.some(i => i.code === "tab-component" && i.level === "warning"), JSON.stringify(c.items.map(i => i.code + ":" + i.message)));
}
{
  // V-score through a component is an error; close to it a warning.
  const {p, b, d} = withPanel({rows: 2, cols: 2, separation: "vscore"}); rectangular(b);
  const def = p.library.find(x => x.footprint?.pads?.length);
  b.items.push({id: "over", kind: "part", def: def.id, ref: "X1", x: 35.8, y: 11, angle: 0});
  let c = P.check(p, d);
  assert.ok(c.items.some(i => i.code === "vscore-component" && i.level === "error" && /runs through board \d X1/.test(i.message)), JSON.stringify(codes(c)));
  assert.ok(c.items.some(i => i.code === "part-overhang" && i.level === "error"), "overhangs into the neighbour");
  b.items.at(-1).x = 30;
  c = P.check(p, d);
  assert.ok(!c.items.some(i => i.code === "vscore-component" && i.level === "error"));
}
{
  // The sample panel is clean apart from the local-fiducial note.
  const {p, d} = withPanel({rows: 2, cols: 3});
  assert.deepEqual(P.check(p, d).items.filter(i => i.level !== "info"), []);
  assert.ok(codes(P.check(p, d)).includes("local-fiducials"));
}

// ---- presets ------------------------------------------------------------------------------
{
  const {p, b, d} = withPanel({rows: 3, cols: 1, cells: {"0,0": {rotation: 90}}});
  for (const pr of P.PRESETS) {
    const n = P.applyPreset(d.panel, pr.id);
    assert.equal(n.board, b.id, pr.id + " keeps the board"); assert.equal(n.preset, pr.id);
    assert.deepEqual(n.cells["0,0"], {rotation: 90}, pr.id + " keeps the cells");
    if (pr.params.rows) assert.equal(n.rows, pr.params.rows);
  }
  assert.throws(() => P.applyPreset(d.panel, "nope"), /Unknown panel preset/);
  // Every preset builds clean Gerbers (V-score needs the rectangular board).
  rectangular(b);
  for (const pr of P.PRESETS) {
    const q = withPanel(); rectangular(boardOf(q.p)); q.d.panel = P.applyPreset(q.d.panel, pr.id);
    if (pr.id === "jlc-vscore-2x2") q.d.panel = P.normalize({...q.d.panel, rows: 3, cols: 2});   // 70 mm minimum
    const c = P.check(q.p, q.d);
    assert.deepEqual(c.items.filter(i => i.level === "error"), [], pr.id);
    gerbersClean(P.build(q.p, q.d, {date}));
  }
  // Applying a preset drops dragged tabs and turns thieving off unless the preset sets it.
  d.panel = P.normalize({...P.applyPreset(d.panel, "assembly-frame"), tabs: {...d.panel.tabs, manual: {"0,0:right": [.5]}}});
  const q = P.applyPreset(d.panel, "frame-mousebite");
  assert.ok(!q.tabs.manual); assert.ok(!q.thieving?.enabled);
}

// ---- fill a panel size, drawing, linked boards ------------------------------------------------------
{
  const {p, b, d} = withPanel();
  d.panel = P.applyPreset(d.panel, "mousebite-5mm-rails");
  const f = P.fitArray(p, d, [100, 100]);
  assert.ok(f.count >= 4 && f.size[0] <= 100 && f.size[1] <= 100, JSON.stringify(f));
  d.panel = P.normalize({...d.panel, rows: f.rows, cols: f.cols, rotation: f.rotation});
  const G = P.layout(p, d);
  assert.ok(G.W <= 100 + 1e-6 && G.H <= 100 + 1e-6 && G.instances.length === f.count);
  assert.equal(P.fitArray(p, d, [10, 10]).count, 0);
  const v = withPanel({rows: 3, cols: 2, separation: "vscore"}); rectangular(boardOf(v.p));
  const svg = P.drawing(v.p, v.d, {date}).content;
  assert.match(svg, /V-CUT X 36/); assert.match(svg, /V-CUT Y /); assert.match(svg, /72 mm/);
  assert.equal((svg.match(/<svg /g) || []).length, 1);
  // Linked: editing the board changes the panel without touching the panel document.
  const before = JSON.stringify(d.panel), L0 = P.layout(p, d), a0 = L0.W * L0.H;
  b.outline = b.outline.map(q => [q[0] * 1.1, q[1]]); delete b.boardShape;
  { const L1 = P.layout(p, d); assert.ok(L1.W * L1.H > a0, "the panel grows with its board"); } assert.equal(JSON.stringify(d.panel), before);
}

// ---- headless: panel_report / panel_setup ----------------------------------------------------
{
  const p = AtriumParts.example(), b = boardOf(p);
  const r0 = P.headless(p, {op: "report"});
  assert.equal(r0.exists, false); assert.equal(r0.panel_id, null); assert.equal(p.documents.filter(d => d.kind === "panel").length, 0, "report adds nothing");
  assert.ok(r0.outputs.some(n => /-Panel-Drawing\.svg$/.test(n)));
  const s = P.headless(p, {op: "setup", preset: "frame-mousebite", params: {rows: 2, cols: 3, spacing_y: 3, cells: {"1,2": {rotation: 180}}, thieving: {enabled: true}}});
  assert.equal(s.created, true); assert.equal(s.boards, 6); assert.deepEqual(s.spacing, [2.4, 3]);
  const doc = p.documents.find(d => d.kind === "panel");
  assert.deepEqual(doc.panel.cells, {"0,1": {rotation: 180}}, "cells are 1-based in the API");
  assert.ok(s.thieving > 0);
  const s2 = P.headless(p, {op: "setup", fill: [100, 100]});
  assert.equal(s2.created, false); assert.equal(s2.panel_id, doc.id, "the board's panel is changed, not duplicated");
  assert.ok(s2.size[0] <= 100 && s2.size[1] <= 100);
  const r = P.headless(p, {op: "report", date: date.toISOString()});
  assert.equal(r.exists, true); assert.equal(r.board, b.name); assert.ok(Array.isArray(r.check));
  assert.throws(() => P.headless(p, {op: "setup", preset: "nope"}), /Unknown panel preset/);
  A.validate(JSON.parse(JSON.stringify(p)));
}
console.log("PASS panel-v2: format compatibility, X/Y gaps, alternation, dragged tabs, thieving, fillets, component checks, presets, fill, drawing, linking, headless");
