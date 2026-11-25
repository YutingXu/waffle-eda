"use strict";
// Margin certificates for copper Clearance (app/checks/drc-certs.js): after
// every random edit the store's results equal AtriumRules.drc's copper-pair Clearance results, field
// for field (rule, objects, title, distance, location). Edits: small and large moves, part rotations,
// width, net, pin net and layer changes, deletes, re-adds (at the end and back in place), a reorder,
// footprint edits in the library, and rule edits (gaps up and down, a net-scoped rule on and off, a
// clearance matrix cell, a change beyond SLACK/2 that needs a rebuild). Several seeds; net ties too.
// Then the real Altium board (PiDP-11) with its imported rules.
// Run: scripts/test-jsc.sh drc-certs   (or node tests/checks/drc-certs.cjs [edits=240])
const assert = require("node:assert/strict");
const path = require("node:path"), fs = require("node:fs");
const {appFile} = require("../support/app-source-paths.cjs");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
globalThis.CFB = require(appFile("vendor/cfb.min.js"));
for (const m of ["model", "net-ties", "parts", "nav-common", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "viastack", "polygon-pour", "component-classes", "query",
  "import-link", "source-file", "sch-import", "altium-rules", "pcb-pours", "pcb-import", "io", "connectivity", "net-intent", "signals", "rules", "import-rules", "drc-certs"]) require(appFile(m + ".js"));
require("../pcb/dense-board.js");
const R = AtriumRules, C = AtriumDRCCerts, X = R.kit;
const scope = AtriumDesignQueryRecord.selector;
const EDITS = Number(process.argv[2]) || 240;
const key = v => JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]]));
const truth = (doc, defs, rules) => R.drc(doc, defs, rules, {types: ["clearance"], limit: 1e6}).violations.filter(C.isPair);
function same(store, doc, defs, rules, what) {
  const want = truth(doc, defs, rules).map(key).sort(), got = store.violations().map(key).sort();
  if (want.join("\n") === got.join("\n")) return want.length;
  const w = new Set(want), g = new Set(got);
  assert.fail(what + ": the store differs from AtriumRules.drc\n  missing " + (want.find(x => !g.has(x)) || "-") + "\n  extra   " + (got.find(x => !w.has(x)) || "-"));
}
const clone = x => JSON.parse(JSON.stringify(x));

{
  require(appFile("undo-store.js"));
  const U = AtriumUndoStore, project = Atrium.project("Clearance order"), history = [], future = [];
  const doc = Atrium.sheet("pcb", "Clearance order"), defs = new Map();
  project.documents = [doc];
  const track = (id, x) => ({id, kind: "track", layer: "Top", width: .2, net: id, points: [[x, 0], [x, 1]]});
  const left = track("left", 0), right = track("right", 1.04);
  const target = {id: "target", kind: "via", net: "target", layer: "Top", drill: .2, diameter: .4, x: .52, y: .5};
  const distant = Array.from({length: 20}, (_, n) => track("distant-" + n, 5 + 2 * n));
  doc.items = [left, ...distant, target, right];
  let rules = X.migrate(R.defaults());
  const store = C.create(doc, defs, rules), selected = new Set([target.id]);
  U.reset(project);
  const mark = () => U.mark(project, {current: doc.id});
  mark();
  let seq = U.changed(doc, null).seq;
  const update = () => {
    const change = U.changed(doc, seq);
    assert.ok(change.ids?.has(target.id), "the journal reported the changed via");
    seq = change.seq;
    store.update(change.ids, change.items);
  };
  const edit = (label, apply) => {
    const before = mark();
    apply();
    U.checkpoint(history, future, before, label);
    U.record(project, {doc, items: [target]});
    update();
  };
  const travel = n => {assert.ok(U.jump(history, future, mark(), n)); update();};
  const compare = (expected, label) => {
    const full = truth(doc, defs, rules);
    assert.deepEqual(full.map(v => [v.id, v.otherId, v.ruleId]), expected, label + " full DRC");
    assert.equal(JSON.stringify(store.violationsFor(selected)), JSON.stringify(full), label + " local DRC");
    assert.equal(JSON.stringify(store.violations()), JSON.stringify(full), label + " stored DRC");
  };
  const tight = [["target", "right", "clearance-1"]];
  compare([], "initial clearances");
  edit("Move via", () => {target.x = .6;});
  compare(tight, "move creates a violation");
  travel(-1);
  compare([], "undo removes the violation");
  travel(1);
  compare(tight, "redo restores the violation");
  travel(-1);

  rules = clone(rules);
  const general = rules.list.find(r => r.id === "clearance-1");
  general.gap = .27;
  rules.list.unshift({...general, id: "left-first", name: "Left net", scope: scope("net", "left"), objects: {"track-via": .3}});
  rules.list.forEach((r, n) => {r.priority = n + 1;});
  assert.ok(!store.setRules(rules).rebuild);
  const ordered = [["left", "target", "left-first"], ...tight];
  compare(ordered, "stricter rule and higher-priority scoped matrix");
  edit("Reorder via", () => {doc.items.splice(doc.items.indexOf(target), 1); doc.items.push(target);});
  compare([["left", "target", "left-first"], ["right", "target", "clearance-1"]], "reorder changes pair orientation");
  travel(-1);
  compare(ordered, "undo restores pair orientation");
  edit("Delete via", () => {doc.items.splice(doc.items.indexOf(target), 1);});
  compare([], "delete removes violations");
  travel(-1);
  compare(ordered, "undo deletion restores the via in its original position");
  U.reset();
  console.log("ok - local clearance matches full DRC in order through a move, rule change, reorder, deletion and undo/redo");
}

{
  const doc = Atrium.sheet("pcb", "Dense clearance results"), defs = new Map(), rules = R.defaults();
  const track = (id, x) => ({id, kind: "track", layer: "Top", width: .2, net: id, points: [[x, 0], [x, 1]]});
  for (let n = 0; n < 12; n++) doc.items.push(track("a" + n, 2 * n), track("b" + n, 2 * n + .36));
  const items = new Map(doc.items.map(i => [i.id, i])), ids = new Set(items.keys());
  const store = C.create(doc, defs, rules);
  doc.items.reverse();
  store.update(ids, items);
  const full = truth(doc, defs, rules);
  assert.equal(full.length, 12, "the violating pairs touch every item");
  assert.equal(JSON.stringify(store.violationsFor(ids)), JSON.stringify(full), "dense local results follow current board order");
  assert.equal(JSON.stringify(store.violations()), JSON.stringify(full), "all stored results follow current board order");
  console.log("ok - dense clearance results match full DRC in the reversed board order");
}

function fuzz(seed0, edits) {
  let seed = seed0;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345 >>> 0) % 2147483648) / 2147483648;
  const {d: doc, defs: base} = makeAtriumBenchmarkBoard(36);
  // A private copy of the library: footprint edits below change it in place.
  const defs = new Map([...base].map(([id, def]) => [id, clone(def)]));
  const tie = AtriumParts.catalogue.find(x => x.id === "std-nettie-2"); defs.set(tie.id, clone(tie));
  let k = 0;
  for (const i of doc.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 12), "2": "N" + ((k + 1) % 12)}; else i.net = "N" + (k % 12); k++;}
  for (let t = 0; t < 4; t++) doc.items.push({id: "tie" + t, kind: "part", def: tie.id, ref: "NT" + t, x: 10 + t * 15, y: 20 + t * 5, angle: 0, layer: "Top", pinNets: {1: "N" + t, 2: "N" + (t + 1)}});
  let rules = X.migrate(R.defaults());
  rules.list.unshift({id: "clr-n3", type: "clearance", name: "N3", enabled: true, priority: 0, scope: scope("net", "N3"), scope2: scope("all"), gap: .3});
  rules.list.forEach((r, n) => { r.priority = n + 1; });
  let store = C.create(doc, defs, rules);
  same(store, doc, defs, rules, "seed " + seed0 + " build");
  const removed = [], kinds = {};
  let rebuilds = 0;
  for (let n = 0; n < edits; n++) {
    const items = doc.items, it = items[Math.floor(rnd() * items.length)], r = rnd();
    let kind, changed = [it.id];
    if (r < .3) {kind = "move"; const s = rnd() < .6 ? .1 : .8, dx = (rnd() - .5) * s, dy = (rnd() - .5) * s; if (it.points) it.points = it.points.map(q => [q[0] + dx, q[1] + dy]); else {it.x += dx; it.y += dy;}}
    else if (r < .36 && it.kind === "part") {kind = "rotate"; it.angle = ((it.angle || 0) + 90) % 360;}
    else if (r < .42 && it.kind === "track") {kind = "width"; it.width = Math.max(.1, it.width + (rnd() - .5) * .1);}
    else if (r < .5) {kind = "net"; if (it.kind === "part") it.pinNets = {...it.pinNets, "1": "N" + Math.floor(rnd() * 12)}; else it.net = "N" + Math.floor(rnd() * 12);}
    else if (r < .54 && it.kind === "track") {kind = "layer"; it.layer = it.layer === "Top" ? "Bottom" : "Top";}
    else if (r < .62) {kind = "delete"; const at = items.indexOf(it); items.splice(at, 1); removed.push([it, at]);}
    else if (r < .68 && removed.length) {const [back, at] = removed.pop(); changed = [back.id]; if (rnd() < .5) {kind = "re-add"; items.push(back);} else {kind = "undo delete"; items.splice(Math.min(at, items.length), 0, back);}}
    else if (r < .71) {kind = "reorder"; items.splice(items.indexOf(it), 1); items.unshift(it);} // Bring to Front: the item is in the journal, unchanged
    else if (r < .74) {
      kind = "footprint"; const def = defs.get("std-r"), pad = def.footprint.pads[Math.floor(rnd() * def.footprint.pads.length)];
      pad.x += (rnd() - .5) * .3; changed = items.filter(i => i.def === "std-r").map(i => i.id);
    } else {
      kind = "rules"; rules = clone(rules);
      const q = rnd(), main = rules.list.find(x => x.id === "clearance-1"), n3 = rules.list.find(x => x.id === "clr-n3");
      if (q < .4) main.gap = Math.round((.15 + rnd() * .2) * 1000) / 1000;
      else if (q < .6) n3.enabled = !n3.enabled;
      else if (q < .8) {if (main.objects) delete main.objects; else main.objects = {"track-via": Math.round((main.gap + .05) * 1000) / 1000};}
      else if (q < .9) n3.gap = Math.round((.2 + rnd() * .15) * 1000) / 1000;
      else main.gap = .9; // beyond SLACK/2: a rebuild
    }
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (kind === "rules") {
      const s = store.setRules(rules);
      if (s.rebuild) {rebuilds++; store = C.create(doc, defs, rules);}
    } else {
      const byId = new Map(doc.items.map(i => [i.id, i]));
      store.update(changed, new Map(changed.filter(id => byId.has(id)).map(id => [id, byId.get(id)])));
    }
    same(store, doc, defs, rules, "seed " + seed0 + " edit " + (n + 1) + " (" + kind + ")");
  }
  return {kinds, rebuilds, stats: store.stats};
}
for (const seed of [1, 2, 3]) {
  const r = fuzz(seed, EDITS);
  assert.ok(r.stats.advanced > 0 && r.stats.rechecked > 0 && r.stats.requeries > 0 && r.stats.arithmetic > 0, "advancement, re-checks, re-queries and arithmetic all ran: " + JSON.stringify(r.stats));
  console.log("ok - seed " + seed + ": " + EDITS + " random edits " + JSON.stringify(r.kinds) + ", " + r.rebuilds + " rebuilds, every result equal to AtriumRules.drc");
}

{
  // The real Altium board with its imported rules.
  const DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const p = Atrium.project("PiDP-11 I/O Expander"); p.documents = []; p.library = [];
  for (const name of ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]) {
    const r = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name))));
    p.documents.push(...(r.documents || [])); p.library.push(...(r.library || []));
  }
  AtriumImportLink.reconcile(p, p.documents);
  const defs = new Map(p.library.map(x => [x.id, x])), doc = p.documents.find(x => x.kind === "pcb");
  assert.ok(AtriumImportRules.apply(doc, p, defs).converted > 0);
  const imported = p.rules.list.find(r => r.type === "clearance" && r.origin?.tool === "Altium" && r.origin.board === doc.id);
  assert.ok(imported && AtriumDesignQueryRecord.valid(imported.scope) && AtriumDesignQueryRecord.valid(imported.scope2));
  let rules = R.stored(doc, p);
  assert.equal(rules.list.find(r => r.id === imported.id)?.gap, .1524, "the certificate test uses the source's 6 mil clearance");
  assert.ok(C.supports(doc, rules, p), "the imported rules have no hole cells");
  const store = C.create(doc, defs, rules, {project: p});
  const n0 = same(store, doc, defs, rules, "PiDP-11 build");
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345 >>> 0) % 2147483648) / 2147483648;
  for (let n = 0; n < 60; n++) {
    const it = doc.items.filter(i => i.kind === "track" || i.kind === "via" || i.kind === "part")[Math.floor(rnd() * 300)];
    if (!it) continue;
    const dx = (rnd() - .5) * .4, dy = (rnd() - .5) * .4;
    if (it.points) it.points = it.points.map(q => [q[0] + dx, q[1] + dy]); else {it.x += dx; it.y += dy;}
    store.update([it.id], new Map([[it.id, it]]));
    if (n % 6 === 5) same(store, doc, defs, rules, "PiDP-11 edit " + (n + 1));
  }
  rules = clone(X.migrate(rules)); for (const r of rules.list) if (r.type === "clearance") r.gap = Math.round((r.gap + .05) * 1e4) / 1e4;
  const s = store.setRules(rules);
  assert.ok(!s.rebuild, "a 0.05 mm change is answered from the store: " + s.reason);
  const n1 = same(store, doc, defs, rules, "PiDP-11 rule edit");
  console.log("ok - PiDP-11: " + n0 + " → " + n1 + " copper clearance results after 60 moves and a rule edit (" + s.arithmetic + " by arithmetic, " + s.narrow + " measured, " + s.ms.toFixed(2) + " ms)");
}
