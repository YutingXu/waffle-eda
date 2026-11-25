"use strict";
// Route Suggestions evaluation harness: how close is a suggestion to what a human routed?
//
//   scripts/test-jsc.sh route-suggest-eval          quick run with thresholds (fails below them)
//   jsc tests/jsc-shim.js -- $PWD/tests/route-suggest-eval.cjs --full [--json] [--rows] [--weights '{"via":3}'] [--baseline] [--no-habits] [--tune]
//                                              [--corpus DIR]   (boards from scripts/fetch-route-corpus.py)
//
// Boards (routed by people; licences in THIRD_PARTY_NOTICES.md):
//   pidp11   Altium PiDP-11 I/O Expander (BSD-2-Clause, tests/fixtures/altium/pidp11-io-expander)
//   sample   Waffle's sample sensor board (tests/fixtures/cad-native/sample-sensor; Waffle's own licence)
//   mcp      the MCP sample board (tests/fixtures/cad-native/design-diff; Waffle's own licence)
//   kicad, eagle, easyeda  the importer demos in tests/fixtures/import (Waffle's own test files)
// For every two-terminal net with human copper: rip the net's tracks and vias, ask for a
// suggestion from one pad to the other, and compare with the human copper:
//   found      a legal suggestion was returned
//   drc        new clearance violations against the independent checker of tests/pcb/autorouter.cjs
//              plus copper outside the outline (must be 0)
//   layer      length-weighted layer agreement: sum over layers of min(share suggested, share human)
//   vias       |vias suggested - vias human| (mean) and exact match rate
//   lenRatio   suggested length / human length (median, and mean |log2| as "lenErr")
//   corner     agreement of the 45°-multiple segment share (1 - |difference|)
//   dist       mean distance (mm) from the suggestion to the human copper, both ways averaged
//   Habits (default; --no-habits off) are learned leave-one-out from the board's other human routes,
//   as the app learns them from the user's routes (route-habits.js).
//   score      composite used for tuning: layer + corner + via match - 0.5*lenErr - 0.15*dist
const fs = require("node:fs"), path = require("node:path");
globalThis.CFB ??= (() => { try { return require("../../app/vendor/cfb.min.js"); } catch { return undefined; } })();
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "viastack", "pcb-pours", "import-link", "connectivity", "net-ties", "rules", "router"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
for (const f of ["sexpr", "import-kicad", "import-eagle", "import-easyeda", "altium-rules", "source-file", "sch-import", "pcb-import", "io"]) { try { require(require("../support/app-source-paths.cjs").appFile(f + ".js")); } catch { /* importer optional */ } }
require("../../app/pcb/route-suggest-engine.js");
require("../../app/pcb/route-habits.js");
require("./autorouter-bench-boards.js");
const H = require("./autorouter.cjs");
const A = globalThis.Atrium, E = globalThis.AtriumRouteSuggestEngine, B = globalThis.AtriumBenchBoards;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const argv = typeof process !== "undefined" ? process.argv : [];
const has = k => argv.includes(k), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const bytes = f => new Uint8Array(fs.readFileSync(f));
const FIX = path.join(__dirname, "../fixtures");

function fromProject(p, name) { const d = p.documents.find(x => x.kind === "pcb"); return d ? {name, d, defs: new Map(p.library.map(x => [x.id, x])), project: p} : null; }
const {nativeCAD} = require("../support/native-cad.cjs");
const imp = (files, name) => fromProject(B.importFiles(files.map(f => [path.basename(f), bytes(f)]), name), name);
const BOARDS = {
  pidp11: () => imp(["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(n => path.join(FIX, "altium", "pidp11-io-expander", n)), "PiDP-11 I/O (Altium)"),
  sample: () => fromProject(nativeCAD("sample-sensor"), "Sample sensor board"),
  mcp: () => fromProject(nativeCAD("design-diff"), "MCP board"),
  kicad: () => imp([path.join(FIX, "import", "demo.kicad_pcb")], "KiCad demo"),
  eagle: () => imp([path.join(FIX, "import", "demo-eagle.brd")], "Eagle demo"),
  easyeda: () => imp([path.join(FIX, "import", "demo-easyeda-pcb.json")], "EasyEDA demo")
};

// Terminals (pad centres with a net) of a board.
function pads(d, defs) {
  const out = [];
  for (const it of d.items) {
    if (it.kind === "part") {
      const fp = defs.get(it.def)?.footprint; if (!fp) continue;
      for (const p of fp.pads || []) {
        const net = it.pinNets?.[p.number]; if (!net) continue;
        const at = A.world([p.x, p.y], it), layer = p.layer || (p.drill > 0 ? "Multi" : it.layer || "Top");
        out.push({net, at, layer: layer === "Multi" ? null : (it.side === "bottom" || it.layer === "Bottom") && layer === "Top" ? "Bottom" : layer, label: it.ref + "." + p.number, part: it});
      }
    } else if (it.kind === "pad" && it.net) out.push({net: it.net, at: [it.x, it.y], layer: it.layer === "Multi" || it.drill > 0 ? null : it.layer || "Top", label: "pad " + (it.number || it.id)});
  }
  return out;
}
// Cases: nets with exactly two terminals and human copper connecting them.
function cases(board) {
  const {d, defs} = board, P = pads(d, defs), by = new Map();
  for (const p of P) { if (!by.has(p.net)) by.set(p.net, []); by.get(p.net).push(p); }
  const out = [];
  for (const [net, list] of by) {
    if (list.length !== 2) continue;
    const copper = d.items.filter(i => (i.kind === "track" || i.kind === "via") && i.net === net);
    const tracks = copper.filter(i => i.kind === "track");
    if (!tracks.length) continue;
    if (d.items.some(i => i.kind === "polygon" && i.net === net && !i.shelved)) continue; // poured nets are not track routes
    const len = tracks.reduce((s, t) => s + E.pathLength(t.points), 0);
    if (len < 0.3) continue;
    out.push({net, a: list[0], b: list[1], copper, tracks, vias: copper.filter(i => i.kind === "via").length, length: len});
  }
  return out;
}
function share(tracks) {
  const m = new Map(); let t = 0;
  for (const tr of tracks) { const L = E.pathLength(tr.points); m.set(tr.layer, (m.get(tr.layer) || 0) + L); t += L; }
  for (const [k, v] of m) m.set(k, t ? v / t : 0);
  return m;
}
function oct(tracks) {
  let a = 0, t = 0;
  for (const tr of tracks) for (let i = 1; i < tr.points.length; i++) {
    const dx = tr.points[i][0] - tr.points[i - 1][0], dy = tr.points[i][1] - tr.points[i - 1][1], L = Math.hypot(dx, dy); if (L < 1e-6) continue;
    const ang = Math.atan2(dy, dx), q = Math.round(ang / (Math.PI / 4)) * Math.PI / 4;
    t += L; if (Math.abs(ang - q) < 0.02) a += L;
  }
  return t ? a / t : 1;
}
function samples(tracks, step = 0.25) {
  const out = [];
  for (const tr of tracks) for (let i = 1; i < tr.points.length; i++) {
    const a = tr.points[i - 1], b = tr.points[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
function segD(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]); }
function meanDist(from, tracks) {
  const pts = samples(from); if (!pts.length) return 0;
  let s = 0;
  for (const p of pts) { let m = Infinity; for (const tr of tracks) for (let i = 1; i < tr.points.length; i++) m = Math.min(m, segD(p, tr.points[i - 1], tr.points[i])); s += m; }
  return s / pts.length;
}

function evaluate(board, o = {}) {
  const {d, defs, project} = board, rows = [];
  const list = cases(board).slice(0, o.limit || Infinity);
  for (const c of list) {
    // Rip the net's copper and suggest from one pad to the other.
    const gone = new Set(c.copper.map(i => i.id));
    const ripped = {...d, items: d.items.filter(i => !gone.has(i.id))};
    const fromLayer = c.a.layer || c.b.layer || "Top";
    const t0 = now();
    // Habits (leave-one-out): learned from every other net's human copper on this board.
    let bias;
    if (o.habits) {
      const prof = globalThis.AtriumRouteHabits.fromBoard(ripped, defs, {pads: true, project});
      const layers = E.routingLayers(ripped, defs, AtriumRouter.core.rulesFor(ripped, {}, project), c.net);
      bias = globalThis.AtriumRouteHabits.bias(prof, "Default", layers);
    }
    const r = E.suggest(ripped, defs, {net: c.net, from: c.a.at, to: c.b.at, fromLayer, weights: o.weights, bias, budgetMs: o.budget || 400, alternatives: false, shove: false}, {project});
    const ms = now() - t0;
    const row = {board: board.name, net: c.net, from: c.a.label, to: c.b.label, humanLen: +c.length.toFixed(2), humanVias: c.vias, ms: +ms.toFixed(1), found: !!r.ok};
    if (r.ok) {
      const alt = r.alternatives[0], tracks = alt.legs.map(l => ({points: l.points, layer: l.layer}));
      const hs = share(c.tracks), ss = share(tracks);
      let layer = 0; for (const [k, v] of ss) layer += Math.min(v, hs.get(k) || 0);
      const plan = E.toPlan(alt, {net: c.net});
      const test = {...ripped, items: [...ripped.items, ...plan.add]}, ids = new Set(plan.add.map(i => i.id));
      const drc = H.clearanceViolations(test, defs, ids, project).length + H.outsideOutline(test, ids).length;
      Object.assign(row, {len: +alt.length.toFixed(2), vias: alt.viaCount, lenRatio: alt.length / c.length, layer, viaMatch: alt.viaCount === c.vias ? 1 : 0, viaDiff: Math.abs(alt.viaCount - c.vias),
        corner: 1 - Math.abs(oct(tracks) - oct(c.tracks)), dist: (meanDist(tracks, c.tracks) + meanDist(c.tracks, tracks)) / 2, drc, layers: alt.layers.join("+"), reasons: alt.reasons});
    } else row.reason = r.reason;
    rows.push(row);
  }
  return rows;
}
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN; };
function summary(rows) {
  const f = rows.filter(r => r.found);
  const lenErr = mean(f.map(r => Math.abs(Math.log2(r.lenRatio))));
  const s = {cases: rows.length, found: f.length / (rows.length || 1), drc: f.reduce((n, r) => n + r.drc, 0), layer: mean(f.map(r => r.layer)), viaMatch: mean(f.map(r => r.viaMatch)),
    viaDiff: mean(f.map(r => r.viaDiff)), lenRatio: med(f.map(r => r.lenRatio)), lenErr, corner: mean(f.map(r => r.corner)), dist: mean(f.map(r => r.dist)),
    msP50: pct(rows.map(r => r.ms), .5), msP95: pct(rows.map(r => r.ms), .95)};
  s.score = s.found * (s.layer + s.corner + s.viaMatch - 0.5 * lenErr - 0.15 * s.dist);
  for (const k of Object.keys(s)) if (typeof s[k] === "number" && !Number.isInteger(s[k])) s[k] = +s[k].toFixed(3);
  return s;
}
function loadBoards(names) {
  const out = [];
  for (const n of names) { try { const b = BOARDS[n](); if (b) out.push(b); } catch (e) { console.log("skip board " + n + ": " + e.message); } }
  const dir = arg("--corpus");
  if (dir) {
    const man = JSON.parse(fs.readFileSync(path.join(__dirname, "../route-corpus/manifest.json"), "utf8"));
    for (const b of man.boards) {
      const f = b.files[0].path.split("/").pop(), file = path.join(dir, b.name + "-" + b.commit.slice(0, 10), f);
      try { const r = imp([file], b.name + " (" + b.license + ")"); if (r) out.push(r); } catch (e) { console.log("skip corpus board " + b.name + ": " + e.message); }
    }
  }
  return out;
}
function runAll(boards, o) { const rows = []; for (const b of boards) rows.push(...evaluate(b, o)); return rows; }

const BASELINE = {via: 3, turn45: 0.1, turn90: 0.4, dir: 0, near: 0, layer: 0, inner: 0, exit: 0, fan: 0};
function main() {
  const full = has("--full") || has("--tune") || has("--baseline");
  const names = full ? Object.keys(BOARDS) : ["pidp11", "sample", "mcp"];
  const boards = loadBoards(names);
  const weights = has("--baseline") ? BASELINE : arg("--weights") ? JSON.parse(arg("--weights")) : undefined;
  if (has("--tune")) {
    // Coordinate descent on the cost weights, tuned on even cases, reported on all.
    let w = {...E.WEIGHTS}, bestS = -Infinity;
    const grid = {via: [1, 2, 3, 4, 6, 8], turn45: [0.05, 0.15, 0.25, 0.4], turn90: [0.4, 0.8, 1.2, 2], dir: [0, 0.15, 0.35, 0.6], near: [0, 0.04, 0.08, 0.16], inner: [0, 0.04, 0.1]};
    const score = ww => summary(runAll(boards, {weights: ww, habits: !has("--no-habits") && !has("--baseline")}).filter((_, i) => i % 2 === 0)).score;
    bestS = score(w);
    for (let round = 0; round < 2; round++) for (const k of Object.keys(grid)) for (const v of grid[k]) {
      const t = {...w, [k]: v}, s = score(t);
      if (s > bestS + 1e-6) { bestS = s; w = t; console.log("better", k, v, s.toFixed(3)); }
    }
    console.log("tuned weights", JSON.stringify(w));
    console.log("all cases", JSON.stringify(summary(runAll(boards, {weights: w, habits: !has("--no-habits") && !has("--baseline")}))));
    return;
  }
  const rows = runAll(boards, {weights, habits: !has("--no-habits") && !has("--baseline")});
  const s = summary(rows), per = {};
  for (const b of boards) per[b.name] = summary(rows.filter(r => r.board === b.name));
  if (has("--json")) console.log(JSON.stringify({summary: s, boards: per, rows}, null, 1));
  else {
    for (const [k, v] of Object.entries(per)) console.log(k.padEnd(24), JSON.stringify(v));
    console.log("ALL".padEnd(24), JSON.stringify(s));
    if (has("--rows")) for (const r of rows) console.log(JSON.stringify(r));
  }
  // Thresholds (quick run and full run): legal always; human likeness floors from the tuned run.
  // Measured 2026-11-19: found 1.0, DRC 0, layer 0.57, via match 0.61, lenErr 0.16, dist 1.72.
  const T = {found: 0.9, drc: 0, layer: 0.5, viaMatch: 0.45, corner: 0.9, lenErrMax: 0.3, distMax: 2.2};
  const bad = [];
  if (s.found < T.found) bad.push("found " + s.found + " < " + T.found);
  if (s.drc > T.drc) bad.push("DRC violations " + s.drc);
  if (!has("--baseline") && !weights) {
    if (s.layer < T.layer) bad.push("layer agreement " + s.layer + " < " + T.layer);
    if (!has("--no-habits") && s.viaMatch < T.viaMatch) bad.push("via match " + s.viaMatch + " < " + T.viaMatch);
    if (s.corner < T.corner) bad.push("corner agreement " + s.corner + " < " + T.corner);
    if (s.lenErr > T.lenErrMax) bad.push("length error " + s.lenErr + " > " + T.lenErrMax);
    if (s.dist > T.distMax) bad.push("distance " + s.dist + " > " + T.distMax);
  }
  if (bad.length) throw Error("route-suggest-eval below thresholds: " + bad.join("; "));
}
if (typeof module !== "undefined" && require.main === module) main();
module.exports = {evaluate, summary, cases, loadBoards, BOARDS, BASELINE};
