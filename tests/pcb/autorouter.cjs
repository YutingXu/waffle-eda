"use strict";
// Autorouter tests and benchmarks. Run with Node 18+:
//   node tests/pcb/autorouter.cjs [--bench] [--svg DIR]
// The helpers (dense routing board generator, an independent clearance checker
// and an SVG renderer) are exported for tests/pcb/fanout.cjs.
const assert = require("node:assert/strict");
const {pointSeg, segSeg} = require("../support/segment-distance.cjs");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/checks/connectivity.js");
require("../../app/checks/rules.js");
require("../../app/pcb/autorouter.js");
try { require("../../app/pcb/fanout.js"); } catch { /* fanout is optional for the core tests */ }
require("./autorouter-bench-boards.js");
const A = globalThis.Atrium, AR = globalThis.AtriumAutorouter;
const {denseFootprints: footprints, fineRules, lib} = globalThis.AtriumBenchBoards;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const argv = typeof process !== "undefined" ? process.argv : [];

// ------------------------------------------------------------------ board generator
// A deterministic dense board: QFPs, SOICs, an optional BGA, 0603 passives and
// headers with a local netlist of 2-4 pin nets plus two supply nets.
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296); }
function routingBoard({width = 100, height = 80, seed = 7, ics = 12, passives = 134, headers = 4, bga = false, power = true, rules = null} = {}) {
  const r = rng(seed), lib = footprints(), defs = new Map(lib.map(d => [d.id, d]));
  const d = A.sheet("pcb", "Dense routing board");
  if (rules || bga) d.rules = fineRules(rules || {});
  d.outline = [[0, 0], [width, 0], [width, height], [0, height]];
  const boxes = [];
  let id = 0;
  const fpBox = (def, x, y, angle) => {
    const b = A.bounds(A.symbolPoints(def.footprint));
    const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(p => A.world(p, {x, y, angle}));
    return A.bounds(pts);
  };
  function place(defId, x, y, angle, margin) {
    const def = defs.get(defId), b = fpBox(def, x, y, angle);
    if (b[0] < 2 || b[1] < 2 || b[2] > width - 2 || b[3] > height - 2) return null;
    if (boxes.some(q => q[0] < b[2] + margin && q[2] > b[0] - margin && q[1] < b[3] + margin && q[3] > b[1] - margin)) return null;
    boxes.push(b);
    const part = {id: "p" + (++id), kind: "part", def: defId, ref: def.prefix + id, value: def.value, x, y, angle, pinNets: {}, layer: "Top"};
    d.items.push(part);
    return part;
  }
  const icTypes = ["qfp64", "qfp48", "soic14", "soic8", "soic8", "soic14"];
  const icParts = [];
  if (bga) { const p = place("bga8", width / 2, height / 2, 0, 5); if (p) icParts.push(p); }
  for (let i = 0, tries = 0; icParts.length < ics + (bga ? 1 : 0) && tries < 4000; tries++) {
    const t = icTypes[i % icTypes.length], x = 10 + r() * (width - 20), y = 10 + r() * (height - 20);
    const p = place(t, Math.round(x * 2) / 2, Math.round(y * 2) / 2, [0, 90][(r() * 2) | 0], 5.5);
    if (p) { icParts.push(p); i++; }
  }
  const hdrParts = [];
  for (let i = 0, tries = 0; hdrParts.length < headers && tries < 2000; tries++) {
    const edge = i % 4, x = edge === 0 ? 4 : edge === 1 ? width - 4 : 15 + r() * (width - 30), y = edge === 2 ? 4 : edge === 3 ? height - 4 : 15 + r() * (height - 30);
    const p = place("hdr10", Math.round(x * 2) / 2, Math.round(y * 2) / 2, edge >= 2 ? 90 : 0, 2);
    if (p) { hdrParts.push(p); i++; }
  }
  const passiveParts = [];
  for (let tries = 0; passiveParts.length < passives && tries < 20000; tries++) {
    const ic = icParts[(r() * icParts.length) | 0], a = r() * Math.PI * 2, dist = 7 + r() * 9;
    const x = ic.x + Math.cos(a) * dist, y = ic.y + Math.sin(a) * dist;
    const p = place("r0603", Math.round(x * 4) / 4, Math.round(y * 4) / 4, [0, 90][(r() * 2) | 0], 0.9);
    if (p) passiveParts.push(p);
  }
  // Pins with world positions.
  const pins = [];
  for (const part of d.items) for (const pin of A.pins(part, defs.get(part.def), "pcb")) pins.push({part, number: pin.number, at: pin.at, used: false});
  const byPart = new Map();
  for (const pin of pins) { if (!byPart.has(pin.part)) byPart.set(pin.part, []); byPart.get(pin.part).push(pin); }
  const dist = (a, b) => Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
  let netN = 0;
  const assign = (list, name) => { name = name || "N" + (++netN); for (const p of list) { p.used = true; p.part.pinNets[p.number] = name; } return name; };
  const freeNear = (from, filter, k = 6) => {
    const c = pins.filter(p => !p.used && p.part !== from.part && filter(p)).sort((a, b) => dist(a, from) - dist(b, from));
    return c.slice(0, k);
  };
  const isIC = p => p.part.def !== "r0603" && p.part.def !== "hdr10";
  // Supply nets on a share of IC pins and passive returns.
  const supply = [];
  for (const ic of icParts) {
    const list = byPart.get(ic).filter(p => !p.used);
    if (!power) continue;
    const gnd = list.filter((_, i) => i % 8 === 3), vcc = list.filter((_, i) => i % 8 === 7);
    for (const p of gnd) { p.used = true; p.part.pinNets[p.number] = "GND"; supply.push(p); }
    for (const p of vcc) { p.used = true; p.part.pinNets[p.number] = "VCC"; supply.push(p); }
  }
  for (const ic of icParts) {
    for (const p of byPart.get(ic)) {
      if (p.used || r() < 0.15) continue;
      const kind = r();
      if (kind < 0.4) {
        const res = freeNear(p, q => q.part.def === "r0603" && byPart.get(q.part).every(s => !s.used), 3)[(r() * 3) | 0];
        if (!res) continue;
        assign([p, res]);
        const other = byPart.get(res.part).find(s => !s.used);
        const far = freeNear(other, q => isIC(q) && q.part !== ic, 8)[(r() * 8) | 0] || freeNear(other, q => q.part.def === "hdr10", 2)[0];
        if (far) assign([other, far]);
        else if (power) { other.used = true; other.part.pinNets[other.number] = r() < 0.5 ? "GND" : "VCC"; supply.push(other); }
      } else if (kind < 0.85) {
        const q = freeNear(p, q => isIC(q) && q.part !== ic, 10)[(r() * 10) | 0];
        if (!q) continue;
        const list = [p, q];
        if (r() < 0.15) { const t = freeNear(q, s => isIC(s) && s.part !== q.part && s.part !== ic, 6)[0]; if (t) list.push(t); }
        assign(list);
      } else {
        const q = freeNear(p, q => q.part.def === "hdr10", 4)[(r() * 4) | 0];
        if (q) assign([p, q]);
      }
    }
  }
  if (power) for (const res of passiveParts) {
    const ps = byPart.get(res);
    if (ps.some(s => s.used)) continue;
    ps[0].used = ps[1].used = true;
    res.pinNets[ps[0].number] = "VCC"; res.pinNets[ps[1].number] = "GND";
  }
  return {d, defs};
}

// ------------------------------------------------------------------ independent checker
// Copper as convex cores grown by a radius, distances by edge pairs. Written
// separately from the router so the two can disagree.
function copperOf(doc, defs, ids) {
  const out = [], idx = n => n === "Top" ? 0 : n === "Bottom" ? 32 : +(/^Inner (\d+)$/.exec(n || "") || [0, -1])[1];
  function padCore(p, part) {
    const c = part ? A.world([p.x, p.y], part) : [p.x, p.y], ang = ((part?.angle || 0) + (p.angle || 0)) * Math.PI / 180;
    const rot = (x, y) => [c[0] + x * Math.cos(ang) - y * Math.sin(ang), c[1] + x * Math.sin(ang) + y * Math.cos(ang)];
    const w = p.w ?? p.diameter, h = p.h ?? p.diameter, s = String(p.shape || "round").toLowerCase();
    if (["round", "circle", "oval", "ellipse"].includes(s)) {
      if (Math.abs(w - h) < 1e-9) return {pts: [c], r: w / 2};
      const k = Math.abs(w - h) / 2;
      return {pts: w > h ? [rot(-k, 0), rot(k, 0)] : [rot(0, -k), rot(0, k)], r: Math.min(w, h) / 2};
    }
    const rr = ["roundrect", "rounded", "roundedrect"].includes(s) ? Math.min(w, h) * .18 : 0;
    return {pts: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => rot(x * (w / 2 - rr), y * (h / 2 - rr))), r: rr};
  }
  for (const i of doc.items) {
    const fresh = !ids || ids.has(i.id);
    if (i.kind === "track" && idx(i.layer) >= 0) for (let k = 1; k < i.points.length; k++) out.push({pts: [i.points[k - 1], i.points[k]], r: i.width / 2, lo: idx(i.layer), hi: idx(i.layer), net: i.net || "", fresh, id: i.id});
    if (i.kind === "via") { const a = idx(i.fromLayer || "Top"), b = idx(i.toLayer || "Bottom"); out.push({pts: [[i.x, i.y]], r: i.diameter / 2, lo: Math.min(a, b), hi: Math.max(a, b), net: i.net || "", fresh, id: i.id}); }
    if (i.kind === "part") {
      for (const p of defs.get(i.def)?.footprint?.pads || []) {
        const layer = p.layer || (p.drill > 0 ? "Multi" : i.layer || "Top");
        const c = padCore(p, i), net = i.pinNets?.[p.number] ?? "";
        if (layer === "Multi") out.push({...c, lo: 0, hi: 32, net, fresh: false, id: i.id});
        else if (idx(layer) >= 0) out.push({...c, lo: idx(layer), hi: idx(layer), net, fresh: false, id: i.id});
      }
    }
  }
  return out;
}
function inConvex(p, pts) {
  if (pts.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
  }
  return true;
}
function gap(A1, B1) {
  if (inConvex(B1.pts[0], A1.pts) || inConvex(A1.pts[0], B1.pts)) return -A1.r - B1.r;
  const ea = A1.pts.length === 1 ? [[A1.pts[0], A1.pts[0]]] : A1.pts.length === 2 ? [[A1.pts[0], A1.pts[1]]] : A1.pts.map((p, i) => [p, A1.pts[(i + 1) % A1.pts.length]]);
  const eb = B1.pts.length === 1 ? [[B1.pts[0], B1.pts[0]]] : B1.pts.length === 2 ? [[B1.pts[0], B1.pts[1]]] : B1.pts.map((p, i) => [p, B1.pts[(i + 1) % B1.pts.length]]);
  let best = Infinity;
  for (const [a, b] of ea) for (const [c, d] of eb) {
    const distance = segSeg(a, b, c, d);
    if (!distance) return -A1.r - B1.r;
    best = Math.min(best, distance);
  }
  return best - A1.r - B1.r;
}
// Clearance violations that involve at least one object from `ids`.
function clearanceViolations(doc, defs, ids, project) {
  const objs = copperOf(doc, defs, ids), cache = new Map();
  const clr = (a, b) => {
    const k = a < b ? a + "\u0000" + b : b + "\u0000" + a;
    if (!cache.has(k)) cache.set(k, AtriumRules.query(doc, "clearance", {net: a, net2: b, project})?.gap ?? 0.2);
    return cache.get(k);
  };
  const S = 2, grid = new Map(), out = [];
  for (const o of objs) {
    const xs = o.pts.map(p => p[0]), ys = o.pts.map(p => p[1]);
    o.box = [Math.min(...xs) - o.r, Math.min(...ys) - o.r, Math.max(...xs) + o.r, Math.max(...ys) + o.r];
    for (let x = Math.floor(o.box[0] / S); x <= Math.floor(o.box[2] / S); x++) for (let y = Math.floor(o.box[1] / S); y <= Math.floor(o.box[3] / S); y++) {
      const k = x + "," + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(o);
    }
  }
  const seen = new Set();
  objs.forEach((o, i) => { o.i = i; });
  for (const list of grid.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (!a.fresh && !b.fresh) continue;
    if (a.net && a.net === b.net) continue;
    if (a.hi < b.lo || b.hi < a.lo) continue;
    const key = Math.min(a.i, b.i) + ":" + Math.max(a.i, b.i);
    if (seen.has(key)) continue; seen.add(key);
    const need = clr(a.net, b.net);
    if (a.box[0] > b.box[2] + need || b.box[0] > a.box[2] + need || a.box[1] > b.box[3] + need || b.box[1] > a.box[3] + need) continue;
    const d = gap(a, b);
    if (d < need - 1e-6) out.push({a: a.net || "(no net)", b: b.net || "(no net)", gap: d, need, at: a.pts[0], ids: [a.id, b.id]});
  }
  return out;
}
function outsideOutline(doc, ids, edge) {
  const poly = doc.outline, bad = [];
  if (!poly?.length) return bad;
  const inside = p => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) r = !r; } return r; };
  for (const i of doc.items) {
    if (!ids.has(i.id)) continue;
    const pts = i.points || [[i.x, i.y]], r = (i.width || i.diameter) / 2;
    for (const p of pts) {
      if (!inside(p)) { bad.push(i.id); break; }
      let m = Infinity; for (let k = 0; k < poly.length; k++) m = Math.min(m, pointSeg(p, poly[k], poly[(k + 1) % poly.length]));
      if (m - r < edge - 1e-6) { bad.push(i.id); break; }
    }
  }
  return bad;
}

// ------------------------------------------------------------------ SVG
function render(doc, defs, {violations = [], title = ""} = {}) {
  const b = A.bounds(doc.outline?.length ? doc.outline : [[0, 0], [10, 10]]), s = 10;
  const col = {Top: "#d33", Bottom: "#36c", "Inner 1": "#c90", "Inner 2": "#2a8", "Inner 3": "#a5c", "Inner 4": "#0cc"};
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(b[0] - 2) * s} ${(b[1] - 2) * s} ${(b[2] - b[0] + 4) * s} ${(b[3] - b[1] + 6) * s}" style="background:#111">`];
  out.push(`<polygon points="${doc.outline.map(p => p.map(v => v * s).join(",")).join(" ")}" fill="#000" stroke="#888" stroke-width="2"/>`);
  for (const o of copperOf(doc, defs, null).filter(o => o.id && doc.items.find(i => i.id === o.id)?.kind === "part")) {
    if (o.pts.length >= 3) out.push(`<polygon points="${o.pts.map(p => p.map(v => v * s).join(",")).join(" ")}" fill="#c8a040" stroke="#c8a040" stroke-width="${o.r * 2 * s}" stroke-linejoin="round" opacity=".85"/>`);
    else if (o.pts.length === 2) out.push(`<line x1="${o.pts[0][0] * s}" y1="${o.pts[0][1] * s}" x2="${o.pts[1][0] * s}" y2="${o.pts[1][1] * s}" stroke="#c8a040" stroke-width="${o.r * 2 * s}" stroke-linecap="round" opacity=".85"/>`);
    else out.push(`<circle cx="${o.pts[0][0] * s}" cy="${o.pts[0][1] * s}" r="${o.r * s}" fill="#c8a040" opacity=".85"/>`);
  }
  const layers = [...new Set(doc.items.filter(i => i.kind === "track").map(i => i.layer))].sort((a, b) => (b === "Top") - (a === "Top"));
  for (const L of layers.reverse()) for (const t of doc.items) if (t.kind === "track" && t.layer === L)
    out.push(`<polyline points="${t.points.map(p => p.map(v => v * s).join(",")).join(" ")}" fill="none" stroke="${col[L] || "#999"}" stroke-width="${t.width * s}" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>`);
  for (const v of doc.items) if (v.kind === "via") out.push(`<circle cx="${v.x * s}" cy="${v.y * s}" r="${v.diameter / 2 * s}" fill="#ddd"/><circle cx="${v.x * s}" cy="${v.y * s}" r="${v.drill / 2 * s}" fill="#222"/>`);
  try {
    for (const w of AtriumConnectivity.inspect(doc, defs).airwires) out.push(`<line x1="${w.from[0] * s}" y1="${w.from[1] * s}" x2="${w.to[0] * s}" y2="${w.to[1] * s}" stroke="#fff" stroke-width="1" stroke-dasharray="4 3"/>`);
  } catch { /* render without airwires */ }
  for (const v of violations) out.push(`<circle cx="${v.at[0] * s}" cy="${v.at[1] * s}" r="${8}" fill="none" stroke="#f0f" stroke-width="3"/>`);
  out.push(`<text x="${b[0] * s}" y="${(b[3] + 3) * s}" fill="#ccc" font-size="${2 * s}" font-family="sans-serif">${title}</text></svg>`);
  return out.join("\n");
}

// ------------------------------------------------------------------ routing check
function routeAndCheck(doc, defs, options = {}, project) {
  const before = new Set(doc.items.map(i => i.id));
  const t = now();
  const plan = AR.routeBoard(doc, defs, {project, ...options});
  const ms = now() - t;
  AR.apply(doc, plan);
  const fresh = new Set(doc.items.filter(i => !before.has(i.id)).map(i => i.id));
  const tc = now();
  const violations = clearanceViolations(doc, defs, fresh, project);
  const outside = outsideOutline(doc, fresh, 0.2);
  const conn = AtriumConnectivity.inspect(doc, defs);
  return {plan, ms, checkMs: now() - tc, violations, outside, shorts: conn.shorts, airwires: conn.airwires.length, fresh};
}

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const stripRoutes = d => { d.items = d.items.filter(i => i.kind !== "track" && i.kind !== "via"); };

test("the dense and benchmark fixture inputs retain their separate geometry and rules", () => {
  // Captured from the separate generators before sharing them. Rule IDs are freshly issued.
  const rules = [{}, {width: 0.12, via: 0.5, drill: 0.23}].map(options => fineRules(options).list.map(({id, ...row}) => row));
  const digest = value => {
    let hash = 2166136261;
    for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
    return hash >>> 0;
  };
  assert.equal(digest([footprints(), ...rules]), 3973546777, "dense routing fixture");
  const benchmark = [lib.qfp(64, 0.5, 5.75), lib.qfp(48, 0.5, 4.75), lib.bga(8, 0.8), lib.header(10)];
  assert.equal(digest([benchmark, ...rules]), 1989801602, "benchmark fixture");
});
test("routes the sample board completely with no clearance violations or shorts", () => {
  const p = AtriumParts.example(), b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
  stripRoutes(b);
  const total = AtriumConnectivity.inspect(b, defs).airwires.length;
  const r = routeAndCheck(b, defs, {}, p);
  assert.equal(r.plan.report.total, total);
  assert.equal(r.plan.report.routed, total);
  assert.equal(r.airwires, 0);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.shorts, []);
  assert.deepEqual(r.outside, []);
});
test("plans are plain edit plans and leave existing copper untouched", () => {
  const p = AtriumParts.example(), b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
  const keep = b.items.filter(i => i.kind === "track" && i.net === "VIN");
  b.items = b.items.filter(i => !(i.kind === "track" || i.kind === "via") || i.net === "VIN");
  const before = JSON.stringify(keep);
  const plan = AR.routeBoard(b, defs, {project: p});
  assert.ok(Array.isArray(plan.add) && Array.isArray(plan.remove));
  assert.equal(plan.remove.length, 0);
  for (const item of plan.add) { assert.ok(["track", "via"].includes(item.kind)); assert.ok(item.id && item.net); }
  assert.ok(!plan.add.some(i => i.net === "VIN"), "VIN was already routed");
  AR.apply(b, plan);
  assert.equal(JSON.stringify(b.items.filter(i => keep.some(k => k.id === i.id))), before);
  A.validate(p);
});
test("route net, component and area scopes only route what they name", () => {
  const p = AtriumParts.example(), b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
  stripRoutes(b);
  const n = AR.routeBoard(b, defs, {project: p, scope: {nets: ["GND"]}});
  assert.ok(n.add.length && n.add.every(i => i.net === "GND"));
  const u1 = b.items.find(i => i.ref === "U1");
  const c = AR.routeBoard(b, defs, {project: p, scope: {components: [u1.id]}});
  assert.ok(c.report.total > 0 && c.report.total < 12);
  const a = AR.routeBoard(b, defs, {project: p, scope: {area: [0, 0, 12, 22]}});
  assert.ok(a.report.total < c.report.total + 12);
});
test("respects routing layer rules and keep-outs", () => {
  const p = AtriumParts.example(), b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
  stripRoutes(b);
  b.items.push({id: "ko", kind: "track", layer: "Keepout", width: 0.1, net: "", points: [[11, 0.5], [11, 21.5]]});
  b.items.push({id: "ko2", kind: "track", layer: "Keepout", width: 0.1, net: "", points: [[11.5, 0.5], [11.5, 21.5]]});
  const plan = AR.routeBoard(b, defs, {project: p, layers: ["Top"]});
  assert.ok(plan.add.every(i => i.kind !== "via" && i.layer === "Top"));
  for (const t of plan.add) for (let k = 1; k < t.points.length; k++) {
    const [a, c] = [t.points[k - 1], t.points[k]];
    assert.ok(!(Math.min(a[0], c[0]) < 11.5 + 0.2 && Math.max(a[0], c[0]) > 11 - 0.2), "crosses the keep-out");
  }
});
test("dense 4-layer board: high completion, zero violations, no shorts, seconds", () => {
  const {d, defs} = routingBoard({seed: 11});
  const total = AtriumConnectivity.inspect(d, defs).airwires.length;
  const r = routeAndCheck(d, defs, {layers: ["Top", "Inner 1", "Inner 2", "Bottom"]});
  const rep = r.plan.report;
  console.log("    dense 4L: " + rep.routed + "/" + rep.total + " (" + total + " airwires) in " + r.ms.toFixed(0) + " ms, vias " + rep.vias + ", length " + rep.length.toFixed(0) + " mm, violations " + r.violations.length);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.shorts, []);
  assert.deepEqual(r.outside, []);
  assert.ok(rep.routed / rep.total >= 0.95, "completion " + rep.routed + "/" + rep.total);
  assert.ok(r.airwires <= total - rep.routed);
});

function pairBoard() {
  const defs = new Map(footprints().map(d => [d.id, d]));
  const d = A.sheet("pcb", "Pairs");
  d.outline = [[0, 0], [60, 0], [60, 40], [0, 40]];
  const part = (id, def, x, y, angle, nets) => ({id, kind: "part", def, ref: id, value: "", x, y, angle, pinNets: nets, layer: "Top"});
  d.items.push(part("J1", "hdr10", 5, 20, 0, {"1": "USB_P", "2": "USB_N", "3": "D2_P", "4": "D2_N", "5": "A", "6": "B"}));
  d.items.push(part("U1", "soic14", 48, 14, 0, {"1": "USB_P", "2": "USB_N", "3": "A", "5": "D2_P", "6": "D2_N", "4": "B"}));
  d.items.push(part("R1", "r0603", 25, 20, 90, {"1": "X", "2": "Y"}));
  d.items.push(part("R2", "r0603", 30, 26, 0, {"1": "X", "2": "Y"}));
  const rules = fineRules({clearance: 0.15, width: 0.15});
  rules.diffPairs = [{name: "USB", positive: "USB_P", negative: "USB_N"}, {name: "D2", positive: "D2_P", negative: "D2_N"}];
  for (const r of rules.list) if (r.type === "diffPairsRouting") { r.widthPreferred = 0.2; r.gapPreferred = 0.2; }
  d.rules = rules;
  return {d, defs};
}
test("differential pairs are routed as coupled pairs at the pair width", () => {
  const {d, defs} = pairBoard();
  const r = routeAndCheck(d, defs, {});
  const rep = r.plan.report;
  assert.equal(rep.routed, rep.total);
  assert.deepEqual(r.violations, []);
  assert.equal(rep.pairs.length, 2);
  for (const p of rep.pairs) assert.ok(p.coupled > 0.7, p.positive + " coupled " + p.coupled.toFixed(2));
  assert.ok(r.plan.add.filter(i => i.kind === "track" && /_[PN]$/.test(i.net)).every(t => Math.abs(t.width - 0.2) < 1e-9));
  const loose = routeAndCheck(pairBoard().d, defs, {diffPairs: false});
  assert.ok(!loose.plan.report.pairs.length);
});
test("unlocked pre-routes are ripped up only when pre-routes are not locked", () => {
  const p = AtriumParts.example(), b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
  const locked = b.items.find(i => i.kind === "track" && i.net === "VIN");
  locked.locked = true;
  const kept = AR.routeBoard(b, defs, {project: p});
  assert.equal(kept.remove.length, 0);
  const redo = AR.routeBoard(b, defs, {project: p, lockPreroutes: false});
  assert.ok(redo.remove.length > 0 && !redo.remove.includes(locked.id));
  AR.apply(b, redo);
  assert.ok(b.items.includes(locked));
  const after = AtriumConnectivity.inspect(b, defs);
  assert.equal(after.shorts.length, 0);
  assert.equal(after.airwires.length, 0);
  assert.deepEqual(clearanceViolations(b, defs, new Set(redo.add.map(i => i.id)), p), []);
});
test("the Blob and file workers route without page globals", () => {
  const p = AtriumParts.example(), b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
  stripRoutes(b);
  const prep = AR.prepare(b, defs, {project: p});

  const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
  for (const entry of ["blob", "file"]) {
    const posted = [], scope = vm.createContext({postMessage: m => posted.push(m)});
    scope.self = scope;
    if (entry === "blob") vm.runInContext(AR.workerSource(), scope);
    else {
      const workerDir = path.dirname(require.resolve("../../app/workers/autorouter-worker.js"));
      scope.importScripts = (...files) => {
        for (const file of files) {
          const src = fs.readFileSync(path.resolve(workerDir, file), "utf8");
          vm.runInContext(src, scope, {filename: file});
        }
      };
      scope.importScripts("autorouter-worker.js");
    }
    scope.onmessage({data: {type: "route", id: 7, job: JSON.parse(JSON.stringify(prep.job))}});
    assert.equal(posted[0].type, "ready");
    assert.equal(posted.at(-1).type, "result", posted.at(-1).message);
    assert.equal(posted.at(-1).id, 7);
    const {stats} = posted.at(-1).value;
    assert.equal(stats.routed, stats.total);
  }
});
test("routing is a generator that reports progress and stops when asked", () => {
  const {d, defs} = routingBoard({seed: 2, ics: 6, passives: 40});
  const prep = AR.prepare(d, defs, {});
  const it = AR.core.route(prep.job);
  const first = it.next();
  assert.equal(first.value.type, "progress");
  it.return();
  assert.equal(it.next().done, true);
  let events = 0;
  const res = AR.core.runSync(AR.prepare(d, defs, {}).job, () => events++);
  assert.ok(events > 3 && res.type === "result");
});

function main() {
  let failed = 0;
  for (const t of tests) {
    try { const s = now(); t.fn(); console.log("ok   " + t.name + " (" + (now() - s).toFixed(0) + " ms)"); }
    catch (error) { failed++; console.log("FAIL " + t.name + "\n" + (error && error.stack || error)); }
  }
  console.log(tests.length - failed + "/" + tests.length + " autorouter tests passed");
  if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " autorouter test" + (failed === 1 ? "" : "s") + " failed"); }
}
// Benchmarks: node tests/pcb/autorouter.cjs --bench [--svg DIR]
function bench() {
  const rows = [];
  const svgAt = argv.indexOf("--svg"), svgDir = svgAt >= 0 ? argv[svgAt + 1] : null;
  const write = (name, text) => { if (!svgDir) return; try { require("node:fs").writeFileSync(svgDir + "/" + name, text); } catch { if (typeof writeFile === "function") writeFile(svgDir + "/" + name, text); } };
  function one(name, make, options) {
    const {d, defs, project} = make();
    const parts = d.items.filter(i => i.kind === "part").length;
    const r = routeAndCheck(d, defs, options, project);
    const rep = r.plan.report;
    rows.push({board: name, parts, connections: rep.total, routed: rep.routed, pct: (100 * rep.routed / Math.max(1, rep.total)).toFixed(1),
      ms: Math.round(r.ms), vias: rep.vias + (rep.fanout?.vias || 0), length: Math.round(rep.length), violations: r.violations.length, shorts: r.shorts.length,
      gridMB: (rep.grid.bytes / 1048576).toFixed(1), pitch: rep.grid.pitch.toFixed(3), iterations: rep.iterations, expansions: rep.expansions});
    write(name.replace(/[^a-z0-9]+/gi, "-") + ".svg", render(d, defs, {violations: r.violations, title: name + " " + rep.routed + "/" + rep.total}));
  }
  const sample = () => { const p = AtriumParts.example(), b = p.documents[1]; stripRoutes(b); return {d: b, defs: new Map(p.library.map(x => [x.id, x])), project: p}; };
  one("Sensor board", sample, {});
  const L4 = ["Top", "Inner 1", "Inner 2", "Bottom"];
  for (const seed of [11, 12, 13, 14, 15]) one("Dense 4L seed " + seed, () => routingBoard({seed}), {layers: L4});
  for (const seed of [11, 12]) one("Dense 2L seed " + seed, () => routingBoard({seed}), {});
  one("BGA 4L + fanout", () => routingBoard({seed: 9, bga: true}), {layers: L4, fanout: true, fanoutOptions: {auto: "bga"}});
  one("Pairs", pairBoard, {});
  const cols = Object.keys(rows[0]);
  console.log(cols.join("\t"));
  for (const r of rows) console.log(cols.map(c => r[c]).join("\t"));
  return rows;
}
module.exports = {routingBoard, bench, fineRules, pairBoard, footprints, clearanceViolations, outsideOutline, copperOf, render, routeAndCheck, stripRoutes};
// Run directly (Node sets require.main; the JavaScriptCore shim names the file in argv).
const direct = require.main === module || (!require.main && /autorouter\.cjs$/.test(String(argv[1] || "")));
if (direct) { if (argv.includes("--bench")) bench(); else main(); }
