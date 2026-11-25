"use strict";
// Net ties (allowed shorts): library flags, connectivity, ratsnest, DRC and ERC.
const assert = require("node:assert/strict");
for (const m of ["model", "net-ties", "parts", "connectivity", "connectivity-live", "undo-store", "altium-rules", "rules", "drc", "messages", "erc"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, NT = AtriumNetTies, C = AtriumConnectivity, R = AtriumRules;

// ---- starter library item -------------------------------------------------------------
const tie = AtriumParts.catalogue.find(d => d.id === "std-nettie-2");
assert.ok(tie, "the starter catalogue has the net tie");
assert.equal(tie.name, "Net Tie 2-pad 0.25 mm");
assert.ok(NT.isTieDef(tie) && NT.tieFootprint(tie) && NT.tieSymbol(tie));
assert.deepEqual(NT.groups(tie, "pcb"), [["1", "2"]]);
assert.deepEqual(NT.check(tie), [], "the starter tie is valid");
assert.equal(tie.footprint.shapes.find(s => s.layer === "Top").width, .25, "0.25 mm bridge");
assert.ok(!AtriumParts.example().library.some(d => d.id === "std-nettie-2"), "the sample project is unchanged");
assert.ok(NT.check({id: "x", name: "x", footprint: {netTie: true, pads: [{number: "1", x: 0, y: 0, w: 1, h: 1}], shapes: []}}).length >= 2, "a one-pad tie without copper is reported");
assert.ok(A.validate(A.project("Ties", AtriumParts.catalogue)), "projects with the tie validate");

// ---- a board with net tie NT1 between AGND and DGND --------------------------------------
const pad = (id, net, x, y) => ({id, kind: "pad", number: "1", x, y, w: .8, h: .8, drill: 0, shape: "rect", layer: "Top", net});
const track = (id, net, ...points) => ({id, kind: "track", layer: "Top", net, width: .2, points});
function board(extra = []) {
  const doc = {id: "b", kind: "pcb", name: "Board", grid: 1, outline: [[0, 0], [30, 0], [30, 20], [0, 20]], notes: [], items: [
    {id: "nt1", kind: "part", def: tie.id, ref: "NT1", value: "Net Tie", x: 15, y: 10, angle: 0, layer: "Top", pinNets: {1: "AGND", 2: "DGND"}},
    pad("pa", "AGND", 5, 10), pad("pd", "DGND", 25, 10),
    track("ta", "AGND", [5, 10], [14.45, 10]), track("td", "DGND", [25, 10], [15.55, 10]), ...extra]};
  return doc;
}
const defs = new Map([[tie.id, tie]]);
{
  const r = C.inspect(board(), defs);
  assert.deepEqual(r.shorts, [], "the tie's own short is allowed");
  assert.deepEqual(r.ties, [{ref: "NT1", id: "nt1", nets: ["AGND", "DGND"]}]);
  assert.deepEqual(r.airwires, [], "both nets are routed");
  assert.deepEqual(r.nets.map(n => [n.name, n.islands, n.shorted]), [["AGND", 1, false], ["DGND", 1, false]]);
}
{
  // Without the module the same copper is a short (connectivity stays usable without net-ties.js).
  const keep = globalThis.AtriumNetTies; delete globalThis.AtriumNetTies;
  try { assert.equal(C.inspect(board(), defs).shorts.length, 1); } finally { globalThis.AtriumNetTies = keep; }
}
{
  // A third net on the bridge is a short through the tie.
  const r = C.inspect(board([track("sig", "SIG", [15, 8], [15, 12])]), defs);
  assert.equal(r.shorts.length, 1);
  assert.equal(r.shorts[0].netTie, "NT1");
  assert.ok(r.shorts[0].nets.includes("SIG") && r.shorts[0].nets.includes("AGND"));
}
{
  // Any other AGND-DGND contact is still a short.
  const r = C.inspect(board([track("x1", "AGND", [8, 10], [8, 15]), track("x2", "DGND", [8, 15], [22, 15], [22, 10])]), defs);
  assert.ok(r.shorts.some(s => !s.netTie && s.nets.join() === "AGND,DGND"), "a short outside the tie is reported");
}
{
  // Ratsnest: each net keeps its own connections; DGND is not routed "through" AGND.
  const doc = board(); doc.items = doc.items.filter(i => i.id !== "td");
  const r = C.inspect(doc, defs);
  assert.deepEqual(r.airwires.map(w => w.net), ["DGND"]);
  assert.deepEqual(r.shorts, []);
  // Same-net copper that touches the bridge on the AGND side reaches pad 1 through the tie.
  const d2 = board(); d2.items.find(i => i.id === "ta").points = [[5, 10], [14.9, 10]];
  const r2 = C.inspect(d2, defs);
  assert.deepEqual(r2.airwires, [], "AGND track ending on the bridge is connected");
  assert.deepEqual(r2.shorts, []);
}

// ---- DRC -----------------------------------------------------------------------------------
{
  const doc = board(), rules = R.create(), conn = C.inspect(doc, defs);
  const res = R.drc(doc, defs, rules, {connections: conn});
  assert.equal(res.violations.filter(v => v.type === "short").length, 0, "no short-circuit violation for the tie");
  assert.equal(res.violations.filter(v => v.type === "clearance").length, 0, "no clearance violation inside the tie");
  assert.ok(res.notes.some(n => /Net tie NT1 joins AGND and DGND/.test(n)));
  const bad = board([track("sig", "SIG", [15, 8], [15, 12])]);
  const res2 = R.drc(bad, defs, rules, {connections: C.inspect(bad, defs)});
  assert.equal(res2.violations.filter(v => v.type === "short").length, 1, "a third net on the bridge is a short");
  assert.ok(res2.violations.some(v => v.type === "clearance" && v.title.includes("SIG")), "the bridge keeps clearance from other nets");
}

// A moved footprint bridge can join routes without either pad. Separate pieces can do the
// same through unassigned board copper. Exercise the edit journal and the staged check path.
{
  const U = AtriumUndoStore, Live = AtriumConnectivityLive, tied = ["AGND", "DGND"];
  const results = {};
  function checkHistory(name, build, edit) {
    const doc = board(), project = A.project("Net tie contact", [A.clone(tie)]), def = project.library[0];
    project.documents = [doc];
    build(doc, def);
    A.validate(project);
    const history = [], future = [], mark = () => U.mark(project, {current: doc.id});
    function read() {
      const defs = new Map(project.library.map(d => [d.id, d])), rules = R.create();
      const near = C.inspect(doc, defs, U), full = C.inspectFull(doc, defs);
      const work = Live.stages(doc, defs, U);
      let state = work.next();
      while (!state.done) state = work.next();
      assert.deepEqual(near, full, name + " editor and cold connectivity agree");
      assert.deepEqual(state.value, full, name + " staged and cold connectivity agree");
      const report = AtriumDRC.batch(doc, defs, rules, {connections: () => near});
      const cold = AtriumDRC.batch(doc, defs, rules);
      assert.deepEqual(report.violations, cold.violations, name + " editor and cold DRC agree");
      assert.deepEqual(report.notes, cold.notes);
      assert.deepEqual(near.airwires, []);
      return [near.ties.map(t => t.nets), near.shorts.map(s => [s.netTie, s.nets]),
        report.violations.filter(v => v.type === "short").length];
    }
    U.reset();
    const before = mark(), legal = read();
    U.checkpoint(history, future, before, name);
    edit(doc, def);
    U.record(project);
    const changed = read();
    assert.ok(U.jump(history, future, mark(), -1));
    const undone = read();
    assert.ok(U.jump(history, future, mark(), 1));
    results[name] = [legal, changed, undone, read()];
    U.reset();
  }
  checkHistory("Footprint bridge", () => {}, (doc, def) => {
    def.footprint.shapes[0].points = [[-6, .18], [-6, 3], [6, 3], [6, .18]];
  });
  checkHistory("Unassigned board copper", (doc, def) => {
    const bridge = def.footprint.shapes[0];
    def.footprint.shapes = [
      {...bridge, points: [[-6, .18], [-6, 3], [-2, 3]]},
      {...bridge, points: [[6, .18], [6, 3], [2, 3]]}
    ];
    doc.items.push({...track("link", "", [13, 13], [17, 13]), layer: "Bottom"});
  }, doc => { doc.items.find(i => i.id === "link").layer = "Top"; });
  const legal = [[tied], [], 0], separated = [[], [], 0], short = [[], [["NT1", tied]], 1];
  assert.deepEqual(results, {
    "Footprint bridge": [legal, short, legal, short],
    "Unassigned board copper": [separated, short, separated, short]
  });
}

{
  // A named route can join two independent legal groups without sharing their exemptions.
  const def = A.clone(tie), doc = board(), part = doc.items[0], fp = def.footprint;
  fp.pads.push({...fp.pads[0], number: "3", y: 4}, {...fp.pads[1], number: "4", y: 4});
  fp.netTieGroups.push(["3", "4"]);
  fp.shapes.push({...fp.shapes[0], points: [[-.55, 4], [.55, 4]]});
  Object.assign(part.pinNets, {3: "DGND", 4: "SIG"});
  doc.items.push(track("return", "DGND", [25, 10], [25, 17], [11, 17], [11, 14], [14.45, 14]));
  const graph = C.inspectFull(doc, new Map([[def.id, def]]));
  assert.deepEqual(graph.shorts, []);
  assert.deepEqual(graph.airwires, []);
  assert.deepEqual(graph.ties.map(t => t.nets), [["AGND", "DGND"], ["DGND", "SIG"]]);
}

// ---- ERC -------------------------------------------------------------------------------------
{
  const p = A.project("Tie ERC", AtriumParts.catalogue), sch = p.documents[0], pdefs = new Map(p.library.map(d => [d.id, d]));
  const nt = {id: A.id(), kind: "part", def: tie.id, ref: "NT1", value: "Net Tie", link: "l1", x: 50, y: 50, angle: 0, pinNets: {}};
  sch.items.push(nt);
  const [p1, p2] = A.pins(nt, pdefs.get(tie.id), "schematic").map(q => q.at);
  sch.items.push({id: A.id(), kind: "wire", points: [[40, 50], p1]}, {id: A.id(), kind: "wire", points: [p2, [60, 50]]},
    {id: A.id(), kind: "netlabel", text: "AGND", x: 40, y: 50}, {id: A.id(), kind: "netlabel", text: "DGND", x: 60, y: 50});
  const ties = r => r.messages.filter(m => m.check === "netTies");
  assert.deepEqual(ties(AtriumERC.run(p)), [], "a tie between two nets is fine");
  // A wire joining AGND to DGND elsewhere is a short outside the tie.
  sch.items.push({id: A.id(), kind: "wire", points: [[40, 50], [40, 60]]}, {id: A.id(), kind: "netlabel", text: "DGND", x: 40, y: 60});
  const short = ties(AtriumERC.run(p));
  assert.equal(short.length, 1);
  assert.match(short[0].text, /Nets AGND and DGND are shorted outside net tie NT1/);
  assert.equal(short[0].class, "Error");
  // A tie whose pins share one net ties it to itself.
  const q = A.project("Self", AtriumParts.catalogue), s2 = q.documents[0], qdefs = new Map(q.library.map(d => [d.id, d]));
  const n2 = {id: A.id(), kind: "part", def: tie.id, ref: "NT2", value: "Net Tie", link: "l2", x: 50, y: 50, angle: 0, pinNets: {}};
  s2.items.push(n2);
  const [a1, a2] = A.pins(n2, qdefs.get(tie.id), "schematic").map(x => x.at);
  s2.items.push({id: A.id(), kind: "wire", points: [a1, [a1[0], 40], [a2[0], 40], a2]}, {id: A.id(), kind: "netlabel", text: "GND", x: a1[0], y: 40});
  assert.match(ties(AtriumERC.run(q))[0].text, /Net tie NT2 connects net GND to itself/);
}
console.log("net ties: library, connectivity, ratsnest, DRC and ERC OK");
