"use strict";
// Route Suggestions (app/route-suggest*.js, app/pcb/route-habits.js): legality on fixtures, Tab accept as
// one undo step, cycling and partial accept, habits changing suggestions within the rules, reset,
// the Tab key policy in the keymap, and the router's all-layer holes and edges.
// The evaluation against human routing is tests/pcb/route-suggest-eval.cjs (thresholds there).
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
globalThis.CFB ??= (() => { try { return require("../../app/vendor/cfb.min.js"); } catch { return undefined; } })();
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "viastack", "pcb-pours", "import-link", "connectivity", "net-ties", "rules", "router", "keymap"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
for (const f of ["sexpr", "altium-rules", "source-file", "sch-import", "pcb-import", "io"]) { try { require(require("../support/app-source-paths.cjs").appFile(f + ".js")); } catch { /* importer optional */ } }
require("../../app/pcb/route-suggest-engine.js"); require("../../app/pcb/route-habits.js"); require("../../app/pcb/route-suggest.js");
require("./autorouter-bench-boards.js");
const H = require("./autorouter.cjs");
const A = globalThis.Atrium, E = globalThis.AtriumRouteSuggestEngine, HB = globalThis.AtriumRouteHabits, RS = globalThis.AtriumRouteSuggest, R = globalThis.AtriumRouter;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check) {
  const end = Date.now() + 1000;
  while (!check() && Date.now() < end) await sleep(10);
  assert.ok(check(), "the route suggestion did not reach the expected state");
}

// A two-layer test board: through-hole pads of net SIG at both ends, Top copper of other nets between.
function board(o = {}) {
  const d = A.sheet("pcb", "Suggest test");
  d.outline = [[0, 0], [40, 0], [40, 30], [0, 30]];
  const pad = (id, x, y, net, layer = "Multi", extra = {}) => ({id, kind: "pad", x, y, w: 1.4, h: 1.4, shape: "round", drill: layer === "Multi" ? 0.7 : 0, layer, net, ...extra});
  d.items.push(pad("pa", 5, 15, "SIG", o.layer), pad("pb", 35, 15, "SIG", o.layer));
  if (o.wall) d.items.push({id: "wall", kind: "track", layer: "Top", width: 0.3, net: "GND", points: [[20, 3], [20, 27]]});
  for (const it of o.items || []) d.items.push(it);
  return {d, defs: new Map()};
}
const legal = (d, defs, alt, net) => {
  const plan = E.toPlan(alt, {net}), test = {...d, items: [...d.items, ...plan.add]}, ids = new Set(plan.add.map(i => i.id));
  return H.clearanceViolations(test, defs, ids).length + H.outsideOutline(test, ids).length === 0 && E.validate(d, defs, {...alt, net}, {net}).ok;
};

test("suggestions on the PiDP-11 fixture are legal (every alternative, independent checker)", () => {
  const dir = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const p = globalThis.AtriumBenchBoards.importFiles(["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(n => [n, new Uint8Array(fs.readFileSync(path.join(dir, n)))]), "PiDP-11");
  const d = p.documents.find(x => x.kind === "pcb"), defs = new Map(p.library.map(x => [x.id, x]));
  const M = require("./route-suggest-eval.cjs");
  const cases = M.cases({d, defs, project: p}).slice(0, 8);
  assert.ok(cases.length >= 6, "cases " + cases.length);
  let alts = 0;
  for (const c of cases) {
    const gone = new Set(c.copper.map(i => i.id)), ripped = {...d, items: d.items.filter(i => !gone.has(i.id))};
    const r = E.suggest(ripped, defs, {net: c.net, from: c.a.at, to: c.b.at, fromLayer: "Top", budgetMs: 600}, {project: p});
    assert.ok(r.ok, c.net + ": " + r.reason);
    for (const a of r.alternatives) { if (a.modify.length) continue; assert.ok(legal(ripped, defs, a, c.net), c.net + " " + a.kind + " is not legal"); alts++; }
    assert.ok(r.alternatives.every(a => a.reasons.length), "every suggestion explains itself");
  }
  assert.ok(alts >= cases.length + 4, "alternatives " + alts);
});

test("walls: the ghost changes layer around Top copper and the alternatives differ", () => {
  const {d, defs} = board({wall: true});
  const r = E.suggest(d, defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Top"});
  assert.ok(r.ok);
  for (const a of r.alternatives) if (!a.modify.length) assert.ok(legal(d, defs, a, "SIG"), a.kind);
  assert.ok(r.alternatives.some(a => a.layers.includes("Bottom")));
  const kinds = new Set(r.alternatives.map(a => a.kind)); assert.ok(kinds.size === r.alternatives.length, "no duplicates");
});

test("router: unplated holes and board edges block Bottom too", () => {
  const {d, defs} = board({layer: "Bottom", items: [{id: "h", kind: "pad", x: 20, y: 15, w: 1, h: 1, drill: 1, plated: false, layer: "Multi"}]});
  const W = R.world(d, defs), rules = R.core.rulesFor(d);
  assert.equal(R.check(W, rules, {layer: "Bottom", width: 0.25, net: "SIG", points: [[5, 15], [35, 15]]}).ok, false, "a Bottom track through an unplated hole");
  assert.equal(R.check(W, rules, {layer: "Bottom", width: 0.25, net: "SIG", points: [[5, 0.05], [35, 0.05]]}).ok, false, "a Bottom track on the board edge");
  const r = E.suggest(d, defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Bottom", layers: ["Bottom"]});
  assert.ok(r.ok && legal(d, defs, r.alternatives[0], "SIG"));
  assert.ok(r.alternatives[0].length > 30.05, "goes around the hole");
});

test("habits bias the layer and width, inside the rules only", () => {
  const {d, defs} = board();
  const base = E.suggest(d, defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Top", alternatives: false}).alternatives[0];
  const p = HB.empty();
  for (let i = 0; i < 6; i++) HB.observeInto(p, d, null, {add: [{kind: "track", layer: "Bottom", width: 0.3, net: "N" + i, points: [[0, i], [20, i]]}]});
  const rules = R.core.rulesFor(d), w = rules.width("SIG", "Bottom", [5, 15]);
  const bias = HB.bias(p, "Default", ["Top", "Bottom"]);
  assert.equal(bias.layers.Bottom, 1); assert.equal(bias.dirs.Bottom, "h");
  const learned = E.suggest(d, defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Top", alternatives: false, bias}).alternatives[0];
  assert.ok(base.layers.includes("Top") && !base.layers.includes("Bottom"), "default stays on the start layer: " + base.layers);
  assert.deepEqual(learned.layers, ["Bottom"], "learned: Bottom");
  assert.ok(legal(d, defs, learned, "SIG"));
  assert.ok(learned.reasons.some(t => /Prefers Bottom .*learned from 6 routes/.test(t)), learned.reasons.join(" | "));
  // A width inside the Width rule is used; one outside is ignored (rules win).
  if (0.3 >= w.min && 0.3 <= w.max) assert.equal(learned.legs[0].width, 0.3);
  const wide = E.suggest(d, defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Top", alternatives: false, bias: {...bias, width: w.max + 5}}).alternatives[0];
  assert.equal(wide.legs[0].width, w.preferred);
  // Habits never make it illegal: with the wall, the learned route still passes.
  const walled = board({wall: true});
  const a = E.suggest(walled.d, walled.defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Top", bias: {...bias, layers: {Top: 1, Bottom: 0}}}).alternatives;
  for (const x of a) if (!x.modify.length) assert.ok(legal(walled.d, walled.defs, x, "SIG"));
});

test("learning requires an opt-in and reset restores the defaults", () => {
  const {d, defs} = board(), store = new Map();
  globalThis.localStorage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
  try {
    assert.equal(HB.enabled(), false);
    assert.equal(HB.observe({add:[{kind:"track",net:"SIG",points:[[0,0],[1,0]]}]}, d, defs), false);
    globalThis.AtriumPref = {get: k => k === "routing.habits" ? true : undefined};
    for (let i = 0; i < 5; i++) HB.observe({add: [{kind: "track", layer: "Bottom", width: 0.25, net: "N" + i, points: [[0, i], [20, i]]}]}, d, defs, {project: {name: "T"}});
    const p = HB.load({name: "T"});
    assert.equal(p.routes, 5);
    assert.ok(HB.describe(p).join("\n").includes("Bottom 100%"));
    assert.ok(Object.keys(HB.bias(p, "Default", ["Top", "Bottom"])).length > 1);
    HB.reset({name: "T"});
    const q = HB.load({name: "T"});
    assert.equal(q.routes, 0); assert.deepEqual(HB.bias(q, "Default", ["Top", "Bottom"]), {});
    // Corrupt or foreign profiles load as empty; export/import round-trips.
    assert.equal(HB.clean({format: "x", routes: 9}).routes, 0);
    assert.deepEqual(HB.importText(HB.exportText(p)), HB.clean(p));
  } finally { delete globalThis.localStorage; delete globalThis.AtriumPref; }
});

// A minimal editor host: one undo step per edit(), airwires from the test board.
const CANVAS = {canvas: true};
function fakeHost(d, defs, wires) {
  const history = [], infos = [], listeners = new Map();
  const emit = event => listeners.get(event)?.forEach(fn => fn());
  const host = {canvas: () => CANVAS, setTool() {}, doc: () => d, defs: () => defs, project: () => ({name: "Fake", documents: [d], library: []}), tool: () => "route", revision: () => history.length,
    view: () => ({scale: () => 20}), connections: () => ({airwires: wires()}), activeLayer: () => "Top", len: mm => mm.toFixed(2) + " mm",
    edit(fn) { history.push(JSON.stringify(d.items)); fn(); emit("change"); }, undo() { d.items = JSON.parse(history.pop()); emit("change"); },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    info: t => infos.push(t), redrawOverlay() {}, history, infos};
  return host;
}
const wiresOf = d => () => {
  const pads = d.items.filter(i => i.kind === "pad" && i.net === "SIG");
  const routed = d.items.some(i => i.kind === "track" && i.net === "SIG" && i.points.some(p => Math.hypot(p[0] - 35, p[1] - 15) < 1e-6));
  return routed ? [] : [{net: "SIG", from: [pads[0].x, pads[0].y], to: [pads[1].x, pads[1].y], fromLabel: "pa", toLabel: "pb"}];
};

test("a moved obstacle invalidates the preview with the same net and endpoints", async () => {
  const {d, defs} = board();
  const wall = {id: "wall", kind: "track", layer: "Top", width: 0.5, net: "GND", points: [[20, 0], [20, 8]], locked: true};
  d.items.push(wall);
  const h = fakeHost(d, defs, wiresOf(d));
  globalThis.AtriumNavHost = h;
  try {
    RS.install();
    RS.probe([12, 15]);
    await until(() => RS.visible());
    const old = RS.current(), key = RS._state.key;
    h.edit(() => { wall.points = [[20, 0], [20, 30]]; });
    assert.equal(RS.visible(), false, "an obsolete preview is removed before the new search");
    assert.equal(RS.accept(), false, "an obsolete preview cannot be committed");
    assert.equal(E.validate(d, defs, {...old, net: "SIG"}, {net: "SIG"}).ok, false, "the moved obstacle blocks the old route");
    await until(() => RS.visible());
    const revised = RS.current();
    assert.equal(RS._state.key, key, "the edited board has the same connection endpoints");
    assert.ok(legal(d, defs, revised, "SIG"));
    const built = RS._build(RS._state.query);
    const full = E.suggest(d, defs, {...built.query, budgetMs: 400});
    assert.ok(full.ok);
    assert.deepEqual(revised.legs, full.alternatives[0].legs, "the new preview matches a fresh search on the full board");
  } finally {
    RS.probe(null); RS._state.installed = false; delete globalThis.AtriumNavHost;
  }
});

test("workers require routing intent and cancel when it is lost", async () => {
  const {d, defs} = board();
  const h = fakeHost(d, defs, wiresOf(d)), workers = [];
  let efficient = false;
  const priorWorker = globalThis.Worker;
  globalThis.AtriumNavHost = h;
  globalThis.AtriumPower = {visible: () => true, efficient: () => efficient};
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) {
      if (message.type === "ping") this.onmessage({data: {type: "ready"}});
      else this.suggestion = message;
    }
    terminate() { this.stopped = true; }
  };
  try {
    RS.install();
    await sleep(25);
    assert.equal(workers.length, 0, "loading the module starts no worker");
    efficient = true;
    RS.probe([12, 15]);
    await sleep(25);
    assert.equal(workers.length, 0, "Efficiency skips an unstarted hover prediction");
    efficient = false;
    RS.probe([12, 15]);
    await until(() => workers[0]?.suggestion);
    RS.probe(null);
    assert.ok(workers[0].stopped, "leaving the wire cancels the active search");
    const msg = workers[0].suggestion, late = E.suggest(msg.board, defs, msg.query, msg.options);
    workers[0].onmessage({data: {type: "result", id: msg.id, result: late}});
    assert.equal(RS.visible(), false, "a result from the cancelled worker cannot paint");
    efficient = true;
    h.routeSessionNow = () => ({anchor: () => ({point: [5, 15], layer: "Top", anchors: 0, width: 0.3}), state: {net: "SIG"}});
    RS.probe(null);
    await sleep(30);
    assert.equal(workers.length,1,"an active route starts no speculative worker in Efficiency");
    efficient=false; RS.probe(null);
    await until(() => workers[1]?.suggestion);
    assert.equal(workers[1].suggestion.query.net,"SIG","a live route recomputes when normal power resumes");
  } finally {
    h.routeSessionNow = null; RS.probe(null); RS.stopWorker(); RS._state.installed = false;
    delete globalThis.AtriumNavHost; delete globalThis.AtriumPower;
    if (priorWorker) globalThis.Worker = priorWorker; else delete globalThis.Worker;
  }
});

test("Tab accepts the whole suggestion as one undo step; Shift+Tab cycles; Escape dismisses", async () => {
  const {d, defs} = board({wall: true});
  const host = fakeHost(d, defs, wiresOf(d)); globalThis.AtriumNavHost = host;
  try {
    RS.probe([12, 15]);                                 // hover the connection line
    await until(() => RS.visible());
    assert.ok(RS.visible(), "ghost shown");
    // Keys: Tab accepts while the ghost shows (it runs before Altium's Tab = routing properties).
    const K = globalThis.AtriumKeymap, st = {kind: "pcb", tool: "route", canvas: true, canProperties: true, interactive: true};
    assert.equal(K.resolve("Tab", st), "route-suggest-accept");
    assert.equal(K.resolve("Shift+Tab", st), "route-suggest-next");
    assert.equal(K.resolve("Escape", st), "route-suggest-dismiss");
    assert.equal(K.resolve("Ctrl+Right", st), "route-suggest-word");
    assert.equal(K.resolve("Tab", {...st, canvas: false}), null, "only on the canvas");
    try {
      K.setBindings("route-suggest-dismiss", ["Alt+K D"]);
      assert.equal(K.resolve("Alt+K D", st), "route-suggest-dismiss");
      assert.equal(K.resolve("Escape", st), "escape", "rebound Escape keeps its ordinary action");
      K.setBindings("toggle-units", ["Tab"]);
      assert.equal(K.resolve("Tab", st), "toggle-units", "user binding takes priority over a suggested route");
    } finally { K.resetCommand("route-suggest-dismiss"); K.resetCommand("toggle-units"); }
    // Preferences › Route Suggestions › Tab key: Always routing properties.
    globalThis.AtriumPrefs = {get: k => k === "routing.suggestTab" ? "altium" : undefined};
    assert.equal(K.resolve("Tab", st), "tool-properties");
    assert.equal(K.resolve("Alt+Enter", st), "route-suggest-accept");
    delete globalThis.AtriumPrefs;
    const n = RS._state.result.alternatives.length;
    assert.ok(n >= 2, "alternatives " + n);
    const first = RS.current();
    assert.ok(RS.tipRows()[0].text.includes("1/" + n));
    RS.cycle(1); assert.notEqual(RS.current(), first); assert.ok(RS.tipRows()[0].text.includes("2/" + n));
    RS.cycle(-1); assert.equal(RS.current(), first);
    const before = d.items.length;
    assert.ok(RS.accept("all"));
    assert.equal(host.history.length, 1, "one undo step");
    const added = d.items.slice(before);
    assert.ok(added.length >= 2 && added.every(i => i.net === "SIG"));
    assert.ok(legal({...d, items: d.items.slice(0, before)}, defs, first, "SIG"));
    host.undo(); assert.equal(d.items.length, before, "undo removes the whole suggestion");
    // Escape dismisses; the same connection stays dismissed until the pointer finds another.
    RS.probe([12, 15]); await until(() => RS.visible()); assert.ok(RS.visible());
    RS.dismiss(); assert.ok(!RS.visible());
    assert.equal(K.resolve("Tab", st), "tool-properties", "Tab is Altium's again without a ghost");
    RS.probe([12, 15]); await sleep(40); assert.ok(!RS.visible(), "stays dismissed");
  } finally { delete globalThis.AtriumNavHost; RS._state.dismissed = ""; }
});

test("partial accept takes the suggestion to the next bend or via, then Tab takes the rest", async () => {
  const {d, defs} = board({wall: true});
  const host = fakeHost(d, defs, wiresOf(d)); globalThis.AtriumNavHost = host;
  try {
    RS.probe([12, 15.2]); await until(() => RS.visible());
    assert.ok(RS.visible());
    const alt = RS.current(), steps = E.steps(alt), total = alt.length, before = d.items.length;
    assert.ok(steps.length >= 2, "steps " + steps.length);
    RS.accept("word");
    assert.equal(host.history.length, 1);
    assert.ok(RS.visible(), "the rest stays as a ghost");
    const part1 = d.items.slice(before).filter(i => i.kind === "track").reduce((s, t) => s + E.pathLength(t.points), 0);
    assert.ok(part1 > 0 && part1 < total - 1e-6, "part " + part1 + " of " + total);
    let guard = 0;
    while (RS.visible() && guard++ < 20) RS.accept(guard % 2 ? "word" : "all");
    const all = d.items.slice(before).filter(i => i.kind === "track").reduce((s, t) => s + E.pathLength(t.points), 0);
    assert.ok(Math.abs(all - total) < 1e-3, "all of it: " + all + " vs " + total);
    assert.equal(d.items.slice(before).filter(i => i.kind === "via").length, alt.viaCount);
  } finally { delete globalThis.AtriumNavHost; }
});

test("length targets: a short connection is tuned into the band; over the band is refused", () => {
  const {d, defs} = board();
  const r = E.suggest(d, defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Top", layers: ["Top"], length: {min: 36, max: 37, offset: 0}});
  assert.ok(r.ok, r.reason);
  const a = r.alternatives[0];
  assert.ok(a.tuned && a.length >= 36 - 1e-6 && a.length <= 37 + 1e-6, "tuned to " + a.length);
  assert.ok(legal(d, defs, a, "SIG"));
  const over = E.suggest(d, defs, {net: "SIG", from: [5, 15], to: [35, 15], fromLayer: "Top", layers: ["Top"], length: {min: 10, max: 20, offset: 0}});
  assert.equal(over.ok, false); assert.match(over.reason, /over the length target/);
});

test("differential pairs: a coupled single-layer ghost with both tracks legal", () => {
  const d = A.sheet("pcb", "Pair"); d.outline = [[0, 0], [40, 0], [40, 30], [0, 30]];
  const pad = (id, x, y, net) => ({id, kind: "pad", x, y, w: 0.5, h: 0.5, shape: "rect", layer: "Top", net});
  d.items.push(pad("p1", 5, 14.6, "D_P"), pad("n1", 5, 15.4, "D_N"), pad("p2", 35, 14.6, "D_P"), pad("n2", 35, 15.4, "D_N"));
  const r = E.suggest(d, new Map(), {net: "D_P", from: [5, 14.6], to: [35, 14.6], fromLayer: "Top", pair: {partner: "D_N", from2: [5, 15.4], to2: [35, 15.4], gap: 0.3, width: 0.2}});
  assert.ok(r.ok, r.reason);
  const a = r.alternatives[0];
  assert.equal(a.kind, "pair"); assert.equal(a.legs.length, 2); assert.equal(a.legs[1].net, "D_N");
  const plan = E.toPlan(a, {net: "D_P"}), ids = new Set(plan.add.map(i => i.id)), test2 = {...d, items: [...d.items, ...plan.add]};
  assert.equal(H.clearanceViolations(test2, new Map(), ids).filter(v => !(new Set([v.a, v.b]).has("D_P") && new Set([v.a, v.b]).has("D_N"))).length, 0);
});

test("every key preset binds the suggestion keys (table presets too) with no new conflicts", () => {
  require("../../app/editor/keymap-presets.js");
  const K = globalThis.AtriumKeymap, before = K.preset();
  try {
    for (const p of K.presets()) {
      K.setPreset(p.id);
      const keys = id => (K.table().byCommand.get(id) || []).map(r => r.key);
      assert.ok(keys("route-suggest-accept").includes("Tab"), p.id + ": Tab accepts");
      assert.ok(keys("route-suggest-next").includes("Shift+Tab"), p.id + ": Shift+Tab cycles");
      assert.ok(keys("route-suggest-dismiss").includes("Escape"), p.id + ": Escape dismisses");
      const mine = K.conflicts().filter(c => /route suggestion/i.test(c.message));
      assert.deepEqual(mine.map(c => c.message), [], p.id);
    }
  } finally { K.setPreset(before); }
});

test("habits learn from hand-routed plans: layers, directions, corners, vias, pad exits", () => {
  const {d} = board(), p = HB.empty();
  HB.observeInto(p, d, null, {add: [{kind: "track", layer: "Top", width: 0.2, net: "A", points: [[0, 0], [10, 0], [12, 2], [20, 2]]}, {kind: "via", x: 20, y: 2, net: "A"}]});
  assert.equal(p.routes, 1); assert.equal(p.corners["45"], 2); assert.equal(p.classes.Default.vias, 1);
  assert.ok(p.dirs.Top.h > 17 && p.dirs.Top.d > 2);
  const lines = HB.describe(p).join("\n");
  assert.match(lines, /Learned from 1 route/); assert.match(lines, /Top 100%/);
});

globalThis.__testDone = (async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); }
    catch (e) { console.log("FAIL " + name); throw e; }
  }
})();
