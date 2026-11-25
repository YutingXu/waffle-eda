"use strict";
// Auto placement proposals (app/pcb/autoplace.js). Run with Node 18+ (node tests/pcb/autoplace.cjs)
// or JavaScriptCore (scripts/test-jsc.sh autoplace).
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/checks/connectivity.js");
require("../../app/checks/rules.js");
require("../../app/checks/dfa.js");
require("../../app/pcb/rooms.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/pcb/autorouter.js");
require("../../app/pcb/fanout.js");
require("../../app/pcb/autoplace.js");
require("../../app/pcb/route-planner.js");
require("../../app/pcb/plane-planner.js");
require("../../app/automation/proposal.js");
require("../../app/core/atrium-api.js");
const A = globalThis.Atrium, P = globalThis.AtriumAutoplace, D = globalThis.AtriumDFA;
const {checkThroughput} = require("../analysis/timing-check.js");

// ------------------------------------------------------------------ fixtures
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296); }
const pad = (number, x, y, w, h, drill = 0) => ({number: String(number), x, y, w, h, drill, shape: drill ? "round" : "rect", angle: 0});
const body = (w, h) => ({kind: "path", points: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], style: "package", closed: true, fill: true});
function library() {
  const soic = n => {
    const per = n / 2, pads = [], off = (per - 1) / 2 * 1.27;
    for (let i = 0; i < per; i++) pads.push(pad(i + 1, -2.7, -off + i * 1.27, 1.55, 0.6));
    for (let i = 0; i < per; i++) pads.push(pad(per + i + 1, 2.7, off - i * 1.27, 1.55, 0.6));
    return {id: "soic" + n, name: "SOIC-" + n, prefix: "U", value: "IC", footprint: {name: "SOIC-" + n, shapes: [body(3.9, per * 1.27 + 0.6)], pads}};
  };
  const header = n => {
    const pads = [];
    for (let i = 0; i < n; i++) pads.push(pad(i + 1, 0, (i - (n - 1) / 2) * 2.54, 1.7, 1.7, 1));
    return {id: "hdr" + n, name: "Header-" + n, prefix: "J", value: "Header", category: "Connectors", footprint: {name: "Header-" + n, shapes: [], pads}};
  };
  const chip = (id, prefix) => ({id, name: prefix + "0603", prefix, value: "x", footprint: {name: "0603", shapes: [body(1.6, 0.8)], pads: [pad(1, -0.8, 0, 0.9, 0.95), pad(2, 0.8, 0, 0.9, 0.95)]}});
  return [soic(8), soic(14), header(4), header(6), chip("r0603", "R"), chip("c0603", "C")];
}
// A board with `ics` ICs, each with two decoupling capacitors and a few resistors on local nets,
// and `headers` connectors. Every footprint starts beside the board (as ECO leaves them).
function design({ics = 4, perIc = 4, headers = 2, width = 60, height = 40, seed = 3} = {}) {
  const r = rng(seed), lib = library(), defs = new Map(lib.map(d => [d.id, d]));
  const doc = A.sheet("pcb", "Placement board");
  doc.outline = [[0, 0], [width, 0], [width, height], [0, height]];
  const items = [];
  let x = width + 10, y = 0, n = 0;
  const part = (def, ref, pinNets) => { const p = {id: "p" + (++n), kind: "part", def, ref, value: "", x, y: y += 8, angle: 0, pinNets}; if (y > 400) { y = 0; x += 15; } items.push(p); return p; };
  const sig = [];
  for (let i = 1; i <= ics; i++) {
    const big = i % 2 ? "soic14" : "soic8", pins = big === "soic14" ? 14 : 8, nets = {};
    for (let k = 1; k <= pins; k++) nets[k] = "U" + i + "_" + k;
    nets[pins / 2] = "GND"; nets[pins] = "VCC";
    part(big, "U" + i, nets);
    part("c0603", "C" + (2 * i - 1), {1: "VCC", 2: "GND"});
    part("c0603", "C" + (2 * i), {1: "VCC", 2: "GND"});
    for (let k = 0; k < perIc; k++) {
      const a = "U" + i + "_" + (1 + k), b = k % 2 && i > 1 ? "U" + (i - 1) + "_" + (2 + k) : "U" + i + "_" + (pins / 2 + 1 + k);
      part("r0603", "R" + (i * 10 + k), {1: a, 2: b});
    }
    sig.push("U" + i + "_" + (pins - 1));
  }
  for (let h = 1; h <= headers; h++) {
    const nets = {1: "VCC", 2: "GND"};
    for (let k = 3; k <= 6; k++) nets[k] = sig[Math.floor(r() * sig.length)];
    part("hdr6", "J" + h, nets);
  }
  doc.items = items;
  return {doc, defs, project: {format: "atrium", version: 1, name: "Test", library: lib, documents: [doc]}};
}

function check(doc, defs, alt, M = null) {
  const moved = new Map(alt.moves.map(m => [m.id, m]));
  const copy = {...doc, items: doc.items.map(i => (moved.has(i.id) ? {...i, x: moved.get(i.id).to[0], y: moved.get(i.id).to[1], angle: moved.get(i.id).angle} : i))};
  const rule = D.defaultRule();
  const v = D.check(copy, defs, rule).violations;
  const b = A.bounds(doc.outline);
  for (const i of copy.items) {
    if (i.kind !== "part" || !moved.has(i.id)) continue;
    const c = P._internal.rotBox(P._internal.localBoxes(defs.get(i.def), "courtyard").court, i.angle);
    assert.ok(c[0] + i.x >= b[0] && c[2] + i.x <= b[2] && c[1] + i.y >= b[1] && c[3] + i.y <= b[3], i.ref + " is inside the board");
  }
  return {violations: v, copy};
}

const tests = [];
const test = (name, fn) => tests.push({name, fn});

test("places every unplaced footprint inside the board, DFA clean, and scores alternatives", () => {
  const {doc, defs, project} = design();
  const r = P.propose(project, doc, defs, {seed: 1});
  assert.equal(r.scope, "unplaced");
  assert.equal(r.alternatives.length, 3);
  for (let i = 1; i < r.alternatives.length; i++) assert.ok(r.alternatives[i - 1].score.total <= r.alternatives[i].score.total, "alternatives are sorted best first");
  const best = r.alternatives[0];
  assert.equal(best.moves.length, doc.items.length);
  assert.equal(best.stats.unplaced.length, 0);
  assert.equal(best.score.overlaps, 0);
  assert.equal(best.score.outside, 0);
  assert.equal(best.score.dfa_violations, 0);
  const {violations} = check(doc, defs, best);
  assert.deepEqual(violations, []);
  for (const k of ["wirelength_mm", "dfa_violations", "density", "peak_density", "total"]) assert.ok(Number.isFinite(best.score[k]), k);
  // nothing in the document changed
  assert.ok(doc.items.every(i => i.x > 60));
});

test("deterministic for a seed; a different seed may differ", () => {
  const a = design(), b = design();
  const r1 = P.propose(a.project, a.doc, a.defs, {seed: 7, alternatives: 1}), r2 = P.propose(b.project, b.doc, b.defs, {seed: 7, alternatives: 1});
  assert.deepEqual(r1.alternatives[0].moves, r2.alternatives[0].moves);
  assert.deepEqual(r1.alternatives[0].score, r2.alternatives[0].score);
});

test("beats a packed grid on airwire length", () => {
  const {doc, defs, project} = design({ics: 6});
  const r = P.propose(project, doc, defs, {seed: 1});
  // Reference: the same footprints in a row-major grid on the board (designator order).
  const grid = {...doc, items: doc.items.map(i => ({...i}))};
  let x = 3, y = 3, row = 0;
  for (const i of grid.items) { i.x = x; i.y = y; x += 7; row = Math.max(row, 7); if (x > 55) { x = 3; y += 9; } }
  const M = P._internal.prepare(project, grid, defs, {scope: "all"});
  const gridScore = P._internal.scoreOf(M);
  assert.ok(r.alternatives[0].score.wirelength_mm < gridScore.wirelength_mm, r.alternatives[0].score.wirelength_mm + " < " + gridScore.wirelength_mm);
});

test("decoupling capacitors sit next to their IC's power pin, connectors on an edge", () => {
  const {doc, defs, project} = design({ics: 3});
  const best = P.propose(project, doc, defs, {seed: 2}).alternatives[0];
  const at = new Map(best.moves.map(m => [m.ref, m]));
  const pin = (ref, num) => { const m = at.get(ref), item = doc.items.find(i => i.ref === ref); return A.pins({...item, x: m.to[0], y: m.to[1], angle: m.angle}, defs.get(item.def), "pcb").find(p => p.number === String(num)).at; };
  // Capacitors are shared out between the ICs on the same supply; each sits by a VCC pin.
  const vcc = [1, 2, 3].map(i => pin("U" + i, i % 2 ? 14 : 8));
  const dist = [1, 2, 3, 4, 5, 6].map(k => { const c = pin("C" + k, 1); return Math.min(...vcc.map(v => Math.hypot(c[0] - v[0], c[1] - v[1]))); });
  assert.ok(Math.max(...dist) < 7, "every capacitor is within 7 mm of a VCC pin: " + dist.map(d => d.toFixed(1)));
  assert.ok(dist.reduce((s, d) => s + d, 0) / dist.length < 5, "on average within 5 mm: " + dist.map(d => d.toFixed(1)));
  const counts = vcc.map(v => [1, 2, 3, 4, 5, 6].filter(k => { const c = pin("C" + k, 1); return Math.hypot(c[0] - v[0], c[1] - v[1]) < 7; }).length);
  assert.ok(counts.every(n => n >= 1), "every IC has a decoupling capacitor: " + counts);
  for (const j of ["J1", "J2"]) {
    const m = at.get(j), item = doc.items.find(i => i.ref === j);
    const c = P._internal.rotBox(P._internal.localBoxes(defs.get(item.def), "courtyard").court, m.angle);
    const gaps = [c[0] + m.to[0], 60 - (c[2] + m.to[0]), c[1] + m.to[1], 40 - (c[3] + m.to[1])];
    assert.ok(Math.min(...gaps) < 1.0, j + " sits on an edge (" + gaps.map(g => g.toFixed(2)) + ")");
  }
});

test("aligns the connected resistor pad beside a locked IC without changing the board", () => {
  const {doc, defs, project} = design({ics: 1, perIc: 0, headers: 0});
  const ic = doc.items[0];
  Object.assign(ic, {x: 20, y: 20, locked: true, pinNets: {4: "SIG"}});
  doc.items = [ic, {id: "r", kind: "part", def: "r0603", ref: "R1", x: 65, y: 15, angle: 0, pinNets: {1: "SIG"}}];
  const before = JSON.stringify(doc.items);
  const best = P.propose(project, doc, defs, {scope: "unplaced", seed: 1, alternatives: 1}).alternatives[0];
  assert.deepEqual(best.moves.map(m => m.id), ["r"]);
  assert.equal(best.score.wirelength_mm, 2.75, "previous grid choice left 3.75 mm between pins");
  assert.equal(best.score.dfa_violations, 0);
  assert.deepEqual(check(doc, defs, best).violations, []);
  assert.throws(() => P.propose(project, doc, defs, {components: ["R1"], constraints: {place: {U1: {x: 22, y: 20}}}}), /Unlock U1/);
  assert.equal(JSON.stringify(doc.items), before);
});

test("edge hints from parameters and constraints", () => {
  const {doc, defs, project} = design({ics: 2});
  doc.items.find(i => i.ref === "J1").parameters = {"Placement Edge": "left"};
  const best = P.propose(project, doc, defs, {seed: 1, constraints: {edges: {J2: "bottom"}}}).alternatives[0];
  const at = new Map(best.moves.map(m => [m.ref, m]));
  const box = ref => { const m = at.get(ref), item = doc.items.find(i => i.ref === ref), c = P._internal.rotBox(P._internal.localBoxes(defs.get(item.def), "courtyard").court, m.angle); return [c[0] + m.to[0], c[1] + m.to[1], c[2] + m.to[0], c[3] + m.to[1]]; };
  assert.ok(box("J1")[0] < 1, "J1 on the left edge");
  assert.ok(40 - box("J2")[3] < 1, "J2 on the bottom edge");
  const j1 = box("J1");
  assert.ok(j1[3] - j1[1] > j1[2] - j1[0], "J1 runs along the edge");
});

test("incremental: locked and already placed footprints stay; selected scope", () => {
  const {doc, defs, project} = design({ics: 2});
  const u1 = doc.items.find(i => i.ref === "U1"), r10 = doc.items.find(i => i.ref === "R10");
  Object.assign(u1, {x: 20, y: 20});
  r10.locked = true;
  const r = P.propose(project, doc, defs, {seed: 1});
  const ids = new Set(r.alternatives[0].moves.map(m => m.id));
  assert.ok(!ids.has(u1.id), "U1 is already on the board");
  assert.ok(!ids.has(r10.id), "R10 is locked");
  assert.equal(r.locked, 1);
  // Others keep clear of the fixed U1.
  const {violations} = check(doc, defs, r.alternatives[0]);
  assert.deepEqual(violations.filter(v => v.id !== r10.id && v.otherId !== r10.id), []);
  const sel = P.propose(project, doc, defs, {components: ["U1"], seed: 1, alternatives: 1});
  assert.equal(sel.scope, "selected");
  assert.deepEqual(sel.alternatives[0].moves.map(m => m.ref).filter(x => x !== "U1"), []);
});

test("forced positions, keep-outs and a region are respected", () => {
  const {doc, defs, project} = design({ics: 2});
  doc.items.push({id: "ko", kind: "graphic", layer: "Keepout", points: [[0, 0], [30, 0], [30, 40], [0, 40]], closed: true, fill: true, width: 0});
  const best = P.propose(project, doc, defs, {seed: 1, constraints: {place: {U1: {x: 45, y: 20, angle: 90}}}}).alternatives[0];
  const u1 = best.moves.find(m => m.ref === "U1");
  assert.deepEqual([u1.to, u1.angle], [[45, 20], 90]);
  for (const m of best.moves) {
    const item = doc.items.find(i => i.id === m.id), c = P._internal.rotBox(P._internal.localBoxes(defs.get(item.def), "courtyard").court, m.angle);
    assert.ok(c[0] + m.to[0] >= 30 - 1e-6, m.ref + " is clear of the keep-out");
  }
  const reg = P.propose(project, doc, defs, {seed: 1, alternatives: 1, constraints: {region: [30, 0, 60, 40]}}).alternatives[0];
  assert.ok(reg.moves.every(m => m.to[0] > 30));
});

test("rooms keep their channel's footprints together", () => {
  const {doc, defs, project} = design({ics: 2, perIc: 2, headers: 0});
  doc.rooms = [{id: "ra", name: "A", points: [[0, 0], [30, 0], [30, 40], [0, 40]], members: doc.items.filter(i => /^(U1|C1|C2|R1\d)$/.test(i.ref)).map(i => i.id)},
    {id: "rb", name: "B", points: [[30, 0], [60, 0], [60, 40], [30, 40]], members: doc.items.filter(i => /^(U2|C3|C4|R2\d)$/.test(i.ref)).map(i => i.id)}];
  const best = P.propose(project, doc, defs, {seed: 1}).alternatives[0];
  for (const m of best.moves) {
    const room = doc.rooms.find(r => r.members.includes(m.id));
    const item = doc.items.find(i => i.id === m.id), c = P._internal.rotBox(P._internal.localBoxes(defs.get(item.def), "courtyard").court, m.angle);
    const b = A.bounds(room.points);
    assert.ok(c[0] + m.to[0] >= b[0] - 1e-6 && c[2] + m.to[0] <= b[2] + 1e-6, m.ref + " stays in room " + room.name);
  }
});

test("bottom-side parts may sit under top-side SMD parts; through-hole blocks both sides", () => {
  const {doc, defs, project} = design({ics: 1, perIc: 0, headers: 1});
  doc.items.find(i => i.ref === "C1").layer = "Bottom";
  const u1 = doc.items.find(i => i.ref === "U1"), c = P._internal.localBoxes(defs.get(u1.def), "courtyard").court;
  // The region is exactly U1's courtyard: only the bottom-side C1 fits (under U1).
  const region = [30 + c[0], 20 + c[1], 30 + c[2], 20 + c[3]];
  const best = P.propose(project, doc, defs, {seed: 1, alternatives: 1, constraints: {region, place: {U1: {x: 30, y: 20, angle: 0}}, rotate: false}}).alternatives[0];
  const unplaced = best.stats.unplaced.map(u => doc.items.find(i => i.id === u.id).ref).sort();
  assert.deepEqual(unplaced, ["C2", "J1"], "the top-side cap and the through-hole header cannot share U1's area");
  assert.ok(best.moves.some(m => m.ref === "C1"));
  assert.equal(best.score.overlaps, 0);
});

test("applyMoves and the stale guard", () => {
  const {doc, defs, project} = design({ics: 1});
  const best = P.propose(project, doc, defs, {seed: 1, alternatives: 1}).alternatives[0];
  assert.deepEqual(P.stale(doc, best.moves), []);
  const n = P.applyMoves(doc, defs, best.moves.slice(0, 2));
  assert.equal(n, 2);
  assert.equal(P.stale(doc, best.moves).length, 2, "applied moves no longer match their from positions");
});

test("headless op: plan leaves the project, proposal edits the working copy; untrusted text", () => {
  const {project} = design({ics: 2});
  let work = null, touched = 0;
  const h = {project: () => work || project, mutable: () => (work ||= JSON.parse(JSON.stringify(project))), board: (p, id) => p.documents.find(d => d.kind === "pcb" && (!id || d.id === id)),
    defsOf: p => new Map(p.library.map(d => [d.id, d])), touched: () => touched++};
  const plan = P.headless({mode: "plan", seed: 1}, h);
  assert.equal(work, null);
  assert.equal(plan.mode, "plan");
  assert.ok(plan.moved > 0 && plan.moves.every(m => !("ref" in m)));
  assert.ok(Object.values(plan.untrusted_design_text.designators).includes("U1"));
  const prop = P.headless({seed: 1, alternative: 1, limit: 5}, h);
  assert.equal(prop.applied_alternative, 1);
  assert.equal(prop.moves.length, 5);
  assert.equal(touched, 1);
  assert.ok(work.documents[0].items.some(i => i.x < 60));
  assert.throws(() => P.headless({mode: "plan", alternative: 9}, h), /does not exist/);
  assert.throws(() => P.headless({mode: "plan", strategy: "magic"}, h), /Unknown placement strategy/);
});

test("needs a board outline", () => {
  const {doc, defs, project} = design({ics: 1});
  doc.outline = [];
  assert.throws(() => P.propose(project, doc, defs, {}), /board outline/);
});

test("AtriumAPI (AI Assistant): dryRun reports, propose:edits hands back a guarded proposal, write:edits applies", async () => {
  const {project} = design({ics: 2});
  const API = globalThis.AtriumAPI, doc = project.documents[0];
  const ro = API.headless(JSON.parse(JSON.stringify(project)), {extension: {id: "ro", permissions: {"read:project": true}}}).api;
  assert.throws(() => ro.autoplace({}), /propose:edits or write:edits/);
  const ph = API.headless(JSON.parse(JSON.stringify(project)), {extension: {id: "p", permissions: {"read:project": true, "propose:edits": true}}});
  const dry = await ph.api.autoplace({doc: doc.id, seed: 1, dryRun: true});
  assert.ok(dry.report.moved > 0 && dry.report.alternatives.length === 3);
  assert.ok(dry.report.moves.every(m => !("ref" in m)) && Object.keys(dry.report.untrusted_design_text.designators).length > 0);
  const handed = await ph.api.autoplace({doc: doc.id, seed: 1});
  assert.equal(handed.applied, 0);
  assert.equal(handed.proposal.version, 2);
  assert.ok(handed.proposal.ops.length > 0 && handed.proposal.ops.every(o => o.op === "set" && o.target === "item"));
  assert.ok(ph.project.documents[0].items.every(i => i.x > 60), "nothing applied without approval");
  const wh = API.headless(JSON.parse(JSON.stringify(project)), {extension: {id: "w", permissions: {"read:project": true, "write:edits": true}}});
  const done = await wh.api.autoplace({doc: doc.id, seed: 1});
  assert.ok(done.applied > 0);
  assert.ok(wh.project.documents[0].items.every(i => i.x < 60), "every footprint is on the board");
  const planes = await wh.api.planes({doc: doc.id, dryRun: true});
  assert.ok(planes.report.assignments.length > 0);
  const route = await wh.api.routePlan({doc: doc.id, dryRun: true, time_limit_ms: 3000});
  assert.ok(route.report.connections > 0);
  assert.ok(!wh.project.documents[0].items.some(i => i.kind === "track"), "a routing dry run leaves the board alone");
});

test("500 footprints place within the 5 s benchmark budget", () => {
  const {doc, defs, project} = design({ics: 50, perIc: 8, headers: 4, width: 200, height: 160, seed: 9});
  assert.ok(doc.items.length >= 500, doc.items.length + " parts");
  const {r, ms} = checkThroughput(now => {
    const t0 = now(), r = P.propose(project, doc, defs, {seed: 1}), ms = now() - t0;
    const best = r.alternatives[0];
    assert.equal(best.stats.unplaced.length, 0);
    assert.equal(best.score.overlaps, 0);
    assert.equal(best.score.outside, 0);
    return {r, ms};
  }, "placement took", 5000);
  const best = r.alternatives[0];
  console.log("  500+ parts: " + Math.round(ms) + " ms, " + r.alternatives.length + " alternatives, best " + best.strategy + " airwires " + best.score.wirelength_mm + " mm, DFA " + best.score.dfa_violations);
});

globalThis.__testDone = (async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("ok   " + t.name); }
    catch (e) { failed++; console.log("FAIL " + t.name + ": " + e.message + "\n" + (e.stack || e)); }
  }
  if (failed) throw Error(failed + " autoplace test(s) failed");
})();
