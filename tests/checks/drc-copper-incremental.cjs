"use strict";
// Online DRC and pour clearance after a refill, incremental against full (app/checks/drc-view.js
// online(), app/checks/drc-pours.js session(), app/pcb/pcb-pours.js copperChange()). Seeded random
// edit sequences on a netted board with poured polygons (tests/pcb/dense-board.js, two of the pours with
// a clearance below the rule so their copper has findings) go through the undo store the way the editor
// makes them: moves, adds, deletes, a paste, net and width changes, edits inside pours and next to their
// outlines, pour outline and pour clearance edits, a collaboration peer's edit, Undo and Redo. After each
// edit the stale pours are repoured as a live refill does (a derived change, no undo step), then:
//   - online DRC reads the journal from its own cursor (engine.update, as drc-view.js check() does) and
//     must equal a full check of the same types (AtriumRules.drc), every field (shorts as in
//     drc-certs-online.cjs: per sub-board);
//   - the pour-clearance session reads the journal from its own cursor (as the pour-drc client does)
//     and must equal AtriumDRCPours.verify(): the same violations, every field, in the same order.
// Reports how each kind of edit reached the engines. SEEDS=n adds seeds; --quick runs fewer steps.
// Run: node tests/checks/drc-copper-incremental.cjs [--quick]
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const P = require("../support/app-source-paths.cjs");
for (const m of ["model", "net-ties", "parts", "nav-common", "spatial", "board-shape", "stackup", "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals",
  "rules", "viastack", "polygon-pour", "connectivity", "drc", "drc-pours", "checks", "drc-view", "undo-store"]) require(P.appFile(m + ".js"));
require("../support/drc-geometry.cjs");
require("../pcb/dense-board.js");
const A = Atrium, R = AtriumRules, V = AtriumDRCView, U = AtriumUndoStore, PP = AtriumPolygonPour, DP = AtriumDRCPours;
const quick = process.argv.includes("--quick");
const clock = () => performance.now();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
const key = v => JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]]));
let uid = 0;
const fresh = p => p + "-x" + (++uid);

// A small editor over the undo store, as editor.js uses it (tests/checks/insights-incremental.cjs).
function editor(project) {
  U.reset(); U.touch(project); U.sync(project);
  const history = [], future = [];
  return {
    get project() { return project; },
    edit(fn, touched) { const before = U.mark(project); fn(project); U.checkpoint(history, future, before); U.touch(project, touched); },
    derive(fn, touched) { fn(project); U.touch(project, touched); },
    peer(fn, touched) { U.peerPatch(project, () => { fn(project); U.touch(project, touched); }); },
    go(n) { const t = U.jump(history, future, U.mark(project), n); if (!t) return false; project = U.root(); U.touch(project, undefined, true); return true; }
  };
}

// The board: dense-board.js with 64 nets and the ten polygons of tests/editor/perf-interact.js, scaled
// to the board; two of them pour with a clearance below the rule (0.1 mm against 0.2 mm).
function board(n) {
  const {d, defs} = makeAtriumBenchmarkBoard(n);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); else if (k % 3 === 0) i.net = "N" + (k % 64); k++; }
  const w = d.outline[1][0], h = d.outline[2][1], rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, w / 2, h - 1)], ["Top", "VCC", rect(w / 2, 1, w - 1, h - 1)], ["Bottom", "GND", rect(1, 1, w - 1, h / 2)], ["Bottom", "VCC", rect(1, h / 2, w - 1, h - 1)]];
  for (let j = 0; j < 4; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(3 + j * w / 4, 3, w / 4 * (j + 1) - 2, h / 4)]);
  polys.forEach(([layer, net, o], j) => d.items.push({...PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: j % 3 === 0, ...(j === 1 || j === 4 ? {clearance: .1} : {})}), id: "poly" + j}));
  const p = A.project("Copper"); p.documents = [d]; p.library = [...defs.values()];
  return p;
}
// The editor keeps one definition index while the library is unchanged (editor.js syncDefinitionIndex).
const defsCache = new WeakMap();
const defsOf = p => { let d = defsCache.get(p.library); if (!d) defsCache.set(p.library, d = new Map(p.library.map(x => [x.id, x]))); return d; };
// A live refill: the stale pours, repoured as a derived change.
function refill(ed, doc) {
  const defs = defsOf(ed.project), stale = PP.inspectCopper(doc, defs, {project: ed.project}).stale.slice();
  if (!stale.length) return 0;
  ed.derive(() => PP.apply(doc, defs, {project: ed.project, only: stale, derived: true}));
  return stale.length;
}

function ops(docOf) {
  const kinds = (ed, k) => docOf(ed).items.filter(i => i.kind === k);
  const near = (ed, r, kind, inPour) => {
    const doc = docOf(ed), w = doc.outline[1][0], h = doc.outline[2][1], list = doc.items.filter(i => i.kind === kind);
    const at = i => i.points ? i.points[0] : [i.x, i.y];
    // inside a pour, away from its outline, or within 1 mm of an outline
    const edge = q => [q[0] - 1, w / 2 - q[0], w - 1 - q[0], q[1] - 1, h / 2 - q[1], h - 1 - q[1]].some(d => Math.abs(d) < 1);
    const sel = list.filter(i => inPour ? !edge(at(i)) : edge(at(i)));
    return pick(r, sel.length ? sel : list);
  };
  const touched = (ed, items) => ({doc: docOf(ed), items});
  return [
    ["move part (inside a pour)", (ed, r) => { const p = near(ed, r, "part", true); if (!p) return false; ed.edit(() => { p.x += (r() - .5) * 2; p.y += (r() - .5) * 2; }, touched(ed, [p])); return true; }],
    ["move part (near an outline)", (ed, r) => { const p = near(ed, r, "part", false); if (!p) return false; ed.edit(() => { p.x += (r() - .5) * 2; p.y += (r() - .5) * 2; }, touched(ed, [p])); return true; }],
    ["rotate part (no hint)", (ed, r) => { const p = pick(r, kinds(ed, "part")); if (!p) return false; ed.edit(() => { p.angle = ((p.angle || 0) + 90) % 360; }); return true; }],
    ["bend track", (ed, r) => { const t = near(ed, r, "track", r() < .7); if (!t) return false; ed.edit(() => { const k = 1 + Math.floor(r() * (t.points.length - 1)); t.points[k] = [t.points[k][0] + (r() - .5) * 2, t.points[k][1] + (r() - .5) * 2]; }, touched(ed, [t])); return true; }],
    ["track width", (ed, r) => { const t = pick(r, kinds(ed, "track")); if (!t) return false; ed.edit(() => { t.width = pick(r, [.1, .15, .22, .3, .6]); }, touched(ed, [t])); return true; }],
    ["net change", (ed, r) => { const t = pick(r, docOf(ed).items.filter(i => i.kind === "track" || i.kind === "via" || i.kind === "pad")); if (!t) return false; ed.edit(() => { t.net = pick(r, ["GND", "VCC", "N1", "N7", "N40", ""]); }, touched(ed, [t])); return true; }],
    ["add track", (ed, r) => { const o = near(ed, r, "via", r() < .7); if (!o) return false; const t = {id: fresh("t"), kind: "track", net: o.net, layer: pick(r, ["Top", "Bottom"]), width: pick(r, [.15, .22]), points: [[o.x, o.y], [o.x + 1 + r() * 2, o.y + (r() - .5) * 2]]};
      ed.edit(() => { docOf(ed).items.push(t); }, touched(ed, [t])); return true; }],
    ["add via", (ed, r) => { const o = near(ed, r, "track", true); if (!o) return false; const q = o.points.at(-1), v = {id: fresh("v"), kind: "via", net: pick(r, [o.net || "N3", "GND"]), x: q[0] + (r() - .5), y: q[1] + (r() - .5), diameter: .6, drill: .3, layer: "Multi"};
      ed.edit(() => { docOf(ed).items.push(v); }); return true; }],
    ["delete", (ed, r) => { const doc = docOf(ed), o = pick(r, doc.items.filter(i => ["track", "via", "part", "pad"].includes(i.kind))); if (!o) return false; ed.edit(() => { doc.items.splice(doc.items.indexOf(o), 1); }); return true; }],
    ["paste 4", (ed, r) => { const doc = docOf(ed), start = Math.floor(r() * doc.items.length), src = doc.items.slice(start, start + 6).filter(i => ["track", "via", "part"].includes(i.kind)).slice(0, 4); if (!src.length) return false;
      ed.edit(() => { for (const s of src) { const c = JSON.parse(JSON.stringify(s)); c.id = fresh(s.kind); if (c.points) c.points = c.points.map(q => [q[0] + .7, q[1] + 1.3]); else { c.x += .7; c.y += 1.3; } if (c.ref) c.ref += "_" + uid; doc.items.push(c); } }); return true; }],
    ["pour outline", (ed, r) => { const p = pick(r, kinds(ed, "polygon")); if (!p) return false; ed.edit(() => { const k = Math.floor(r() * p.points.length); p.points = p.points.map((q, j) => j === k ? [q[0] + (r() - .5) * 3, q[1] + (r() - .5) * 3] : q); }, touched(ed, [p])); return true; }],
    ["pour clearance", (ed, r) => { const p = pick(r, kinds(ed, "polygon")); if (!p) return false; ed.edit(() => { if (p.clearance) delete p.clearance; else p.clearance = .12; }, touched(ed, [p])); return true; }],
    ["peer edit (touched)", (ed, r) => { const t = near(ed, r, "track", true); if (!t) return false; ed.peer(() => { t.points[0] = [t.points[0][0] + .4, t.points[0][1]]; }, touched(ed, [t])); return true; }],
    ["undo", ed => ed.go(-1)], ["redo", ed => ed.go(1)], ["undo", ed => ed.go(-1)]
  ];
}

const how = new Map(), seenTypes = new Set();
function note(engine, kind, mode, ms) {
  const k = engine + " " + kind;
  let h = how.get(k); if (!h) how.set(k, h = {modes: {}, ms: []});
  h.modes[mode] = (h.modes[mode] || 0) + 1; if (mode !== "full") h.ms.push(ms);
}
function run(label, project, {seed, steps}) {
  const ed = editor(project), docOf = e => e.project.documents[0], list = ops(docOf), r = rng(seed);
  let rules = R.kit.migrate(R.defaults());
  // The engines, as the editor's clients read the journal: online DRC from its own cursor, the pour session from its own.
  let E = V.online(), S = DP.session(), at = null, doc = docOf(ed);
  refill(ed, doc);
  const versionKey = v => v ? [v.floor, v.outer, v.project, v.parameters, v.library].join("/") : null;
  let found = {drc: 0, pours: 0};
  const check = (step, kind) => {
    doc = docOf(ed);
    const defs = defsOf(ed.project), ch = U.changed(doc, at), v = U.documentVersions(doc, ed.project, true);
    let t = clock();
    const res = E.update(doc, defs, rules, {from: at, to: ch.seq, ids: at == null ? null : ch.ids, items: at == null ? null : ch.items,
      outer: [v.floor, v.outer, v.project, v.parameters, v.library].join("/"), library: v.library, pours: v.pours, project: ed.project});
    note("drc", kind, res.mode, clock() - t);
    at = ch.seq;
    const types = E.types(), want = R.drc(doc, defs, rules, {types, limit: 5000, project: ed.project}).violations.filter(x => x.type !== "short").map(key).sort();
    const have = res.violations.filter(x => x.type !== "short").map(key).sort();
    if (want.join("\n") !== have.join("\n")) {
      const w = new Set(want), h = new Set(have);
      assert.fail(label + " seed " + seed + " step " + step + " (" + kind + ", online " + res.mode + (res.why ? " " + res.why : "") + "): online DRC differs from a full check\n  missing " +
        (want.filter(x => !h.has(x)).slice(0, 2).join("\n          ") || "-") + "\n  extra   " + (have.filter(x => !w.has(x)).slice(0, 2).join("\n          ") || "-"));
    }
    const pch = U.changed(doc, S.since());
    t = clock();
    const it = S.steps(doc, defs, rules, {project: ed.project, changes: pch.ids ? pch : null, seq: pch.seq, key: versionKey(v)});
    let pr = it.next(); while (!pr.done) pr = it.next();
    note("pours", kind, pr.value.mode, clock() - t);
    const ref = DP.verify(doc, defs, rules, {project: ed.project});
    const a = pr.value.violations.map(key), b = ref.violations.map(key);
    if (a.join("\n") !== b.join("\n")) {
      const as = new Set(a), bs = new Set(b);
      assert.fail(label + " seed " + seed + " step " + step + " (" + kind + ", pours " + pr.value.mode + "): pour clearance differs from a full check\n  only incremental: " +
        (a.filter(x => !bs.has(x)).slice(0, 2).join("\n    ") || "-") + "\n  only full: " + (b.filter(x => !as.has(x)).slice(0, 2).join("\n    ") || "-") +
        (a.length === b.length && a.every(x => bs.has(x)) ? "\n  (same violations, different order)" : ""));
    }
    found = {drc: Math.max(found.drc, want.length), pours: Math.max(found.pours, b.length)};
    for (const x of res.violations) seenTypes.add(x.type);
  };
  check(0, "open");
  for (let s = 1; s <= steps; s++) {
    // Sometimes the pour session is running when the edit lands (the refill of the last edit, an idle
    // slice): it finishes on the board as it was when it started, and the next run continues from there.
    let running = null;
    if (r() < .25) {
      const d0 = docOf(ed), pch = U.changed(d0, S.since()), v0 = U.documentVersions(d0, ed.project, true);
      running = S.steps(d0, defsOf(ed.project), rules, {project: ed.project, changes: pch.ids ? pch : null, seq: pch.seq, key: versionKey(v0)});
      running.next();
    }
    let kind, guard = 0;
    do kind = pick(r, list); while (!kind[1](ed, r) && ++guard < 20);
    refill(ed, docOf(ed));
    if (running) { let x = running.next(); while (!x.done) x = running.next(); }
    check(s, kind[0] + (running ? " (during a run)" : ""));
  }
  console.log("  " + label + " seed " + seed + ": " + steps + " steps, up to " + found.drc + " DRC and " + found.pours + " pour clearance violations");
  return found;
}

const steps = quick ? 10 : 30;
const more = (from, n = +(process.env.SEEDS || 0)) => Array.from({length: n}, (_, i) => from + i);
test("netted board with pours (1,600 objects): incremental equals full after every random edit and refill", () => {
  let most = {drc: 0, pours: 0};
  for (const seed of [1, 2, 3, 4, 5, 6, ...more(100)]) { const f = run("board 40", board(40), {seed, steps}); most = {drc: Math.max(most.drc, f.drc), pours: Math.max(most.pours, f.pours)}; }
  assert.ok(most.drc > 0 && most.pours > 0, "the board has findings to compare " + JSON.stringify(most));
});
test("larger board (6,400 objects)", () => {
  for (const seed of [7, ...more(200)]) run("board 80", board(80), {seed, steps: quick ? 5 : 12});
});

console.log("how each kind of edit reached the engines (modes; median ms when not full):");
for (const [kind, h] of [...how].sort()) {
  const ms = h.ms.sort((a, b) => a - b), med = ms.length ? ms[ms.length >> 1].toFixed(1) : "-";
  console.log("  " + kind.padEnd(36) + JSON.stringify(h.modes).padEnd(40) + " median " + med + " ms");
}
console.log("online DRC types seen: " + [...seenTypes].sort().join(", "));
console.log(passed + " incremental copper tests passed");
