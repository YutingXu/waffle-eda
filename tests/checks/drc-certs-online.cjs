"use strict";
// Online DRC with margin certificates (app/checks/drc-view.js online(), app/checks/drc-certs.js): once the store is
// built (idle work after the first check), an edit re-measures only the Clearance pairs it can have
// brought too close and a rule edit is answered from the stored distances. After random edits and rule
// edits, with keep-outs and a net tie on the board, the online result equals a full check of the same
// types, every field. A rule edit on the 25.6k-object perf board costs at most 10 ms (it was a full check).
// Run: scripts/test-jsc.sh drc-certs-online   (or node tests/checks/drc-certs-online.cjs)
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "net-ties", "parts", "nav-common", "spatial", "board-shape", "stackup", "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals",
  "rules", "viastack", "polygon-pour", "connectivity", "drc", "checks", "drc-view", "drc-certs", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../support/drc-geometry.cjs");
require("../pcb/dense-board.js");
const V = AtriumDRCView, R = AtriumRules, X = R.kit, now = () => performance.now();
const key = v => JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]]));
const clone = x => JSON.parse(JSON.stringify(x));
// Shorts are compared as the online engine always kept them: per sub-board (a short's detail names the
// nets it joins there), so only the other types are compared field for field.
function same(got, doc, defs, rules, types, what) {
  const want = R.drc(doc, defs, rules, {types, limit: 5000}).violations.filter(v => v.type !== "short").map(key).sort(), have = got.filter(v => v.type !== "short").map(key).sort();
  if (want.join("\n") === have.join("\n")) return want.length;
  const w = new Set(want), h = new Set(have);
  assert.fail(what + ": online DRC differs from a full check\n  missing " + (want.find(x => !h.has(x)) || "-") + "\n  extra   " + (have.find(x => !w.has(x)) || "-"));
}
const drain = it => {for (;;) {const r = it.next(); if (r.done) return r.value;}};

{
  let seed = 5;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345 >>> 0) % 2147483648) / 2147483648;
  const {d: doc, defs} = makeAtriumBenchmarkBoard(30);
  const tie = AtriumParts.catalogue.find(x => x.id === "std-nettie-2"); defs.set(tie.id, tie);
  let k = 0;
  for (const i of doc.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 10), "2": "N" + ((k + 1) % 10)}; else i.net = "N" + (k % 10); k++;}
  doc.items.push({id: "nt", kind: "part", def: tie.id, ref: "NT1", x: 20, y: 20, angle: 0, layer: "Top", pinNets: {1: "N1", 2: "N2"}});
  for (let n = 0; n < 3; n++) doc.items.push({id: "ko" + n, kind: "track", layer: "Top", net: "", width: .3, keepout: true, points: [[5 + n * 20, 3], [5 + n * 20, 40]]});
  let rules = X.migrate(R.defaults());
  const E = V.online();
  let at = 1, r = E.update(doc, defs, rules, {from: null, to: at, ids: null, items: null, outer: "o", pours: 0});
  assert.equal(r.mode, "full");
  assert.ok(E.wantsStore(), "the engine wants a store once the board is checked");
  assert.ok(drain(E.buildStore()), "the store is built and agrees with the full check");
  assert.ok(E.store() && !E.wantsStore());
  const types = E.types(), removed = [], modes = {};
  assert.ok(r.violations.some(v => v.what === "Keep-out"), "the board has keep-out results (the rest of Clearance)");
  for (let n = 0; n < 160; n++) {
    const items = doc.items, it = items[Math.floor(rnd() * items.length)], q = rnd();
    let ids = [it.id];
    if (q < .4) {const s = rnd() < .6 ? .1 : .8, dx = (rnd() - .5) * s, dy = (rnd() - .5) * s; if (it.points) it.points = it.points.map(p => [p[0] + dx, p[1] + dy]); else {it.x += dx; it.y += dy;}}
    else if (q < .5) {if (it.kind === "part") it.pinNets = {...it.pinNets, "1": "N" + Math.floor(rnd() * 10)}; else it.net = "N" + Math.floor(rnd() * 10);}
    else if (q < .58 && it.kind === "track") it.width = Math.max(.1, it.width + (rnd() - .5) * .1);
    else if (q < .64) {items.splice(items.indexOf(it), 1); removed.push(it);}
    else if (q < .7 && removed.length) {const b = removed.pop(); items.push(b); ids = [b.id];}
    else {
      ids = []; rules = clone(rules);
      const w = rnd(), c = rules.list.find(x => x.type === "clearance"), tw = rules.list.find(x => x.type === "width");
      if (w < .5) c.gap = Math.round((.15 + rnd() * .2) * 1000) / 1000;
      else if (w < .7) c.objects = c.objects ? undefined : {"track-via": Math.round((c.gap + .04) * 1000) / 1000};
      else if (w < .85) tw.min = Math.round((.1 + rnd() * .15) * 1000) / 1000;
      else if (w < .93) c.gap = .9; // beyond the store's band: Clearance runs over the board, the store is built again
      else {const h = rules.list.find(x => x.type === "holeToHole"); h.gap = Math.round((.2 + rnd() * .3) * 1000) / 1000;} // not a per-object check: a full check
      if (c.objects === undefined) delete c.objects;
    }
    const map = new Map(ids.filter(id => doc.items.some(i => i.id === id)).map(id => [id, doc.items.find(i => i.id === id)]));
    r = E.update(doc, defs, rules, {from: at, to: at + 1, ids: new Set(ids), items: map, outer: "o", pours: 0}); at++;
    modes[r.mode] = (modes[r.mode] || 0) + 1;
    same(r.violations, doc, defs, rules, types, "edit " + (n + 1) + " (" + r.mode + ")");
    if (E.wantsStore()) drain(E.buildStore());
  }
  assert.ok(modes.rules > 10 && modes.incremental > 50 && modes.full >= 1, JSON.stringify(modes));
  console.log("ok - 160 random edits and rule edits with the store: the online result equals a full check " + JSON.stringify(modes));
}

{
  // The perf board with every copper object on a net (dense-netted): a Clearance rule edit.
  const {d: doc, defs} = makeAtriumBenchmarkBoard(160);
  let n = 0;
  for (const i of doc.items) if (i.kind !== "part") i.net = "N" + (n++ % 400); else i.pinNets = {"1": "N" + (n % 400), "2": "N" + ((n + 1) % 400)};
  const base = X.migrate(R.defaults()), gaps = [.21, .19, .2, .22, .15, .2];
  const resolver = AtriumResolvedGeometry;
  let snapshots = 0;
  globalThis.AtriumResolvedGeometry = {...resolver,read(source) {
    snapshots++;
    return resolver.read(source);
  }};
  const timed = (E, label) => {
    const before = snapshots;
    let at = 1, rules = base;
    E.update(doc, defs, rules, {from: null, to: at, ids: null, items: null, outer: "o", pours: 0});
    let built = 0;
    if (label === "store") {const t = now(); drain(E.buildStore()); built = now() - t; assert.ok(E.store(), "the store is built");}
    const ms = [];
    for (const g of gaps) {
      rules = clone(rules); rules.list.find(x => x.type === "clearance").gap = g;
      const t = now(), r = E.update(doc, defs, rules, {from: at, to: at + 1, ids: new Set(), items: new Map(), outer: "o", pours: 0}); ms.push(now() - t); at++;
      if (label === "store") assert.equal(r.mode, "rules");
      if (g === .22) same(r.violations, doc, defs, rules, E.types(), label + " gap " + g);
    }
    assert.equal(snapshots,before+1,"rule-only edits keep the initial physical bounds");
    ms.sort((a, b) => a - b);
    return {median: ms[ms.length >> 1], max: ms[ms.length - 1], built};
  };
  // "before": the engine without a store re-runs Clearance over the board (only the type whose rules changed);
  // before rule-only changes were scoped, every rule edit was a full check of every type (about 200 ms here).
  let before, after;
  try {
    before = timed(V.online(), "full");
    after = timed(V.online(), "store");
  } finally {
    globalThis.AtriumResolvedGeometry = resolver;
  }
  // (A full check reports at most 5,000 results per rule; the store reports them all, so the comparison
  // above is at a gap with fewer.)
  const limit = typeof process !== "undefined" && process.versions?.node ? 10 : 30; // JSC shim timing is coarser
  assert.ok(after.median <= limit, "a Clearance rule edit on the perf board takes " + after.median.toFixed(2) + " ms (budget " + limit + " ms)");
  console.log("ok - perf board (25.6k objects, netted): a Clearance rule edit " + before.median.toFixed(1) + " ms (Clearance over the board) → " + after.median.toFixed(2) + " ms median, " +
    after.max.toFixed(2) + " ms max with the store (built in " + after.built.toFixed(0) + " ms of idle work)");
}
