"use strict";
// Design Insights, incremental against full (app/checks/insights.js): seeded random edit sequences on
// real designs (the public PiDP-11 board and sheet, the native signal-board and sample-sensor
// projects) and the 25.6k-object benchmark board. Every edit goes through the undo store the way the
// editor makes it (a local edit with or without a touched hint, Undo, Redo, a change made without a
// step as a collaboration peer, an extension or a refill does, a paste, a delete, a library or rule
// edit), and the engine reads the journal from its own cursor as the editor's client does
// (insights-ui.js start()). After every step the incremental result must equal a from-scratch full
// pass (AtriumInsights.analyze): the same insights, fields and order. Efficiency mode (skipHeavy, then
// the delayed heavy pass) must equal it after each heavy pass.
// Reports how each kind of edit reached the engine (incremental, or full and why).
// Run: node tests/checks/insights-incremental.cjs [--quick]
const assert = require("node:assert/strict");
const P = require("../support/app-source-paths.cjs");
for (const m of ["model", "parts", "spatial", "connectivity", "sch-objects", "pcb-pours", "pcb-appearance", "stackup", "impedance", "rigid-flex", "altium-rules", "net-intent", "signals", "rules",
  "board-shape", "viastack", "polygon-pour", "pdn", "ipc2152", "si", "return-path", "erc", "design-query", "undo-store", "insights", "insights-pcb", "insights-sch"]) require(P.appFile(m + ".js"));
require("../pcb/dense-board.js");
const {publicPiDP} = require("../support/public-pidp.cjs");
const {nativeCAD} = require("../support/native-cad.cjs");
const A = Atrium, I = AtriumInsights, U = AtriumUndoStore;
const quick = process.argv.includes("--quick");
const clock = () => globalThis.performance?.now?.() ?? Date.now();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// What the user sees of an insight (fix functions by label).
const shown = x => JSON.stringify([x.key, x.check, x.severity, x.title, x.message, x.why, x.objects, x.at, x.net, x.netPair, x.line, x.land, x.box, x.layer, x.value, x.subject, x.fix?.label, x.dismissalKeys]);
const drain = it => { let r = it.next(); while (!r.done) r = it.next(); return r.value; };

// A small editor over the undo store, as editor.js uses it.
function editor(project) {
  U.reset(); U.touch(project); U.sync(project);
  const history = [], future = [];
  return {
    get project() { return project; },
    edit(fn, touched) { const before = U.mark(project); fn(project); U.checkpoint(history, future, before); U.touch(project, touched); },
    derive(fn, touched) { fn(project); U.touch(project, touched); },
    // A collaboration peer's change (collab-presence.js): host.derive({touched}) inside peerPatch.
    peer(fn, touched) { U.peerPatch(project, () => { fn(project); U.touch(project, touched); }); },
    go(n) { const t = U.jump(history, future, U.mark(project), n); if (!t) return false; project = U.root(); U.touch(project, undefined, true); return true; }
  };
}
// The editor's insights client: one engine, the journal read from its own cursor.
function client(ed, doc, efficient = false) {
  const e = I.engine();
  let since;
  return {
    pass(o = {}) {
      const ch = U.changed(doc, since);
      const hint = since != null ? {from: since, to: ch.seq, ids: ch.ids, items: ch.items} : {from: null, to: ch.seq, ids: null, items: null};
      const t = clock(), r = drain(e.update(ed.project, doc, new Map(ed.project.library.map(d => [d.id, d])), hint,
        {prefs: false, outer: U.outer(), skipHeavy: efficient && !o.heavy, sheetChanged: s => { const c = U.changed(s, since); return since == null || c.ids == null || c.ids.size > 0; }}));
      since = ch.seq;
      return {...r, wall: clock() - t};
    }, engine: e};
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
let uid = 0;
const fresh = p => p + "-x" + (++uid);
// Random board edits: [name, apply(ed, doc, r) → true when it changed something].
function boardOps(doc) {
  const kinds = k => doc.items.filter(i => i.kind === k);
  const touched = items => ({doc, items});
  return [
    ["move part", (ed, r) => { const p = pick(r, kinds("part")); if (!p) return false; ed.edit(() => { p.x += (r() - .5) * 4; p.y += (r() - .5) * 4; }, touched([p])); return true; }],
    ["rotate part (no hint)", (ed, r) => { const p = pick(r, kinds("part")); if (!p) return false; ed.edit(() => { p.angle = ((p.angle || 0) + 90) % 360; }); return true; }],
    ["bend track", (ed, r) => { const t = pick(r, kinds("track")); if (!t || t.points.length < 2) return false; ed.edit(() => { const k = 1 + Math.floor(r() * (t.points.length - 1)); t.points[k] = [t.points[k][0] + (r() - .5) * 3, t.points[k][1] + (r() - .5) * 3]; }, touched([t])); return true; }],
    ["track width", (ed, r) => { const t = pick(r, kinds("track")); if (!t) return false; ed.edit(() => { t.width = pick(r, [.08, .1, .15, .2, .3, .6, 1]); }, touched([t])); return true; }],
    ["track net", (ed, r) => { const t = pick(r, kinds("track")), o = pick(r, doc.items.filter(i => i.net)); if (!t || !o) return false; ed.edit(() => { t.net = o.net; }, touched([t])); return true; }],
    ["via size", (ed, r) => { const v = pick(r, kinds("via")); if (!v) return false; ed.edit(() => { v.diameter = pick(r, [.3, .45, .6, .8]); v.drill = Math.min(v.diameter - .05, pick(r, [.15, .2, .3])); }, touched([v])); return true; }],
    ["add track", (ed, r) => { const o = pick(r, doc.items.filter(i => i.kind === "track" || i.kind === "via")); if (!o) return false; const at = o.points ? o.points[0] : [o.x, o.y];
      ed.edit(() => { doc.items.push({id: fresh("t"), kind: "track", net: o.net, layer: o.layer && o.layer !== "Multi" ? o.layer : "Top", width: pick(r, [.1, .2, .25]), points: [at.slice(), [at[0] + 2 + r() * 3, at[1] + (r() - .5) * 3], [at[0] + 3 + r() * 2, at[1] + r() * 4 - 2]]}); }); return true; }],
    ["add via", (ed, r) => { const o = pick(r, doc.items.filter(i => i.net)); if (!o) return false; const at = o.points ? o.points.at(-1) : [o.x, o.y];
      ed.edit(() => { doc.items.push({id: fresh("v"), kind: "via", net: o.net, x: at[0] + (r() - .5), y: at[1] + (r() - .5), diameter: .6, drill: .3, layer: "Multi"}); }); return true; }],
    ["delete", (ed, r) => { const o = pick(r, doc.items.filter(i => ["track", "via", "part", "pad"].includes(i.kind))); if (!o) return false; ed.edit(() => { doc.items.splice(doc.items.indexOf(o), 1); }); return true; }],
    ["paste", (ed, r) => { const start = Math.floor(r() * doc.items.length), src = doc.items.slice(start, start + 4).filter(i => ["track", "via", "part"].includes(i.kind)); if (!src.length) return false;
      ed.edit(() => { for (const s of src) { const c = JSON.parse(JSON.stringify(s)); c.id = fresh(s.kind); if (c.points) c.points = c.points.map(q => [q[0] + 5, q[1] + 3]); else { c.x += 5; c.y += 3; } if (c.ref) c.ref = c.ref + "_" + uid; doc.items.push(c); } }); return true; }],
    ["peer edit (touched)", (ed, r) => { const t = pick(r, kinds("track")); if (!t) return false; ed.peer(() => { t.width = pick(r, [.1, .2, .5]); t.points[0] = [t.points[0][0] + .5, t.points[0][1]]; }, touched([t])); return true; }],
    ["peer edit (no scope)", (ed, r) => { const p = pick(r, kinds("part")); if (!p) return false; ed.peer(() => { p.x += 1.5; }); return true; }],
    ["derived change (touched)", (ed, r) => { const t = pick(r, kinds("track")); if (!t) return false; ed.derive(() => { t.width = pick(r, [.1, .2, .5]); }, touched([t])); return true; }],
    ["undo", ed => ed.go(-1)], ["redo", ed => ed.go(1)], ["undo", ed => ed.go(-1)],
    ["rule edit", (ed, r) => { const p = ed.project; if (r() < .7) return false; ed.edit(() => { p.rules = p.rules || {format: "atrium-rules", version: 3, units: "mm", list: []}; p.rules.list = (p.rules.list || []).filter(x => x.id !== "r-ring");
      p.rules.list.push({id: "r-ring", type: "annularRing", name: "Ring", comment: "", enabled: true, priority: 1, scope: {kind: "all"}, min: pick(r, [.05, .1, .15])}); }); return true; }]
  ];
}
function sheetOps(doc) {
  const of = k => doc.items.filter(i => i.kind === k);
  return [
    ["move part", (ed, r) => { const p = pick(r, of("part")); if (!p) return false; ed.edit(() => { p.x += Math.round((r() - .5) * 8) * 2.54; }, {doc, items: [p]}); return true; }],
    ["rename label", (ed, r) => { const l = pick(r, doc.items.filter(i => i.kind === "netlabel" || i.kind === "port")); if (!l) return false; ed.edit(() => { l.text = pick(r, ["GND", "VCC", "3V3", "SDA", "SCL", "CLK", "VCC_3V3", "GDN", (l.text || "N") + "1"]); }, {doc, items: [l]}); return true; }],
    ["part value", (ed, r) => { const p = pick(r, of("part")); if (!p) return false; ed.edit(() => { p.value = pick(r, ["10k", "100n", "4.7u 6.3V", "1u 50V", "22p", p.value]); }, {doc, items: [p]}); return true; }],
    ["add wire", (ed, r) => { const w = pick(r, of("wire")); if (!w) return false; ed.edit(() => { const a = w.points[0]; doc.items.push({id: fresh("w"), kind: "wire", points: [a.slice(), [a[0] + 2.54 * 4, a[1]]]}); }); return true; }],
    ["delete", (ed, r) => { const o = pick(r, doc.items.filter(i => ["wire", "netlabel", "part", "junction"].includes(i.kind))); if (!o) return false; ed.edit(() => { doc.items.splice(doc.items.indexOf(o), 1); }); return true; }],
    ["peer edit (touched)", (ed, r) => { const p = pick(r, of("part")); if (!p) return false; ed.peer(() => { p.y += 2.54; }, {doc, items: [p]}); return true; }],
    ["undo", ed => ed.go(-1)], ["redo", ed => ed.go(1)]
  ];
}

const how = new Map(); // edit kind → {incremental, full: {why: n}, ms: []}
function note(kind, r) {
  let h = how.get(kind); if (!h) how.set(kind, h = {incremental: 0, none: 0, full: {}, ms: []});
  if (r.mode === "full") h.full[r.why] = (h.full[r.why] || 0) + 1; else h[r.mode === "none" ? "none" : "incremental"]++;
  if (r.mode !== "full") h.ms.push(r.wall);
}
function run(label, project, docOf, ops, {seed, steps, efficient = false, heavyEvery = 3}) {
  const ed = editor(project), doc = docOf(ed.project), list = ops(doc), r = rng(seed), c = client(ed, doc, efficient);
  // light: only the checks an Efficiency-mode pass runs (heavy ones catch up in the heavy pass).
  const compare = (step, kind, res, light = false) => {
    const keep = x => !light || !I.check(x.check)?.heavy;
    const ref = I.analyze(ed.project, doc, new Map(ed.project.library.map(d => [d.id, d])), {}).insights.filter(keep);
    const a = res.insights.filter(keep).map(shown), b = ref.map(shown);
    if (a.join("\n") !== b.join("\n")) {
      const as = new Set(a), bs = new Set(b);
      assert.fail(label + " seed " + seed + " step " + step + " (" + kind + ", " + res.mode + (res.why ? " " + res.why : "") + "): incremental differs from a full pass\n  only incremental: " +
        a.filter(x => !bs.has(x)).slice(0, 3).join("\n    ") + "\n  only full: " + b.filter(x => !as.has(x)).slice(0, 3).join("\n    ") + (a.length === b.length && a.every(x => bs.has(x)) ? "\n  (same insights, different order)" : ""));
    }
    return ref.length;
  };
  let res = c.pass(), found = compare(0, "open", res);
  for (let s = 1; s <= steps; s++) {
    let kind, guard = 0;
    do kind = pick(r, list); while (!kind[1](ed, r) && ++guard < 20);
    res = c.pass();
    note(kind[0], res);
    if (efficient) {
      compare(s, kind[0] + " (efficient pass)", res, true);
      if (s % heavyEvery) continue;
      res = c.pass({heavy: true});
    }
    found = Math.max(found, compare(s, kind[0], res));
  }
  console.log("  " + label + " seed " + seed + ": " + steps + " steps, up to " + found + " insights");
  return found;
}

const pidp = () => publicPiDP();
const steps = quick ? 12 : 40;
// SEEDS=n adds n more seeds to each design (a longer soak than the default run).
const more = (from, n = +(process.env.SEEDS || 0)) => Array.from({length: n}, (_, i) => from + i);
test("PiDP-11 board: incremental equals full after every random edit (3 seeds)", () => {
  let most = 0;
  for (const seed of [1, 2, 3, ...more(100)]) most = Math.max(most, run("PiDP board", pidp(), p => p.documents.find(d => d.kind === "pcb"), boardOps, {seed, steps}));
  assert.ok(most > 0, "the board has insights to compare");
});
test("PiDP-11 sheet: incremental equals full after every random edit (2 seeds)", () => {
  for (const seed of [4, 5, ...more(200)]) run("PiDP sheet", pidp(), p => p.documents.find(d => d.kind === "schematic"), sheetOps, {seed, steps});
});
test("native signal-board and sample-sensor: board and sheets", () => {
  for (const name of ["signal-board", "sample-sensor"]) {
    const p0 = nativeCAD(name);
    if (p0.documents.some(d => d.kind === "pcb")) run(name + " board", nativeCAD(name), p => p.documents.find(d => d.kind === "pcb"), boardOps, {seed: 6, steps});
    if (p0.documents.some(d => d.kind === "schematic")) run(name + " sheet", nativeCAD(name), p => p.documents.find(d => d.kind === "schematic"), sheetOps, {seed: 7, steps});
  }
});
test("Efficiency mode: after each delayed heavy pass the result equals a full pass", () => {
  for (const seed of [8, ...more(300)]) run("PiDP board (efficient)", pidp(), p => p.documents.find(d => d.kind === "pcb"), boardOps, {seed, steps, efficient: true});
});
test("25.6k benchmark board with nets and pours", () => {
  const {d, defs} = makeAtriumBenchmarkBoard(quick ? 80 : 160);
  let n = 0;
  for (const i of d.items) if (i.kind === "track") i.net = "N" + (n++ % 400); else if (i.kind === "via") i.net = n % 3 ? "GND" : "N" + (n % 400); else if (i.kind === "part") i.pinNets = {"1": "N" + (n % 400), "2": "GND"};
  d.stackup = {version: 1, layers: AtriumStackup.build(["Signal", "Plane", "Plane", "Signal"]).layers};
  const w = d.outline[1][0], h = d.outline[2][1];
  d.items.push({id: "gnd", kind: "polygon", net: "GND", layer: "Inner 1", points: [[0, 0], [w, 0], [w, h], [0, h]]}, {id: "vcc", kind: "polygon", net: "VCC", layer: "Inner 2", points: [[0, 0], [w, 0], [w, h], [0, h]]});
  const p = A.project("Bench"); p.documents = [d]; p.library = [...defs.values()];
  run("benchmark board", p, q => q.documents[0], boardOps, {seed: 9, steps: quick ? 8 : 16});
});

console.log("how each kind of edit reached the engine (incremental / none / full by reason; incremental median ms):");
for (const [kind, h] of [...how].sort()) {
  const ms = h.ms.sort((a, b) => a - b), med = ms.length ? ms[ms.length >> 1].toFixed(1) : "-";
  console.log("  " + kind.padEnd(26) + " incremental " + String(h.incremental).padStart(3) + "  none " + String(h.none).padStart(2) + "  full " + JSON.stringify(h.full) + "  median " + med + " ms");
}
console.log(passed + " incremental insight tests passed");
