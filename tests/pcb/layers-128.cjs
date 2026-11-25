"use strict";
// 128 copper layers: a 128-layer stack (Top, Inner 1–126, Bottom), one net routed L1 → L128
// through vias with a track on every layer, layer-aware DRC on deep inner layers (tracks and
// a blind Inner 120–Bottom via), connectivity, Gerber naming L1..L128, IPC-2581, the KiCad
// 32-layer warning, the interactive router's layer index and the autorouter's layer cap.
// Fixture: synthetic, built in the test.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "impedance", "altium-rules", "rules", "viastack",
  "board-shape", "rigid-flex", "polygon-pour", "bom", "fab-outputs", "ipc2581", "net-ties", "connectivity", "pcb-draw", "kicad-export", "sch-appearance", "canvas"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, ST = AtriumStackup, R = AtriumRules, F = AtriumFabOutputs, X = AtriumIPC2581, PCB = AtriumPCBAppearance;
const date = new Date(2026, 10, 18, 10, 30, 0);

// ---- the stack ----------------------------------------------------------------------------
assert.throws(() => ST.build(Array(129).fill("Signal")), /2 to 128 copper layers/);
const stack = ST.build(Array(128).fill("Signal"));
stack.drillPairs = [{from: "Top", to: "Bottom"}, {from: "Inner 120", to: "Bottom"}];
const p = A.project("Deep stack"), board = p.documents[1];
board.outline = [[0, 0], [135, 0], [135, 12], [0, 12]];
board.stackup = ST.normalize(stack);
const keys = ST.copperLayers(board, new Map());
assert.equal(keys.length, 128);
assert.deepEqual([keys[0], keys[1], keys[126], keys[127]], ["Top", "Inner 1", "Inner 126", "Bottom"]);
assert.equal(ST.copperIndex("Inner 126"), 126); assert.equal(ST.copperIndex("Bottom"), 127); assert.equal(ST.copperIndex("Inner 127"), -1);
assert.equal(PCB.index("Inner 126"), 126); assert.equal(PCB.name("Inner 99"), "Mid-Layer 99");
assert.deepEqual(ST.drillPairs(board, new Map()).filter(d => d.defined).map(d => d.from + "-" + d.to).sort(), ["Inner 120-Bottom", "Top-Bottom"]);

// ---- net A: L1 → L128, one track per layer, a through via between layers ----------------------
const Y = 6, xs = k => 2 + k;  // segment k on layer keys[k] runs from x = 2 + k to 3 + k
const add = o => { const i = {id: A.id(), ...o}; board.items.push(i); return i; };
add({kind: "pad", x: xs(0), y: Y, w: .6, h: .6, layer: "Top", net: "A", number: "1", shape: "rect", drill: 0});
for (let k = 0; k < 128; k++) {
  add({kind: "track", layer: keys[k], net: "A", width: .15, points: [[xs(k), Y], [xs(k + 1), Y]]});
  if (k < 127) add({kind: "via", x: xs(k + 1), y: Y, diameter: .3, drill: .15, net: "A", layer: "Multi"});
}
add({kind: "pad", x: xs(128), y: Y, w: .6, h: .6, layer: "Bottom", net: "A", number: "2", shape: "rect", drill: 0});
// Net B crosses A on Inner 100 (where A runs on Inner 100) and again where A runs on Inner 102.
add({kind: "track", layer: "Inner 100", net: "B", width: .1, points: [[xs(100) + .5, Y - 3], [xs(100) + .5, Y + 3]]});
add({kind: "track", layer: "Inner 100", net: "B", width: .1, points: [[xs(102) + .5, Y - 3], [xs(102) + .5, Y + 3]]});
// Net C: blind Inner 120 → Bottom vias, on A's Inner 121 track and on A's Inner 58 track.
add({kind: "via", x: xs(121) + .5, y: Y, diameter: .3, drill: .15, net: "C", layer: "Multi", fromLayer: "Inner 120", toLayer: "Bottom"});
add({kind: "via", x: xs(58) + .5, y: Y, diameter: .3, drill: .15, net: "C", layer: "Multi", fromLayer: "Inner 120", toLayer: "Bottom"});
A.validate(p);
const defs = new Map(p.library.map(d => [d.id, d]));
assert.equal(AtriumCanvas.routingLayers(board, defs).length, 128, "canvas layer list");

// ---- connectivity and DRC ----------------------------------------------------------------
const conn = AtriumConnectivity.inspect(board, defs);
const netA = conn.nets.find(n => n.name === "A");
assert.ok(netA, "net A: " + JSON.stringify(conn.nets.map(n => n.name)));
assert.deepEqual([netA.tracks, netA.vias, netA.islands], [128, 127, 1], "one island: L1 → L128");
assert.equal(conn.airwires.filter(a => a.net === "A").length, 0, "net A is routed L1 → L128 with no airwires");
assert.deepEqual(conn.airwires.map(a => a.net).sort(), ["B", "C"], "the B tracks and C vias are separate islands");
const t0 = Date.now(), out = R.drc(board, defs, R.create(), {connections: conn, project: p}), ms = Date.now() - t0;
const hits = out.violations.filter(v => v.type === "clearance" || v.type === "shortCircuit");
const nearX = x => hits.some(v => [v.at, v.otherAt].some(a => a && Math.abs(a[0] - x) < .6));
assert.ok(nearX(xs(100) + .5), "B crossing A on Inner 100 is flagged: " + JSON.stringify(hits.map(v => v.title)));
assert.ok(!nearX(xs(102) + .5), "B on Inner 100 over A on Inner 102 is not");
assert.ok(nearX(xs(121) + .5), "the blind Inner 120–Bottom via on A's Inner 121 track is flagged");
assert.ok(!nearX(xs(58) + .5), "the same via over A's Inner 58 track is not");
assert.ok(hits.some(v => /Mid-Layer 100|Inner 100/.test(v.title)), "the violation names the deep layer");
assert.ok(ms < 20000, "DRC on 128 layers took " + ms + " ms");

// ---- Gerber: one copper file per layer, L1..L128 ---------------------------------------------
const fab = F.build(p, board, {date});
const copper = fab.files.filter(f => /Copper,L\d+,/.test(f.content || ""));
assert.equal(copper.length, 128, "128 copper Gerbers");
const fns = copper.map(f => /TF\.FileFunction,Copper,L(\d+),(Top|Inr|Bot)/.exec(f.content)).map(m => [+m[1], m[2]]);
assert.deepEqual(fns.map(f => f[0]).sort((a, b) => a - b), Array.from({length: 128}, (_, i) => i + 1));
assert.deepEqual(fns.find(f => f[0] === 1)[1], "Top"); assert.deepEqual(fns.find(f => f[0] === 128)[1], "Bot"); assert.deepEqual(fns.find(f => f[0] === 64)[1], "Inr");
const exts = new Set(copper.map(f => f.name.split(".").pop()));
assert.ok(exts.has("GTL") && exts.has("GBL") && exts.has("G1") && exts.has("G126"), [...exts].slice(0, 6).join());
assert.equal(exts.size, 128, "distinct copper file names");
const drill = fab.files.filter(f => f.kind === "drill");
assert.ok(drill.length >= 2, "through and Inner 120–Bottom drill files: " + drill.map(f => f.name).join());

// ---- IPC-2581: 128 copper layers in the stack-up ----------------------------------------------
const ipc = X.build(p, board, {date}), chk = X.check(ipc.content);
assert.deepEqual(chk.errors, []);
const layerNodes = (ipc.content.match(/<Layer [^>]*layerFunction="(SIGNAL|PLANE|CONDUCTOR)"/g) || []).length;
assert.equal(layerNodes, 128, "IPC-2581 copper layers");

// ---- KiCad: at most 32 copper layers, with a warning --------------------------------------------
const kc = AtriumKiCad.exportBoard(p, board.id);
assert.ok(kc.diagnostics.some(d => /at most 32 copper layers/.test(d)), kc.diagnostics.join(" | "));
assert.ok(/"In30\.Cu"/.test(kc.content) && !/"In31\.Cu"/.test(kc.content), "KiCad layers stop at In30.Cu");

// ---- router and autorouter layer handling ---------------------------------------------------
for (const f of ["../../app/pcb/router.js", "../../app/pcb/diffpair.js", "../../app/pcb/autorouter.js"]) { try { require(f); } catch { /* optional */ } }
if (globalThis.AtriumAutorouter?.copperIndex) {
  const AR = AtriumAutorouter;
  assert.equal(AR.copperIndex("Inner 126"), 126); assert.equal(AR.copperIndex("Bottom"), 127);
  assert.equal(AR.boardLayers(board, defs).length, 128);
}
if (globalThis.AtriumRouter?.copperLayers) assert.equal(AtriumRouter.copperLayers(board, defs).length, 128, "interactive router layers");
console.log("128 layers ok (DRC " + ms + " ms, " + copper.length + " copper Gerbers)");
