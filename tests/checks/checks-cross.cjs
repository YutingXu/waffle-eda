"use strict";
// Cross-domain checks and projection (app/checks/checks-cross.js):
// cross.sync (Update PCB differences), cross.pinMatrix (the ERC matrix on board nets the schematic keeps
// apart), cross.intent (signals missing on the board; the impedance-checks adapter seam),
// cross.footprintPins (pads without pins and the reverse), and board problems projected onto the sheet
// (and schematic problems onto the board) as one badge per net or component.
// Run: scripts/test-jsc.sh checks-cross   (or node tests/checks/checks-cross.cjs)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "nav-common", "sch-objects", "hierarchy", "net-ties", "multichannel", "messages", "erc", "net-intent", "signals", "eco", "undo-store", "problem-marks", "checks", "sch-markers", "checks-cross"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const K = AtriumChecks, X = AtriumChecksCross, E = AtriumERC;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const pins = (n, type) => Array.from({length: n}, (_, i) => ({number: String(i + 1), name: "P" + (i + 1), x: 0, y: -i * 2.54, electrical: type}));
const pads = n => Array.from({length: n}, (_, i) => ({number: String(i + 1), x: i, y: 0, w: .5, h: .5, shape: "rect", layer: "Top"}));
const drv = {id: "drv", name: "Driver", prefix: "U", symbol: {shapes: [], pins: pins(2, 2)}, footprint: {name: "SOT23-3", shapes: [], pads: pads(3)}};
function design() {
  const sheet = {kind: "schematic", id: "s", name: "Sheet", items: [
    {kind: "part", id: "su1", def: "drv", ref: "U1", x: 0, y: 0, angle: 0, link: "L1"}, {kind: "part", id: "su2", def: "drv", ref: "U2", x: 40, y: 0, angle: 0, link: "L2"},
    {kind: "netlabel", id: "lab1", x: 0, y: 0, text: "OUT1"}, {kind: "netlabel", id: "lab2", x: 40, y: 0, text: "OUT2"}]};
  const board = {kind: "pcb", id: "b", name: "Board", outline: [[0, 0], [50, 0], [50, 50], [0, 50]], items: [
    {kind: "part", id: "bu1", def: "drv", ref: "U1", x: 10, y: 10, angle: 0, layer: "Top", link: "L1", pinNets: {"1": "OUT1", "2": "X", "3": ""}},
    {kind: "part", id: "bu2", def: "drv", ref: "U2", x: 30, y: 10, angle: 0, layer: "Top", link: "L2", pinNets: {"1": "OUT1", "2": "Y", "3": ""}},
    {kind: "track", id: "t1", net: "OUT1", layer: "Top", width: .2, points: [[10, 10], [30, 10]]}]};
  return {format: "atrium", name: "Cross", library: [drv], documents: [sheet, board]};
}

test("footprint pads without symbol pins, and the board net the schematic keeps apart", () => {
  const p = design();
  K.compiled(p, E.run(p)); // the schematic nets the matrix check compares with
  const r = X.run(p), by = c => r.list.filter(v => v.check === c);
  const fp = by("cross.footprintPins");
  assert.equal(fp.length, 1, "one finding per symbol/footprint pair");
  assert.match(fp[0].text, /pad 3 has no symbol pin/);
  assert.deepEqual(fp[0].objects.map(o => o.doc).sort(), ["b", "s"], "one row with a place in each document");
  const pm = by("cross.pinMatrix");
  assert.equal(pm.length, 1); assert.match(pm[0].text, /Board net OUT1 connects multiple Output pins \(Output pin U1-1, Output pin U2-1\), which the schematic keeps apart/);
  assert.equal(pm[0].severity, "error"); assert.equal(pm[0].subject.net, "OUT1");
  // When the schematic joins them too, ERC reports it and the board check stays quiet.
  p.documents[0].items[3].text = "OUT1";
  K.compiled(p, E.run(p));
  assert.equal(X.run(p).list.filter(v => v.check === "cross.pinMatrix").length, 0);
  for (const v of r.list) { assert.ok(K.check(v.check), v.check); assert.ok(v.key.startsWith(v.check + ":")); }
});

test("sync differences: what Update PCB would change", () => {
  const p = design();
  p.documents[0].items.push({kind: "part", id: "su3", def: "drv", ref: "U3", x: 80, y: 0, angle: 0});
  const sync = X.run(p, {checks: ["cross.sync"]}).list;
  assert.ok(sync.some(v => /U3/.test(v.text) && /1 component on Sheet not on the board/.test(v.text)), sync.map(v => v.text).join("\n"));
  assert.ok(sync.every(v => v.check === "cross.sync" && v.severity === "warning"));
});

test("components not on the board: one finding per sheet, a marker off the part's body, one plan per change", () => {
  const p = design(), sheet = p.documents[0], board = p.documents[1];
  for (let k = 3; k < 43; k++) sheet.items.push({kind: "part", id: "su" + k, def: "drv", ref: "U" + k, x: 80 + 20 * k, y: 0, angle: 0});
  const U = AtriumUndoStore; U.reset(); U.touch(p); U.sync(p);
  const E2 = AtriumECO, plan0 = E2.plan; let plans = 0;
  const sync = () => X.run(p, {checks: ["cross.sync"]}).list;
  let list;
  try {
    E2.plan = (...a) => { plans++; return plan0(...a); };
    list = sync();
    const add = list.filter(v => /not on the board/.test(v.text) && /component/.test(v.text));
    assert.equal(add.length, 1, "40 components, one finding: " + list.map(v => v.text).join("\n"));
    assert.equal(add[0].objects.length, 40); assert.match(add[0].text, /40 components on Sheet not on the board \(U3, U4, .* and 32 more\)/);
    assert.ok(!list.some(v => /U(\d+)-\d pad net/.test(v.text) && +RegExp.$1 >= 3), "their pads come with them");
    // Routing on the board (copper, no component) does not plan again; a component edit does.
    board.items.push({kind: "track", id: "t9", net: "OUT1", layer: "Top", width: .2, points: [[1, 1], [2, 2]]}); U.touch(p); U.sync(p);
    sync(); assert.equal(plans, 1, "copper edits reuse the plan");
    board.items[0].value = "X"; U.touch(p); U.sync(p);
    sync(); assert.equal(plans, 2, "a component edit compares again");
  } finally { E2.plan = plan0; }
  // The marker sits at the first part's corner: a press on the part's centre selects the part.
  const host = {project: () => p, docById: id => p.documents.find(d => d.id === id), doc: () => sheet, defs: () => new Map(p.library.map(d => [d.id, d]))};
  K.clear(); K.publish("project", "cross", list, x => x);
  AtriumSchMarkers.attach(host);
  const pane = {docId: sheet.id, canvas: {getBoundingClientRect: () => ({left: 0, top: 0})}, view: {scale: 20, worldToScreen: q => [q[0] * 20, q[1] * 20]}};
  const u3 = sheet.items.find(i => i.id === "su3"), box = AtriumNavCommon.itemBox(sheet, host.defs(), u3);
  assert.equal(AtriumSchMarkers.markerAt(pane, u3.x * 20, u3.y * 20), null, "no marker on the part's origin");
  const m = AtriumSchMarkers.markerAt(pane, box[2] * 20, box[1] * 20);
  assert.ok(m && /not on the board/.test(m.text), "the marker at the part's corner");
  K.clear();
});

test("intent: the adapter seam for impedance checks and other modules", () => {
  const p = design();
  X.intentSource({id: "test", run: (pp, b) => [{text: "USB_D: 78 Ω on L1, target 90 Ω ± 10 %", signal: "USB_D", severity: "error", objects: [{doc: b.id, id: "t1"}], at: [{doc: b.id, point: [20, 10]}], measure: {actual: 78, required: 90, limit: "min", unit: "Ω"}}]});
  globalThis.AtriumImpedanceChecks = {check: () => [{check: "cross.intent.width", text: "Width 0.1 mm for 90 Ω needs 0.12 mm", net: "OUT1", objects: [{doc: "b", id: "t1"}]}]};
  const list = X.run(p, {checks: ["cross.intent"]}).list;
  delete globalThis.AtriumImpedanceChecks;
  assert.equal(list.length, 2);
  const a = list.find(v => v.subject?.signal === "USB_D");
  assert.equal(a.severity, "error"); assert.equal(a.measure.unit, "Ω"); assert.deepEqual(a.raw.origin, {kind: "intent", source: "test"});
  assert.equal(list.find(v => v.check === "cross.intent.width").subject.net, "OUT1");
});

test("projection: board problems as one badge per net on the sheet, schematic problems on the footprint", () => {
  const p = design(), sheet = p.documents[0], board = p.documents[1];
  const host = {project: () => p, docById: id => p.documents.find(d => d.id === id), doc: () => sheet};
  K.clear(); K.compiled(p, E.run(p));
  K.publish("b", "drc", [{type: "clearance", ruleName: "Clearance", id: "t1", at: [20, 10], actual: .1, required: .2, title: "Track ↔ Pad"},
    {type: "width", ruleName: "Width", id: "t1", at: [20, 10], actual: .1, required: .15, title: "Track"}], v => K.fromDRC(v, "b"));
  const sch = X.projected(host, sheet);
  const net = sch.find(b => b.label === "OUT1");
  assert.ok(net, "a badge at the OUT1 label: " + JSON.stringify(sch.map(b => b.label)));
  assert.equal(net.count, 2); assert.deepEqual(net.at, [0, 0]); assert.match(net.text, /^OUT1: 2 problems on the board \(clearance, width\)$/i);
  const M = AtriumProblemMarks, scale = 10, origin = [100,50], v = {scale:() => scale, worldToScreen: q => q.map(n=>n*scale)};
  const pane = {docId:sheet.id,view:v,canvas:{getBoundingClientRect:()=>({left:origin[0],top:origin[1]})}};
  const expected = M.badgeAt(net.at,scale,"schematic"), pos = M.badgeDetail(net.at,scale,"schematic");
  assert.deepEqual(pos,{at:[expected.x,expected.y],radius:M.hit(expected.z.screen)});
  const hit = X.badgeAt(host,pane,origin[0]+pos.at[0]*scale,origin[1]+pos.at[1]*scale);
  assert.equal(hit.label,"OUT1");
  assert.equal(hit.count,2);
  const brd = X.projected(host, board);
  assert.ok(brd.length >= 1 && brd.every(b => b.problems.every(v => v.domain === "schematic")), "schematic problems at their footprints");
  K.clear();
});

test("PCB projection ignores board-owned ERC and pending schematic hints without removing findings", () => {
  const p = design(), [sheet, board] = p.documents, host = {project: () => p};
  board.items.push({...board.items[0], id:"orphan", ref:"U99", link:"orphan"});
  const result = E.run(p), orphan = result.messages.find(m => m.check === "boardMismatch" && m.objectId === "orphan");
  const own = result.messages.find(m => m.documentId === sheet.id && m.objectId === "su1" && m.class === "Warning");
  assert.ok(orphan && own, "the fixture generates a real board-owned mismatch and a real sheet warning");
  K.clear();
  try {
    K.publish("project", "erc", [orphan, own], m => K.fromERC(m, {live:true}));
    assert.deepEqual(K.violations({source:"erc"}).map(v => v.severity), ["hint", "hint"]);
    assert.deepEqual(X.projected(host, board), [], "pending findings do not draw error badges on the board");
    K.compiled(p, {...result, messages:[orphan, own]});
    const compiled = K.violations({source:"erc"});
    assert.ok(compiled.some(v => v.doc === board.id && v.severity === "warning"), "board-owned warning remains in Problems");
    assert.deepEqual(X.projected(host,board).map(b => [b.label,b.severity,b.problems[0].doc]), [["U1","warning",sheet.id]]);
  } finally { K.clear(); }
});

test("coarse PCB badges preserve member labels, rank real findings and repair an offscreen winner", () => {
  const P = AtriumProblemMarks, p = design(), [sheet, board] = p.documents;
  const other = {...sheet,id:"other",items:[sheet.items[1]]};
  sheet.items = sheet.items.filter(i => i.id !== "su2");
  p.documents.push(other);
  board.items[0].x = 8.25; board.items[1].x = 10.75;
  let renderer;
  const host = {project:() => p,docById:id => p.documents.find(d => d.id === id), addRenderer:fn => {renderer = fn;}};
  const warning = K.fromERC({class:"Warning",check:"boardMismatch",documentId:sheet.id,objectId:"su1",text:"One warning"});
  const error = K.fromERC({class:"Error",check:"boardMismatch",documentId:sheet.id,objectId:"su1",text:"One error"});
  const shared = {...K.fromERC({class:"Warning",check:"boardMismatch",documentId:other.id,objectId:"su2",text:"Shared warning"}),
    objects:[{doc:other.id,id:"su2"},{doc:sheet.id,id:"su1"}]};
  const rect = {left:25,top:30,width:1200,height:650};
  const canvas = {getBoundingClientRect:() => rect};
  const frame = (scale, offset = 0) => ({canvas,scale,width:rect.width,height:rect.height,worldToScreen:([x,y]) => [x*scale+offset,y*scale]});
  const center = (b, f) => f.worldToScreen(P.badgeDetail(b.at,f.scale,"pcb").at);
  const pick = (b, f) => {
    const [x,y] = center(b,f);
    return X.badgeAt(host,{docId:board.id,canvas,view:f},rect.left+x,rect.top+y);
  };
  const drawn = (overlay, f) => {
    const ink = [], counts = [];
    const ctx = new Proxy({stroke() {ink.push(this.strokeStyle);}, fillText(text) {counts.push(text);}},
      {get:(t,k) => t[k] ?? (() => {})});
    overlay(ctx,f);
    return {ink,counts};
  };
  K.clear();
  try {
    K.publish("project","erc",[warning,error,shared],v => v);
    X.attach(host);
    const list = X.projected(host,board), u1 = list.find(b => b.label === "U1"), u2 = list.find(b => b.label === "U2");
    assert.equal(list.length,2);
    assert.deepEqual(u1.problems,[warning,error,shared]);
    assert.deepEqual(u2.problems,[shared]);
    const {overlay} = renderer(board), fit = frame(10), coarse = drawn(overlay,fit);
    assert.equal(coarse.ink.length,5,"the two projected groups emit only one existing badge symbol in overview");
    assert.deepEqual(coarse.counts,[],"a multi-footprint cell needs no count text");
    const picked = pick(u1,fit);
    assert.equal(picked.label,"U1");
    assert.equal(pick(u1,fit),picked,"repeated hover on the same camera reuses the assembled findings");
    assert.deepEqual(picked.problems,[error,warning,shared],"the cross-probe opens the real winning-component error");
    assert.deepEqual(picked.entries.map(e => e.labels),[["U1"],["U1"],["U1","U2"]]);
    assert.equal(picked.count,3,"shared underlying findings are counted once");
    assert.equal(pick(u2,fit),null,"the collapsed badge was not painted and is not a hit target");
    const cut = frame(10,-center(u1,fit)[0]-4);
    const proxy = pick(u2,cut);
    assert.equal(proxy.label,"U2");
    assert.equal(proxy.problems[0],shared,"clicking the proxy still opens a finding about that component");
    assert.equal(proxy.count,3);
    assert.notEqual(pick(u1,fit),picked,"the detail lives only as long as the pane's latest camera plan");
    assert.equal(overlay.panDamage(cut,-20,0).length,2,"repair bounds include both badge centers");
    assert.deepEqual(overlay.panDamage(fit,1,0),[],"unchanged representatives use ordinary pan strips");
    const split = frame(20), close = frame(48);
    assert.equal(pick(u1,split),u1);
    assert.equal(pick(u2,split),u2,"a finer band splits the group at the same world origin");
    assert.equal(pick(u2,close),u2,"close inspection returns the original projected badge");
    assert.equal(drawn(overlay,close).ink.length,10,"both close badges use the existing artwork");
  } finally { K.clear(); }
});

test("problem markers: one size for sheet and board, grown with zoom and clamped on screen; hits track it", () => {
  const M = globalThis.AtriumProblemMarks;
  for (const kind of ["schematic", "pcb"]) {
    let last = 0;
    for (const scale of [.5, 2, 8, 16, 32, 64, 400]) {
      const z = M.size(scale, kind), h = M.size(scale, kind, "hint");
      assert.ok(z.screen >= M.MIN && z.screen <= M.MAX, kind + " " + scale + ": " + z.screen);
      assert.ok(z.screen >= last, "never shrinks when zooming in"); last = z.screen;
      assert.ok(Math.abs(z.r * scale - z.screen) < 1e-9, "world radius");
      assert.ok(h.screen < z.screen, "a hint is quieter than an error");
    }
    assert.equal(M.size(.5, kind).screen, M.MIN); assert.equal(M.size(400, kind).screen, M.MAX);
    assert.ok(M.size(30, kind).screen > M.MIN, kind + " markers grow before the maximum");
  }
  // A badge is hit where it is drawn, at every zoom, and not far beyond.
  for (const scale of [2, 20, 200]) {
    const view = {scale: () => scale, worldToScreen: p => [p[0] * scale, p[1] * scale]}, b = {at: [10, 10]}, c = M.badgeAt(b.at, scale, "schematic");
    assert.equal(M.badgeUnder({view}, [b], "schematic", c.x * scale + c.z.screen * .7, c.y * scale), b);
    assert.equal(M.badgeUnder({view}, [b], "schematic", c.x * scale + c.z.screen + 8, c.y * scale), null);
  }
  // Markers that would overlap on screen merge: the worst rank stands for the group, placed at the first.
  {
    const rows = [{id: "w", at: [0, 0], rank: 1}, {id: "e", at: [.3, 0], rank: 0}, {id: "e2", at: [.6, 0], rank: 0}, {id: "far", at: [5, 0], rank: 0}];
    const at = r => r.at, rank = r => r.rank;
    const zoomedOut = M.cluster(rows, at, 10, "pcb", rank);    // markers 7 px: 0.3 mm = 3 px apart
    assert.deepEqual(zoomedOut.map(c => [c.rep.id, c.members.length, c.at]), [["e", 3, [0, 0]], ["far", 1, [5, 0]]]);
    const zoomedIn = M.cluster(rows, at, 400, "pcb", rank);    // markers 20 px: 0.3 mm = 120 px apart
    assert.equal(zoomedIn.length, 4, "apart once zoomed in");
    assert.deepEqual(M.cluster(rows, at, 10, "pcb", rank).map(c => c.rep.id), zoomedOut.map(c => c.rep.id), "the same groups every frame");
  }
  // The shared painter preserves badge order, halo, severity and count.
  const texts = [], strokes = [], fills = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === "fillText") return text => texts.push(text);
      if (k === "stroke") return () => strokes.push(t.strokeStyle);
      if (k === "fill") return () => fills.push(t.fillStyle);
      return k in t ? t[k] : () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  ctx.getTransform = null;
  M.paintBadges(ctx,{scale:10},[{at:[0,0],severity:"error",count:1},{at:[1,0],severity:"warning",count:3}],
    "pcb",{error:"red",warning:"amber",halo:"black"});
  assert.deepEqual(texts,["3"]);
  assert.deepEqual(strokes,["black","red","black","red","red","black","amber","black","amber","amber"]);
  assert.deepEqual(fills,["black","black","black","black","amber"]);
  const angle = Math.PI * 2 / 3, c = Math.cos(angle), s = Math.sin(angle);
  const camera = flipped => ({worldToScreen: ([x, y]) => [c * flipped * x - s * y, s * flipped * x + c * y]});
  assert.equal(M.mirrored({}, camera(1)), false, "rotation keeps count text unmirrored");
  assert.equal(M.mirrored({}, camera(-1)), true, "a flipped camera corrects count text at the same rotation");
});

console.log(passed + " cross-domain tests passed");
