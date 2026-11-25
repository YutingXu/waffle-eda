"use strict";
// Shared worker/headless presentation. Check the counts against Compare itself and preserve
// the two coordinate frames, including distant PCB regions and changes to a placed library part.
const assert = require("node:assert/strict"), fs = require("node:fs");
for (const file of ["model", "parts", "board-shape", "sch-objects", "hierarchy", "waivers", "net-intent", "signals", "diff", "project-history-summary"])
  require(require("../support/app-source-paths.cjs").appFile(file + ".js"));
const S = AtriumHistorySummary, A = Atrium;
const old = AtriumParts.example();
const fresh = A.clone(old), pcb = fresh.documents[1], sheet = fresh.documents[0];
sheet.items[0].value = "Replacement";
for (const [i, x] of [0, 100].entries()) {
  const track = {id: "history-" + i, kind: "track", width: .2, layer: "Top", net: "TEST", points: [[x, 0], [x + 1, 4], [x + 4, 8]]};
  old.documents[1].items.push(A.clone(track)); track.points[1][0] += 2; pcb.items.push(track);
}
const text = p => JSON.stringify(p);
const r = S.fromProjects(old, fresh);
assert.deepEqual(r.counts, AtriumDiff.compare(old, fresh).summary.bySeverity);
assert.match(r.text, /2 tracks rerouted/);
assert.match(r.text, /Replacement/);
const firstOnly = S.fromProjects(old, fresh, 0);
assert.deepEqual(firstOnly.regions[0], r.regions[0]);
assert.ok(firstOnly.regions.slice(1).every(x => !("before" in x) && !("after" in x)));
assert.deepEqual(S.fromProjects(old, fresh, 1).regions[1], r.regions[1]);
const boardRegions = r.regions.filter(x => x.kind === "pcb");
assert.equal(boardRegions.length, 2);
for (const tile of boardRegions) {
  assert.ok(tile.before.changed && tile.after.changed);
  assert.notEqual(tile.before.changed, tile.after.changed);
}
assert.ok(r.regions.some(x => x.kind === "schematic" && x.before && x.after));
const lib = A.clone(old), d = lib.library.find(x => x.id === "std-r");
d.footprint.pads[0].w += .5;
const library = S.fromProjects(old, lib);
assert.ok(library.regions.some(x => x.kind === "pcb" && x.before.changed !== x.after.changed));
assert.deepEqual(S.fromProjects(old, old), S.unchanged());
assert.ok(S.fromProjects(null, old).regions.every(x => !x.before && x.after));
assert.ok(S.fromProjects(old, null).regions.every(x => x.before && !x.after));
const report = (header, before, after) => JSON.parse(AtriumProjectHistoryReport(text(header), before, after));
const manifest = {before: "a", after: "b", nativeFolder: true};
assert.deepEqual(report(manifest, text(old), text(fresh)), r);
assert.match(report(manifest, text(old), text(old)).text, /Saved files changed/);
assert.deepEqual(report({...manifest, same: true}, "", ""), S.unchanged());
assert.throws(() => report(manifest, "{", text(old)));
const obsolete = fs.readFileSync(__dirname + "/../fixtures/compat/projects/v1.4-sample.atrium", "utf8");
for (const header of [{}, {same: true}, {nativeFolder: "true"}, {nativeFolder: true, sources: true}]) {
  assert.throws(() => report({before: "a", after: "b", ...header}, obsolete, text(fresh)),
    /requires a verified Waffle folder or source EDA revision/);
}
assert.equal(S.fromTexts, undefined);
assert.notEqual(S.key("a", "b", "1"), S.key("b", "a", "1"));
assert.notEqual(S.key("a", "b", "1"), S.key("c", "b", "1"));
assert.notEqual(S.key(null, "b", "1"), S.key(null, "b", "2"));
console.log("PASS design counts, representative geometry, ordered blob pairs, absent revisions and library footprints");

// A KiCad placement can split from a shared footprint when only its bottom legend turns.
// The physical package remains the same. Compare and History must still locate that placement.
{
  const base = A.project("Legend", []), board = base.documents[1];
  const line = {kind: "path", points: [[0, 0], [1, 0]], layer: "Silk", style: "silk", width: .15};
  const legend = {kind: "text", text: ".Designator", x: 1, y: 1, size: 1, layer: "Bottom silk", style: "silk", angle: -90};
  base.library.push({id: "switch", name: "MX", sourceName: "Board.kicad_pcb", footprint: {name: "MX", pads: [], shapes: [line, legend]}});
  for (const n of [1, 2]) board.items.push({kind: "part", id: "sw" + n, def: "switch", ref: "SW" + n, value: "MX", x: 10*n, y: 0, angle: 0, layer: "Top", link: "switch" + n, pinNets: {}});
  const moved = A.clone(base);
  moved.library[0].footprint.shapes.reverse();
  assert.equal(AtriumDiff.compare(base, moved).summary.total, 0);
  assert.ok(AtriumDiff.compare(base, moved, {ignoreOrder:false}).summary.total);
  const variant = A.clone(moved.library[0]);
  variant.id = "angled";
  variant.footprint.shapes.find(s=>s.kind==="text").angle = 90;
  moved.library.push(variant);
  moved.documents[1].items[0].def = variant.id;
  for (const [before,after] of [[base,moved],[moved,base]]) {
    const result = S.fromProjects(before,after);
    assert.deepEqual(result.counts, {electrical:0, mechanical:0, cosmetic:1});
    assert.match(result.text,/SW1 footprint graphics changed/);
    assert.ok(result.regions[0].before.changed && result.regions[0].after.changed);
    assert.notEqual(result.regions[0].before.changed,result.regions[0].after.changed);
  }
}

// Two imports assign new Waffle IDs. A durable unique KiCad route can change its net and
// position. Repeated old KiCad timestamps cannot establish which of two remote routes moved.
{
  const design = (ids, duplicate) => {
    const p = A.project("Imported route", []), d = p.documents[1];
    d.sourceName = "Imported.kicad_pcb";
    for (const [i, id] of ids.entries()) d.items.push({
      id, kind:"track", layer:"Top", width:.25, net:"SIGNAL", points:[[i, 0], [i, 2]],
      kicadSourceId:duplicate ? "1a2b" : "abcdef0"+i
    });
    return p;
  };
  for (const duplicate of [false, true]) {
    const before = design(["a", "b"], duplicate), after = A.clone(before);
    after.documents[1].items.forEach((i, k) => { i.id = "new"+k; i.points = i.points.map(([x,y])=>[x+45,y]); i.net = "CHANGED"; });
    const c = AtriumDiff.compare(before, after).changes;
    assert.equal(c.filter(x=>x.kind === "track.moved").length, duplicate ? 0 : 2);
    assert.equal(c.filter(x=>x.kind === "track.added").length, duplicate ? 2 : 0);
    assert.equal(c.filter(x=>x.kind === "track.removed").length, duplicate ? 2 : 0);
    assert.equal(c.filter(x=>x.kind === "track.net").length, duplicate ? 0 : 2);
  }
}

// A free body and a footprint-owned body can extend beyond the pad envelope. The 2D
// preview preserves the supplied plan and inner cutout before and after; height stays in 3D.
{
  const base = A.project("Body outlines", []), board = base.documents[1];
  const outer = [[40,10],[50,10],[50,16],[40,16]], hole = [[42,11],[44,11],[44,13],[42,13]];
  const body = {type:"extruded",sourceRecord:"componentbodies6/data#1",ownerSide:"Top",side:"Top",rings:[outer,hole]};
  for (const placed of [false,true]) {
    const a = A.clone(base), d = a.documents[1];
    if (placed) {
      a.library.push({id:"pkg",name:"Small",footprint:{name:"Small",pads:[],shapes:[]}});
      d.items.push({id:"u1",ref:"U1",kind:"part",def:"pkg",x:15,y:5,angle:90,layer:"Bottom",bodies3d:[A.clone(body)]});
    } else { d.bodies3d = [A.clone(body)]; }
    const b = A.clone(a), dd = b.documents[1];
    const owned = placed ? dd.items[0] : dd;
    owned.bodies3d[0].rings[1][1][0] += 3;
    const r = S.fromProjects(a,b), tile = r.regions.find(v=>v.kind==="pcb");
    assert.equal(r.total,1);assert.match(r.text,/3D body changed/);
    assert.equal(tile.before.changed.split("M").length-1,2);
    assert.equal(tile.after.changed.split("M").length-1,2);
    assert.notEqual(tile.before.changed,tile.after.changed);
  }
  const a = A.clone(base), d = a.documents[1], B = AtriumBoardShape;
  d.outline = [[0,0],[80,0],[80,40],[0,40]];
  d.boardShape = B.fromPolygon(d.outline);
  const b = A.clone(a);
  b.documents[1].boardShape.cutouts.push(B.fromPolygon([[20,10],[30,10],[30,20],[20,20]]).contour);
  const r = S.fromProjects(a,b), tile = r.regions.find(v=>v.kind==="pcb");
  assert.equal(tile.before.changed.split("M").length-1,1);
  assert.equal(tile.after.changed.split("M").length-1,2);
}

// A settings-only sheet can sort before a board with actual copper changes in the same commit.
{
  const a = A.clone(old), b = A.clone(a);
  b.documents[0].notes = ["Revised drawing instructions"];
  b.documents[1].items.find(i=>i.kind==="track").width += .2;
  const r = S.fromProjects(a,b);
  assert.match(r.text,/notes/);
  assert.ok(!r.regions.some(g=>g.kind==="schematic"));
  assert.equal(r.regions[0].kind,"pcb");
  assert.ok(r.regions[0].before.changed && r.regions[0].after.changed);
}
