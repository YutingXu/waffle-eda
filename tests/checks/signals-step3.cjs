"use strict";
// Signals in the editors: the Constraint Manager's Signals and Tags rows
// (constraints scoped InSignal / HasTag), the board's context-menu signal entries, the route bar's offer to
// declare a name-matched pair (a suggestion until declared, never by routing it), and the common-mode
// choke pin-map suggestion (a series override, offered, never applied by itself).
const assert = require("node:assert/strict");
const T = {now: 0};
globalThis.performance ||= {now: () => T.now};
for (const f of ["model", "design-query-record", "parts", "net-intent", "signals", "rules", "stackup", "timing-vision", "length-tuning", "constraints", "signals-panel", "keymap", "context-menu", "route-feel"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, S = AtriumSignals, R = AtriumRules, K = AtriumConstraints, SP = AtriumSignalsPanel, CM = AtriumContextMenu, RF = AtriumRouteFeel;
const part = (ref, pinNets, x = 0) => ({id: "p-" + ref, kind: "part", ref, value: "", def: "std-r", x, y: 0, angle: 0, layer: "Top", pinNets});
function project() {
  const p = A.project("Step 3", AtriumParts.catalogue), b = p.documents.find(d => d.kind === "pcb");
  b.items = [part("U1", {1: "USB_P", 2: "USB_N", 3: "DATA_P", 4: "DATA_N", 5: "CLK"}), part("L1", {1: "USB_P", 2: "USB_N", 3: "USBC_N", 4: "USBC_P"}, 5),
    part("J1", {1: "USBC_P", 2: "USBC_N", 3: "DATA_P", 4: "DATA_N", 5: "CLK"}, 10)];
  A.validate(p);
  return {p, b};
}
const host = p => ({project: () => p, edit: fn => fn(), info: m => { host.said = m; }, act: () => {}});

// ---------------------------------------------------------------- Constraint Manager: Signals and Tags
{
  const {p, b} = project(), defs = new Map(p.library.map(d => [d.id, d]));
  S.edit(p, st => { st.signals.push({id: "s-usb", name: "USB", kind: "diff", legs: [{polarity: 1, nets: ["USB_P"]}, {polarity: -1, nets: ["USB_N"]}], tags: ["HS"]}); });
  const M = K.model(p, b, defs);
  assert.ok(K.TABS.some(([k]) => k === "signals") && K.TABS.some(([k]) => k === "tags"), "Signals and Tags tabs");
  const sig = M.rows("signals").find(r => r.name === "USB");
  assert.equal(sig.kind, "Differential"); assert.equal(sig.tags, "HS"); assert.deepEqual(sig.nets, ["USB_N", "USB_P"]);
  const tag = M.rows("tags").find(r => r.name === "HS");
  assert.deepEqual(tag.nets, ["USB_N", "USB_P"]);
  assert.equal(M.metrics("tags", tag).cells.members, 2);
  // A cell edit writes a rule scoped to the tag (HasTag) or signal (InSignal); it applies to their nets.
  const set = JSON.parse(JSON.stringify(R.effective(b, p)));
  assert.match(K.setCell(set, "tags", tag, "widthMin", .3, M), /Min width = 0.3 mm/);
  assert.match(K.setCell(set, "signals", sig, "clearance", .25, M), /0.25 mm/);
  R.store(b, p, set);
  const stored=R.stored(b,p), record=AtriumDesignQueryRecord;
  const edited=(type,source)=>stored.list.find(r=>r.type===type && record.valid(r.scope) && r.scope.source===source);
  const width=edited("width",record.selector("tag","HS").source), clearance=edited("clearance",record.selector("signal","USB").source);
  assert.equal(width?.min,.3);
  assert.ok(clearance);
  for (const net of ["USB_P","USB_N","CLK"]) {
    const applies=net!=="CLK";
    assert.equal(R.query(b,"width",{net},{project:p}).ruleId===width.id,applies,"tag width on "+net);
    assert.equal(R.query(b,"clearance",{net},{project:p}).ruleId===clearance.id,applies,"signal clearance on "+net);
  }
  assert.equal(K.model(p, b, defs).metrics("tags", K.model(p, b, defs).rows("tags").find(r => r.name === "HS")).cells.widthMin, .3);
  // MCP: the tabs list through the headless tool.
  const H = {project: () => p, mutable: () => p, board: () => b, defsOf: () => defs, page: (rows) => ({items: rows, total: rows.length}), touched() {}};
  assert.ok(K.headless({action: "list", tab: "signals"}, H).items.some(r => r.name === "USB"));
}

// ---------------------------------------------------------------- the board's context menu
{
  const {p, b} = project(), h = host(p);
  const ctx = net => ({kind: "pcb", doc: b, host: h, sel: [], item: {id: "t", kind: "track", net}, net, type: "track"});
  const signalEntries = c => CM.TYPES.track.filter(e => Array.isArray(e) && e[1] === "signals-panel" && (!e[2].kind || e[2].kind === c.kind) && (!e[2].when || e[2].when(c)));
  // DATA_P / DATA_N match by name: the pair is offered (not declared); CLK has no signal: declare one.
  let es = signalEntries(ctx("DATA_P"));
  assert.deepEqual(es.map(e => e[0]), ["Declare Differential Pair"]);
  assert.match(es[0][2].label(ctx("DATA_P")), /DATA.*DATA_P.*DATA_N/, "the label names the pair and its nets");
  assert.equal(p.signals, undefined, "offering declares nothing");
  es[0][2].run(ctx("DATA_P"));
  assert.ok(p.signals.signals.some(s => s.kind === "diff" && s.legs[0].nets[0] === "DATA_P"), "declared on the click");
  assert.deepEqual(signalEntries(ctx("DATA_N")).map(e => e[0]), ["Show Signal"]);
  es = signalEntries(ctx("CLK"));
  assert.deepEqual(es.map(e => e[0]), ["Declare Signal from Net"]);
  es[0][2].run(ctx("CLK"));
  assert.equal(S.model(p, b).signalOf("CLK").name, "CLK");
  assert.match(signalEntries(ctx("CLK"))[0][2].label(ctx("CLK")), /CLK$/);
  // Schematic menus are unchanged.
  assert.deepEqual(signalEntries({...ctx("CLK"), kind: "schematic"}), []);
}

// ---------------------------------------------------------------- the route bar's offer
{
  const {p, b} = project(), byId = new Map();
  const node = id => ({id, hidden: false, textContent: "", title: "", setAttribute() {}, after(el) { byId.set(el.id, el); }});
  byId.set("status", node("status"));
  const saved = globalThis.document;
  globalThis.document = {getElementById: id => byId.get(id) || null, createElement: () => node(""), documentElement: {getAttribute: () => null}};
  const said = [];
  globalThis.AtriumNavHost = {project: () => p, doc: () => b, edit: fn => fn(), info: m => said.push(m)};
  try {
    RF.pairOffer({pair: {name: "USB", positive: "USB_P", negative: "USB_N", source: "rules"}});
    assert.equal(byId.get("route-pair-offer"), undefined, "a declared pair needs no offer");
    const pair = {name: "DATA", positive: "DATA_P", negative: "DATA_N", source: "names"};
    RF.pairOffer({pair});
    const el = byId.get("route-pair-offer");
    assert.ok(el && !el.hidden && el.textContent === "Declare pair DATA");
    assert.equal(p.signals, undefined, "routing a name match declares nothing");
    el.onclick();
    return Promise.resolve().then(() => new Promise(r => setTimeout(r, 0))).then(() => {
      assert.ok(S.model(p, b).signalOf("DATA_P")?.name, "declared from the route bar");
      assert.ok(el.hidden, "the offer goes once declared");
      RF.pairOffer({pair});
      assert.ok(el.hidden, "and does not come back in this session");
      RF.pairOffer(null);
    }).finally(() => { globalThis.document = saved; }).then(chokes);
  } catch (e) { globalThis.document = saved; throw e; }
}

// ---------------------------------------------------------------- common-mode choke pin map
function chokes() {
  const {p, b} = project();
  S.edit(p, st => { st.signals.push({id: "s-usb", name: "USB", kind: "diff", legs: [{polarity: 1, nets: ["USB_P"]}, {polarity: -1, nets: ["USB_N"]}]}); });
  const M = S.model(p, b), g = SP.suggestions(p, b, M).find(x => x.kind === "series");
  assert.ok(g, "L1 on both legs of USB is offered a pin map");
  assert.equal(g.ref, "L1"); assert.deepEqual(g.pins, [["1", "4"], ["2", "3"]], "pin on + to the next + net, − to −");
  assert.deepEqual(M.signals.find(s => s.name === "USB").legs.map(l => l.nets), [["USB_P"], ["USB_N"]], "not applied by itself");
  assert.equal(SP.suggestionFor(p, b, "USB_P"), null, "a pin map is not a pair offer");
  SP.actions.accept(p, b, {suggestion: g});
  assert.deepEqual(p.signals.series["p-L1"], [["1", "4"], ["2", "3"]]);
  const legs = S.model(p, b).signals.find(s => s.name === "USB").legs;
  assert.deepEqual(legs.map(l => l.nets), [["USB_P", "USBC_P"], ["USB_N", "USBC_N"]], "the pair spans the choke");
  assert.equal(SP.suggestions(p, b, S.model(p, b)).filter(x => x.kind === "series").length, 0, "nothing left to offer");
  // Declined: not offered again.
  const q = project();
  S.edit(q.p, st => { st.signals.push({id: "s-usb", name: "USB", kind: "diff", legs: [{polarity: 1, nets: ["USB_P"]}, {polarity: -1, nets: ["USB_N"]}]}); });
  const g2 = SP.suggestions(q.p, q.b, S.model(q.p, q.b)).find(x => x.kind === "series");
  SP.actions.decline(q.p, q.b, {suggestion: g2});
  assert.equal(SP.suggestions(q.p, q.b, S.model(q.p, q.b)).filter(x => x.kind === "series").length, 0, "declined");
  console.log("signals-step3 ok");
}
