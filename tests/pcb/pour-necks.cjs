"use strict";
// Remove Necks and Outlines Only on whole pours (polygon-pour.js morphOf, PourCore shapeIslands):
//   * a neck narrower than the width is cut, a wider one stays; the cut copper lies inside the
//     unshaped copper (never nearer anything the pour clears), and the island tests run after it
//     (the far side of a cut is dead copper when nothing of the net touches it);
//   * relief spokes survive a neck width larger than the spoke, so thermals stay connected;
//   * Outlines Only leaves a band of the track width inside every boundary;
//   * the JS core and the Rust/WebAssembly core store identical copper (and the pooled run);
//   * pours without the setting keep their settings and signatures; the tile tier leaves a layer
//     with a shaped pour to the exact repour.
// Run: scripts/test-jsc.sh pour-necks (ATRIUM_ENGINE=js|wasm), or node.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "stackup", "rules", "viastack", "board-shape", "polygon-pour"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const mode = globalThis.ATRIUM_ENGINE ?? globalThis.process?.env?.ATRIUM_ENGINE;
if (mode !== "js") { try { require("../../app/engine-core.js"); } catch { /* the JS core */ } }
const PP = AtriumPolygonPour, engine = globalThis.AtriumEngine?.available && mode !== "js" ? globalThis.AtriumEngine : null;
if (mode === "wasm") assert.ok(engine, "the Rust/WebAssembly core loads");
const withEngine = (on, f) => { const e = globalThis.AtriumEngine; globalThis.AtriumEngine = on || undefined; try { return f(); } finally { globalThis.AtriumEngine = e; } };
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const defs = new Map();
function board(items) { return {kind: "pcb", name: "B", items, outline: rect(0, 0, 50, 40), rules: {format: "atrium-rules", version: 1, units: "mm", defaults: {clearance: .2, trackWidth: .15, viaDrill: .3}, nets: {}}}; }
const track = (id, pts, w, net) => ({id, kind: "track", layer: "Top", points: pts, width: w, net});
const via = (id, x, y, net) => ({id, kind: "via", x, y, diameter: .6, drill: .3, layer: "Multi", net});
const area = rs => { let a = 0; for (const r of rs) PP.rings(r).forEach((q, k) => { let s = 0; const n = q.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) s += q[2 * j] * q[2 * i + 1] - q[2 * i] * q[2 * j + 1]; a += (k ? -1 : 1) * Math.abs(s) / 2; }); return a; };
const inside = (rs, x, y) => rs.some(r => { let w = 0; PP.rings(r).forEach(q => { const n = q.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) { const x1 = q[2 * j], y1 = q[2 * j + 1], x2 = q[2 * i], y2 = q[2 * i + 1]; if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) w ^= 1; } }); return w === 1; });
// Two tracks of another net across the pour leave a gap: the copper through it is a neck of
// gap - 2 × clearance (0.6 - 0.4 - 2 × 0.2 ... here 0.1 mm wide).
function necked(fields, extra = []) {
  const p = PP.make(rect(5, 5, 45, 35), {id: "pour", net: "GND", layer: "Top", removeDeadCopper: false, ...fields});
  return {d: board([track("a", [[20, 0], [20, 19.75]], .5, "X"), track("b", [[20, 20.75], [20, 40]], .5, "X"), ...extra, p]), p};
}
const pour = (fields, extra) => { const b = necked(fields, extra); const r = PP.apply(b.d, defs, {reuse: false}); return {...b, r, regions: b.d.pcbDrawing?.pours || []}; };

// ---- a neck narrower than the width is cut; a wider one stays
{
  const plain = pour({}), cut = pour({neckWidth: .2}), wide = pour({neckWidth: .05});
  assert.equal(plain.regions.length, 1, "unshaped: one island through the 0.1 mm neck");
  assert.equal(cut.regions.length, 2, "Remove Necks 0.2 mm cuts the 0.1 mm neck");
  assert.equal(wide.regions.length, 1, "Remove Necks 0.05 mm keeps it");
  assert.ok(area(cut.regions) < area(plain.regions) && area(plain.regions) - area(cut.regions) < 1, "only the neck and the corner tips go: " + (area(plain.regions) - area(cut.regions)));
  // Inside the unshaped copper: every vertex of the cut copper is copper of the plain pour (or on its boundary).
  for (const r of cut.regions) for (const q of PP.rings(r)) for (let i = 0; i < q.length; i += 2) {
    const x = q[i], y = q[i + 1], e = 2e-5;
    assert.ok([[0, 0], [e, 0], [-e, 0], [0, e], [0, -e]].some(([dx, dy]) => inside(plain.regions, x + dx, y + dy)), "cut copper at " + x + "," + y + " lies inside the unshaped copper");
  }
  // The fill keeps its straight edges: the pour's left edge (x = 5) is still copper's boundary.
  assert.ok(inside(cut.regions, 5.01, 20) && !inside(cut.regions, 4.99, 20));
  // Convex corners round to the template (radius 0.1 mm): the corner point itself is no copper.
  assert.ok(!inside(cut.regions, 5.005, 5.005) && inside(cut.regions, 5.2, 5.2));
  console.log("ok - a 0.1 mm neck: cut at 0.2 mm, kept at 0.05 mm; the cut copper lies inside the unshaped copper");
}
// ---- island tests after the cut: the side with no GND object is dead copper
{
  const live = pour({neckWidth: .2, removeDeadCopper: true}, [via("g", 10, 20, "GND")]);
  assert.equal(live.regions.length, 1, "the half without a GND object is removed as dead copper");
  assert.ok(inside(live.regions, 10.6, 25) && !inside(live.regions, 30, 25));
  const kept = pour({neckWidth: .2, removeDeadCopper: false}, [via("g", 10, 20, "GND")]);
  assert.equal(kept.regions.length, 2, "Remove Dead Copper off: both halves stay");
  assert.equal(kept.regions.filter(r => !(r.links || []).length).length, 1, "and the far half is a dead island (no links)");
  const small = pour({neckWidth: .2, islandAreaThreshold: 500}, []);
  assert.equal(small.regions.length, 1, "Remove Islands Less Than 500 mm² drops the smaller half");
  console.log("ok - after the cut: dead copper, the area threshold and Keep All apply to the new islands");
}
// ---- relief spokes stay when the neck width is wider than a spoke
{
  const b = pour({neckWidth: .5, connectStyle: "relief", reliefConductorWidth: .2, reliefAirGap: .3, removeDeadCopper: true}, [via("g", 12, 20, "GND")]);
  assert.ok(b.regions.length >= 1);
  const linked = b.regions.filter(r => (r.links || []).length);
  assert.equal(linked.length, 1, "the island stays linked to the via through its spokes");
  // A spoke point between the via and the air gap's outer edge is copper.
  assert.ok(inside(b.regions, 12, 20.5), "the spoke above the via is copper");
  console.log("ok - relief spokes narrower than the neck width are kept: the via stays connected");
}
// ---- Outlines Only: a band of the track width inside every boundary
{
  const plain = pour({}), band = pour({fillMode: "outline", hatchWidth: .25});
  const perimeter = 2 * (40 + 30) + 2 * (14.75 + 14.25); // the outline and both sides of the two tracks, about
  const a = area(band.regions);
  assert.ok(a > .25 * perimeter * .8 && a < .25 * perimeter * 1.2, "band area " + a + " for about " + perimeter + " mm of boundary");
  assert.ok(inside(band.regions, 5.1, 20) && !inside(band.regions, 5.5, 20) && !inside(band.regions, 30, 20), "the band is 0.25 mm wide, the middle is empty");
  assert.ok(a < area(plain.regions));
  console.log("ok - Outlines Only: a 0.25 mm band inside the outline and round the tracks (" + a.toFixed(1) + " mm²)");
}
// ---- every core stores the same copper; the pooled run too
{
  const shapes = [{neckWidth: .2}, {neckWidth: .7}, {fillMode: "outline", hatchWidth: .3}, {neckWidth: .3, removeDeadCopper: true}];
  for (const f of shapes) {
    const js = withEngine(null, () => pour(f, [via("g", 10, 20, "GND"), via("h", 30, 12, "X")]));
    if (engine) { const w = withEngine(engine, () => pour(f, [via("g", 10, 20, "GND"), via("h", 30, 12, "X")])); assert.equal(JSON.stringify(w.regions), JSON.stringify(js.regions), "WebAssembly = JS for " + JSON.stringify(f)); }
  }
  console.log("ok - " + (engine ? "the Rust/WebAssembly core stores the copper the JS core does" : "JS core only here"));
}
// ---- settings: absent stays absent (signatures of existing pours do not change); validation; tiles
{
  const p = PP.make(rect(0, 0, 10, 10), {layer: "Top", net: "GND"});
  assert.equal("neckWidth" in PP.settings(p), false, "no neckWidth key when off");
  assert.equal(PP.settings({...p, neckWidth: .3}).neckWidth, .3);
  assert.equal(PP.settings({...p, fillMode: "outline"}).fillMode, "outline");
  assert.throws(() => PP.validate({...p, neckWidth: 6}), /neckWidth/);
  assert.throws(() => PP.validate({...p, fillMode: "dots"}), /fillMode/);
  PP.validate({...p, neckWidth: 0, fillMode: "outline"});
  const b = necked({neckWidth: .2}), other = PP.make(rect(5, 5, 45, 35), {id: "bottom", net: "GND", layer: "Bottom"});
  b.d.items.push(other);
  const st = PP.tiles.build(b.d, defs, {});
  assert.deepEqual(st.ord, ["bottom"], "the tile tier skips the layer with the shaped pour");
  console.log("ok - settings: absent stays absent, values validated; tiles leave a shaped layer to the exact repour");
}
// ---- Design Insights: dead copper that stays (Remove Dead Copper off) is listed with its location
{
  for (const m of ["insights", "insights-pcb"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const isDead = x => x.check === "deadCopper" || String(x.id || "").startsWith("deadCopper");
  const b = pour({neckWidth: .2, removeDeadCopper: false}, [via("g", 10, 20, "GND")]), p = Atrium.project("Dead"); p.documents = [b.d];
  const dead = AtriumInsights.analyze(p, b.d, defs).insights.filter(isDead);
  assert.equal(dead.length, 1, JSON.stringify(dead.map(x => x.message)));
  assert.match(dead[0].message, /An island of the GND on .* pour \(\d+(\.\d+)? mm²\) touches nothing on GND\./);
  const at = dead[0].at || dead[0].raw?.at;
  assert.ok(at && at[0] > 20 && at[0] < 45 && at[1] > 5 && at[1] < 35, "located on the far half: " + JSON.stringify(at));
  // Remove Dead Copper on: nothing to report.
  const c = pour({neckWidth: .2, removeDeadCopper: true}, [via("g", 10, 20, "GND")]), q = Atrium.project("Clean"); q.documents = [c.d];
  assert.equal(AtriumInsights.analyze(q, c.d, defs).insights.filter(isDead).length, 0);
  console.log("ok - Design Insights lists the dead island that stays, at " + at.map(v => v.toFixed(1)).join(", "));
}
