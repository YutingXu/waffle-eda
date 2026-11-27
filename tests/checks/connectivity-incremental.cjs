"use strict";
// Incremental connectivity (app/checks/connectivity-live.js, through connectivity.js inspect()): after every local edit, inspect() on the same
// document (cached entities, contact graph, pour state and per-net airwires) equals the full pass
// inspectFull(): nets, shorts (including which contact names each short), airwires, excluded and
// unassigned. Edits move, add, delete and re-net copper, move parts, change a footprint in place,
// replace the item list and create shorts; the Altium fixture board (with poured copper) is checked too.
// Run: scripts/test-jsc.sh connectivity-incremental
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {appFile} = require("../support/app-source-paths.cjs");
const {F2} = require("../support/a1-geometry.cjs");
let serial = 0;
globalThis.CFB = require(appFile("vendor/cfb.min.js"));
for (const f of ["model", "parts", "net-ties", "sch-objects", "hierarchy", "board-shape", "stackup", "viastack", "polygon-pour", "component-classes", "query",
  "import-link", "source-file", "sch-import", "altium-rules", "pcb-pours", "pcb-import", "io", "engine-core", "connectivity", "connectivity-live", "undo-store", "rules", "router", "autorouter"]) require(appFile(f + ".js"));
require("../pcb/dense-board.js");
const C = AtriumConnectivity;
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const pick = r => JSON.stringify([r.nets, r.shorts, r.airwires, r.excluded, r.unassigned, r.stats.objects, r.stats.features]);
function check(doc, defs, what, journal) {
  const t = clock(), inc = C.inspect(doc, defs, journal), ms = clock() - t;
  const full = C.inspectFull(doc, defs);
  if (pick(inc) !== pick(full)) {
    const a = pick(inc), b = pick(full); let i = 0; while (i < a.length && a[i] === b[i]) i++;
    assert.fail(what + ": incremental differs from the full pass at " + i + ": …" + a.slice(Math.max(0, i - 80), i + 80) + " vs …" + b.slice(Math.max(0, i - 80), i + 80));
  }
  return {ms, shorts: inc.shorts.length};
}
let seed = 5;
const rnd = k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };

// ---- dense board (smaller), nets on everything, random local edits -----------------------------------
{
  const {d, defs} = makeAtriumBenchmarkBoard(70);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 16), "2": "N" + ((k + 1) % 16)}; else i.net = "N" + (k % 16); k++; }
  check(d, defs, "first pass");
  const items = () => d.items, any = kind => { const l = items().filter(i => i.kind === kind); return l[rnd(l.length)]; };
  const edits = [
    () => { const v = any("via"); v.x += .3; },
    () => { const t = any("track"); t.points = t.points.map(p => [p[0] + .2, p[1]]); },
    () => { const t = any("track"); t.points[0][1] += .5; },
    () => { const p = any("part"); p.x += 1.1; p.angle = (p.angle + 90) % 360; },
    () => { const v = any("via"), w = any("pad"); items().push({id: "n" + (++serial), kind: "track", layer: "Top", width: .3, net: v.net, points: [[v.x, v.y], [w.x, w.y]]}); }, // may short
    () => { const i = rnd(items().length); items().splice(i, 1); },
    () => { d.items = items().filter(() => rnd(60)); },
    () => { const t = any("track"); t.net = "N" + rnd(16); },
    () => { const p = any("pad"); p.w *= 1.6; },
    () => { const p = any("part"); p.pinNets = {"1": "N" + rnd(16), "2": "N" + rnd(16)}; },
    () => { items().push({id: "g" + (++serial), kind: "graphic", layer: "Top", fill: true, points: [[10, 10], [14, 10], [14, 13], [10, 13]]}); },
    () => { const def = defs.get("std-r"); def.footprint.pads[0].w = def.footprint.pads[0].w === .9 ? 1.4 : .9; }, // a footprint changed in place
  ];
  let shorts = 0, worst = 0, incMs = 0;
  for (let n = 0; n < 160; n++) {
    edits[rnd(edits.length)]();
    const r = check(d, defs, "edit " + n);
    shorts = Math.max(shorts, r.shorts); worst = Math.max(worst, r.ms); incMs += r.ms;
  }
  assert.ok(shorts > 0, "the edits made shorts (their witnesses are compared too)");
  console.log("dense " + d.items.length + " objects: 160 edits equal the full pass; incremental mean " + (incMs / 160).toFixed(1) + " ms, worst " + worst.toFixed(1) + " ms, up to " + shorts + " shorts");
}
// A long island forces several sorted runs of contact edges. Direct and indirect
// short witnesses must still match the sweep's ordering after every yield.
for (const direct of [true,false]) {
  const d=Atrium.sheet("pcb","Shorted island"), defs=new Map();
  for(let k=0;k<4201;k++){
    const net=!direct&&k%2?"": ["VDD","GND","SIGNAL"][Math.floor(k/(direct?1:2))%3];
    d.items.push({id:"p"+(4200-k),kind:"pad",x:k*.35,y:0,w:.55,h:.55,shape:"round",layer:"Top",net});
  }
  const full=C.inspectFull(d,defs), work=AtriumConnectivityLive.stages(d,defs);
  assert.equal(full.shorts.length,1,"one shorted copper island");
  assert.equal(full.shorts[0].direct,direct,"exercise the intended witness path");
  let next=work.next(), slices=0;
  while(!next.done){slices++;next=work.next();}
  assert.ok(slices>12,"the large connection projection yields throughout the sweep");
  assert.equal(pick(next.value),pick(full),"sliced short witness and connection lines equal the full pass");
}
// Retained islands with fewer than two terminals cannot join any nodes. An
// imported source fill still needs adoption, which can supply fresh links.
{
  const d=Atrium.sheet("pcb","Pour links"), defs=new Map(), PP=globalThis.AtriumPolygonPour;
  d.items=[{id:"a",kind:"pad",w:1,h:1,x:0,y:0,layer:"Top",net:"N"},{id:"b",kind:"pad",w:1,h:1,x:4,y:0,layer:"Top",net:"N"}];
  const a=["a",0],b=["b",0];
  d.pcbDrawing={pours:[{links:[a]}]};
  let checks=0;
  globalThis.AtriumPolygonPour={...PP,contactRegions(doc){
    if(!doc.pcbDrawing.pours.some(r=>r.links?.length>1))return [];
    checks++;
    return doc.pcbDrawing.pours;
  }};
  try {
    const single=C.inspect(d,defs);
    assert.equal(checks,0,"single-terminal islands skip the full signature check");
    assert.equal(single.airwires.length,1);
    assert.equal(pick(single),pick(C.inspectFull(d,defs)));
    d.pcbDrawing.pours=[{links:[a,b]}];
    const joined=C.inspect(d,defs);
    assert.equal(checks,1,"two terminals read actual pour freshness once");
    assert.equal(joined.airwires.length,0);
    assert.equal(pick(joined),pick(C.inspectFull(d,defs)));
    d.pcbDrawing={sourceFill:true,pours:[{links:[]}]};
    assert.equal(C.inspect(d,defs).airwires.length,1,"connectivity does not adopt raw imported artwork");
    assert.equal(checks,2,"raw islands without terminal links skip copper verification");
    assert.ok(d.pcbDrawing.sourceFill);
  } finally {globalThis.AtriumPolygonPour=PP;}
}
// One stored-island link union. Edit the smaller island, then Undo and Redo.
// P5 is a one-link island and stays isolated while the smaller island changes.
{
  const U=AtriumUndoStore,defs=new Map(),d=Atrium.sheet("pcb","Stored islands"),history=[],future=[];
  const PP=globalThis.AtriumPolygonPour;
  d.items=["P1","P2","P3","P4","P5","P6"].map((id,n)=>({id,kind:"pad",w:1,h:1,x:n*5,y:0,layer:"Top",net:"N"}));
  const link=id=>[id,0],pours=small=>[{links:["P1","P2","P3"].map(link)},{links:small.map(link)},{links:[link("P5")]}];
  d.pcbDrawing={pours:pours(["P4","P6"])};
  globalThis.AtriumPolygonPour={...PP,contactRegions(doc){
    const regions=doc.pcbDrawing?.pours;
    return regions?.some(r=>r.links?.length>1)?regions:[];
  }};
  const project={documents:[d],library:[]};
  const wires=r=>r.airwires.map(w=>[w.fromId,w.toId].sort().join("-")).sort();
  try{
    U.reset();
    const before=U.mark(project);
    check(d,defs,"stored islands before the edit",U);
    d.pcbDrawing.pours=pours(["P4","P2"]);
    U.checkpoint(history,future,before,"Edit the smaller stored island");
    U.touch(project);
    assert.ok(AtriumConnectivityLive.inspect(d,defs,U),"the incremental pass owns the stored-island edit");
    const edited=C.inspectFull(d,defs);
    check(d,defs,"stored island edit",U);
    assert.equal(edited.nets.find(n=>n.name==="N").islands,3,"edit keeps the large island, the smaller island and isolated P5");
    assert.ok(edited.airwires.length>0&&edited.airwires.every(w=>w.fromId==="P5"||w.toId==="P5"),"isolated P5 stays its own island in the edited airwires");
    assert.ok(U.jump(history,future,U.mark(project),-1),"undo restores the stored island");
    U.touch(project);
    const undone=C.inspectFull(d,defs);
    check(d,defs,"stored island undo",U);
    assert.notDeepEqual(wires(undone),wires(edited),"undo splits the smaller island back off the edit");
    assert.equal(undone.nets.find(n=>n.name==="N").islands,3,"undo keeps isolated P5");
    assert.ok(U.jump(history,future,U.mark(project),1),"redo reapplies the stored-island edit");
    U.touch(project);
    const redone=C.inspectFull(d,defs);
    check(d,defs,"stored island redo",U);
    assert.deepEqual(wires(redone),wires(edited),"redo matches the edited full airwires");
  }finally{globalThis.AtriumPolygonPour=PP;U.reset();}
}
// ---- committed journal, including undo, redo and copper dependencies ---------------------------------
{
  const U = AtriumUndoStore, R = AtriumRules, AR = AtriumAutorouter, defs = new Map(), history = [], future = [];
  const d = Atrium.sheet("pcb", "Curved contact");
  const track = {...F2.track, id:"curve", net:"TRACE", layer:"Top", arc:{...F2.track.arc}};
  const pad = ([x,y], id) => ({kind:"pad", id, net:id.toUpperCase(), x, y, w:.2, h:.2, shape:"round", layer:"Top"});
  d.outline = [[-8,-8],[8,-8],[8,8],[-8,8]];
  d.items = [track, pad(F2.inside,"inside"), pad(F2.outside,"outside")];
  const project = {documents:[d], library:[]};
  function contact(curved) {
    const padId = curved ? "inside" : "outside";
    const live = AtriumConnectivityLive.inspect(d,defs,U);
    assert.deepEqual(live?.shorts.map(s => s.nets), [[padId.toUpperCase(),"TRACE"]]);
    assert.equal(pick(live),pick(C.inspectFull(d,defs)));
    const {violations} = R.drc(d,defs,R.create(),{types:["clearance"]});
    assert.deepEqual(violations.map(v => [v.id,v.otherId]), [["curve",padId]]);
    const routeDoc = {...d, items:[d.items[0]]};
    const {job:{obstacles}} = AR.prepare(routeDoc,defs);
    const occupied = at => obstacles.some(shape => AR.core.geometry.shapeDist({k:0,c:at,r:0},shape)<=0);
    assert.deepEqual([occupied(F2.inside),occupied(F2.outside)], [curved,!curved]);
    const stops = (start, at) => AtriumRouter.begin(routeDoc,defs,{net:"ROUTE",start,layer:"Top",mode:"stop",width:.1}).move(at).status;
    assert.deepEqual([stops([5,-5],F2.inside),stops([2.6,-2.6],F2.outside)],
      curved ? ["blocked","ok"] : ["ok","blocked"]);
  }
  U.reset();
  const before = U.mark(project);
  contact(true);
  track.arc.end = F2.staleEnd;
  U.checkpoint(history,future,before,"Edit retained arc endpoint");
  U.touch(project);
  contact(false);
  for (const [direction, curved] of [[-1,true],[1,false]]) {
    assert.ok(U.jump(history,future,U.mark(project),direction));
    U.touch(project);
    contact(curved);
  }
  U.reset();
}
{
  const U = AtriumUndoStore, defs = new Map(), history = [], future = [];
  const d = Atrium.sheet("pcb", "Via endpoint edits");
  const planes = ["Top", "Inner 1", "Inner 2", "Bottom"];
  d.stackup = AtriumStackup.build(planes.map(() => "Signal"));
  // The four tracks occupy the same board coordinates and each touches the annulus.
  // Their distinct nets identify which physical layers the via joins.
  d.items = planes.map(layer => ({id:layer, kind:"track", layer, net:layer, width:.2, points:[[.3,0],[2,0]]}));
  d.items.push({id:"via", kind:"via", layer:"Multi", net:"Via", x:0, y:0, diameter:1, drill:.4,
    fromLayer:"Inner 1", toLayer:"Top"});
  const project = {documents:[d], library:[]};
  function contacts(expected) {
    const live = AtriumConnectivityLive.inspect(d, defs, U);
    assert.ok(live, "the live graph answers the edit");
    const full = C.inspectFull(Atrium.clone(d), defs);
    assert.equal(pick(live), pick(full));
    assert.deepEqual(live.shorts.map(short => short.nets.slice().sort()), [[...expected, "Via"].sort()]);
  }
  U.reset();
  const prior = U.mark(project);
  contacts(["Top", "Inner 1"]);
  d.items.at(-1).fromLayer = "Inner 2";
  d.items.at(-1).toLayer = "Inner 1";
  U.checkpoint(history, future, prior, "Change the via span");
  U.touch(project);
  contacts(["Inner 1", "Inner 2"]);
  for (const [direction, expected] of [[-1, ["Top", "Inner 1"]], [1, ["Inner 1", "Inner 2"]]]) {
    assert.ok(U.jump(history, future, U.mark(project), direction));
    U.touch(project);
    contacts(expected);
  }
  U.reset();
}
{
  const {d,defs} = makeAtriumBenchmarkBoard(24), U = AtriumUndoStore;
  const project = {documents:[d], library:[...defs.values()]}, history = [], future = [];
  const mark = () => U.mark(project, {current:d.id});
  const edit = (name, fn) => {const before = mark(); fn(); U.checkpoint(history, future, before, name); U.touch(project); check(d, defs, name, U);};
  for (const i of d.items) if (i.kind !== "part") i.net = "N1";
  U.reset(); mark(); check(d, defs, "journal seed", U);
  const via = d.items.find(i => i.kind === "via"), moved = d.items.find(i => i.kind === "track");
  edit("journal move", () => {via.x += .5; moved.points[0][1] += .4;});
  edit("journal replace with the same id", () => {
    d.items = d.items.map(i => i === moved ? {...i, net:"N2", points:i.points.map(p => [p[0] + .6, p[1]])} : i);
  });
  edit("journal library edit in place", () => {const pad = defs.get("std-r").footprint.pads[0]; pad.w += .9;});
  edit("journal insert/remove", () => {d.items = d.items.filter(i => i !== via); d.items.push({...via, id:"new-via", x:via.x + .4});});
  for (const direction of [-1,-1,1,1]) {
    U.jump(history, future, mark(), direction); U.touch(project);
    check(d, defs, direction < 0 ? "journal after undo" : "journal after redo", U);
  }
  edit("journal gap", () => {project.documents.push(Atrium.sheet("schematic", "Another sheet"));});
  d.items.find(i => i.kind === "via").y += .4; U.touch(project);
  const oldWork = AtriumConnectivityLive.stages(d, defs, U);
  assert.equal(oldWork.next().done, false, "the contact graph is prepared before returning the airwires");
  d.items.find(i => i.kind === "pad").x += .4; U.touch(project);
  const latest = AtriumConnectivityLive.stages(d, defs, U);
  assert.equal(latest.next().done, false);
  oldWork.return();
  let result = latest.next(); while (!result.done) result = latest.next();
  assert.equal(pick(result.value), pick(C.inspectFull(d, defs)), "latest staged contact work includes the earlier unpainted edit");
  U.reset();
}
// ---- unplated lands: one node per layer with the pad's net, one ratsnest terminal per pad ----------------
{
  const U = AtriumUndoStore, defs = new Map([["MH", {id:"MH", footprint:{pads:[{number:"1", x:0, y:0, w:6, h:6, shape:"round", layer:"Multi", drill:3.2, plated:false}], shapes:[]}}]]);
  const d = {...Atrium.sheet("pcb", "Unplated"), items:[
    {id:"H1", kind:"part", def:"MH", ref:"H1", x:0, y:0, pinNets:{"1":"GND"}},
    {id:"mh", kind:"pad", number:"1", net:"GND", x:30, y:0, w:6, h:6, shape:"round", layer:"Multi", drill:3.2, plated:false},
    {id:"bare", kind:"pad", number:"1", net:"", x:60, y:0, w:6, h:6, shape:"round", layer:"Multi", drill:3.2, plated:false},
    {id:"p1", kind:"pad", number:"1", net:"GND", x:-10, y:0, w:1, h:1, shape:"round", layer:"Multi", drill:.5},
    {id:"p2", kind:"pad", number:"1", net:"GND", x:10, y:0, w:1, h:1, shape:"round", layer:"Multi", drill:.5},
    {id:"a", kind:"track", net:"GND", layer:"Top", width:.2, points:[[-10, 0], [-2.5, 0]]},
    {id:"b", kind:"track", net:"GND", layer:"Bottom", width:.2, points:[[2.5, 0], [10, 0]]},
    {id:"v", kind:"track", net:"VCC", layer:"Top", width:.2, points:[[25, 5], [35, 5]]}]};
  const project = {documents:[d], library:[...defs.values()]}, history = [], future = [];
  const mark = () => U.mark(project, {current:d.id}), byId = id => d.items.find(i => i.id === id);
  const edit = (name, fn) => {const before = mark(); fn(); U.checkpoint(history, future, before, name); U.touch(project); return check(d, defs, name, U);};
  U.reset(); mark(); check(d, defs, "unplated seed", U);
  assert.equal(C.inspect(d, defs, U).airwires.length, 0, "the footprint's lands are one terminal");
  edit("unplated: a track of another net crosses a land", () => {byId("v").points = [[25, 2.5], [35, 2.5]];});
  assert.deepEqual(C.inspect(d, defs, U).shorts.map(s => s.nets), [["GND", "VCC"]]);
  edit("unplated: the bottom track leaves the land", () => {byId("b").points = [[4, 0], [10, 0]];});
  edit("unplated: it moves along, with the same neighbours", () => {byId("b").points = [[4.5, 0], [10, 0]];});
  edit("unplated: the land bridges two nets", () => {byId("v").net = "B"; d.items.push({id:"c", kind:"track", net:"C", layer:"Bottom", width:.2, points:[[60, -5], [60, -2.5]]}, {id:"e", kind:"track", net:"B", layer:"Bottom", width:.2, points:[[55, 2.5], [65, 2.5]]});});
  assert.deepEqual(C.inspect(d, defs, U).shorts.map(s => s.nets), [["B", "C"], ["B", "GND"]]);
  edit("unplated: the footprint's pin changes net", () => {byId("H1").pinNets = {"1":"N2"};});
  for (const direction of [-1, -1, 1, 1]) {U.jump(history, future, mark(), direction); U.touch(project); check(d, defs, "unplated undo/redo", U);}
  U.reset();
}
// ---- the 25.6k board: cost of a local edit ------------------------------------------------------------
{
  const {d, defs} = makeAtriumBenchmarkBoard(160);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++; }
  let t = clock(); C.inspect(d, defs); const first = clock() - t;
  t = clock(); C.inspectFull(d, defs); const full = clock() - t;
  const times = [], prepTimes = [], journalPrep = [];
  function measure(journal, total, prep) {
    const work = AtriumConnectivityLive.stages(d, defs, journal), start = clock();
    let r = work.next(); prep.push(clock() - start);
    while (!r.done) r = work.next();
    total.push(clock() - start);
  }
  for (let n = 0; n < 8; n++) {
    const v = d.items.filter(i => i.kind === "via")[n * 97]; v.x += .2;
    measure(undefined, times, prepTimes);
  }
  times.sort((a, b) => a - b);
  const U = AtriumUndoStore, p = {documents:[d], library:[...defs.values()]}, journalTimes = [];
  U.reset(); U.mark(p); C.inspect(d, defs, U);
  for (let n = 0; n < 8; n++) {
    const v = d.items.filter(i => i.kind === "via")[n * 97]; v.x += .2;
    U.touch(p); U.sync();
    measure(U, journalTimes, journalPrep);
  }
  journalTimes.sort((a, b) => a - b);
  check(d, defs, "25.6k after edits", U); U.reset();
  console.log("25.6k board: full pass " + full.toFixed(0) + " ms, first incremental " + first.toFixed(0) + " ms, after a one-via edit " + times[4].toFixed(1) + " ms or " + journalTimes[4].toFixed(1) + " ms with the prepared journal (median of 8)");
  prepTimes.sort((a,b)=>a-b); journalPrep.sort((a,b)=>a-b);
  console.log("25.6k contact preparation: " + prepTimes[4].toFixed(2) + " ms without the journal, " + journalPrep[4].toFixed(2) + " ms with it");
}
// ---- Altium fixture board with poured copper ------------------------------------------------------------
{
  const DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const p = Atrium.project("PiDP-11 I/O Expander"); p.documents = []; p.library = [];
  for (const name of ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]) {
    const r = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name))));
    p.documents.push(...(r.documents || [])); p.library.push(...(r.library || []));
  }
  if (globalThis.AtriumImportLink) AtriumImportLink.reconcile(p, p.documents);
  Atrium.validate(p);
  const defs = new Map(p.library.map(x => [x.id, x])), board = p.documents.find(x => x.kind === "pcb");
  if (board.pcbDrawing?.sourceFill) AtriumPolygonPour.adopt(board, defs);
  const U = AtriumUndoStore;
  U.reset(); U.mark(p); check(board, defs, "fixture", U);
  const tracks = board.items.filter(i => i.kind === "track");
  for (let n = 0; n < 12; n++) { const t = tracks[rnd(tracks.length)]; t.points = t.points.map(q => [q[0] + .05, q[1]]); U.touch(p); check(board, defs, "fixture edit " + n, U); }
  if (board.pcbDrawing?.pours?.length) {
    const exact = board.pcbDrawing.pours;
    board.pcbDrawing.pours = []; U.touch(p); check(board, defs, "fixture without poured copper", U);
    board.pcbDrawing.pours = exact; U.touch(p); check(board, defs, "fixture with exact copper restored", U);
  }
  U.reset();
  console.log("Altium fixture: 12 edits equal the full pass");
}
// ---- stacked parts, BOM fields and online DRC's neighbourhood views ------------------------------------
// 600 parts on one spot (every pad 1 touches every other pad 1: ~180k contacts). A BOM edit (comment,
// parameters, DNP) changes no copper: the part keeps its features and nothing is tested again. A view
// ({...board, items: some}, new each time, as online DRC checks a neighbourhood) takes the full pass:
// a cache built for it would test and keep every contact, only to be dropped.
{
  const d = Atrium.sheet("pcb", "Stacked"), defs = new Map(AtriumParts.catalogue.map(p => [p.id, p]));
  for (let k = 0; k < 600; k++) d.items.push({id: "s" + k, kind: "part", def: "std-r", ref: "R" + (k + 1), value: "10k", x: 5, y: 5, angle: 0, pinNets: {"1": "N" + (k % 3), "2": "M"}});
  for (let k = 0; k < 40; k++) d.items.push({id: "t" + k, kind: "track", layer: "Top", width: .2, net: "M", points: [[k * 2, 20], [k * 2 + 1.5, 20]]});
  check(d, defs, "stacked");
  const parts = d.items.filter(i => i.kind === "part");
  parts[3].value = "4k7"; parts[7].parameters = {"Manufacturer Part Number": "X1"}; parts[9].dnp = true;
  let r = C.inspect(d, defs);
  assert.equal(r.stats.candidates, 0, "a BOM field edit tests no contact again");
  check(d, defs, "stacked after BOM edits");
  parts[11].x += 4; parts[12].pinNets = {"1": "N9", "2": "M"};
  check(d, defs, "stacked after a move and a re-net");
  const viewOf = keep => ({...d, items: d.items.filter(keep)});
  const view = viewOf((i, n) => n % 7 !== 3);
  let t = clock(); r = C.inspect(view, defs); const viewMs = clock() - t;
  assert.equal(pick(r), pick(C.inspectFull(view, defs)), "a view equals the full pass over its items");
  assert.ok(r.shorts.length > 0, "the stacked pads short their nets");
  assert.equal(globalThis.AtriumConnectivityLive.inspect(view, defs), null, "a view is left to the full pass");
  check(d, defs, "stacked board after a view");
  const fresh = {...d, id: "other", items: d.items.slice()};
  t = clock(); C.inspect(fresh, defs); const cacheMs = clock() - t;
  assert.ok(globalThis.AtriumConnectivityLive.inspect(fresh, defs), "a document of its own (another id) keeps a cache");
  console.log("stacked 600 parts: a view " + viewMs.toFixed(1) + " ms (full pass); building an incremental cache for it would take " + cacheMs.toFixed(0) + " ms");
}
console.log("PASS incremental connectivity");
