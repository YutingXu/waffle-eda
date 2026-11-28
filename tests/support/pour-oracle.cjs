"use strict";
// The pour oracle: a board imported with the copper its source tool stored (Altium's polygon fill,
// KiCad's filled_polygon), repoured by Waffle, and the two compared pour by pour.
//
//   load(files)              -> {project, board, defs, stored}: imported as File › Import does, the
//                               board's own rules converted, `stored` the source fill before any repour.
//   repour(loaded)           -> regions of a fresh full repour (on a copy).
//   compare(stored, poured, {tol, board}) -> per pour:
//     stored, poured          copper area (mm²; Altium's copper outside the board shape left out and
//                             reported as `outside`: Waffle clips a pour to the board shape)
//     missing, extra          area the repour lacks / adds (exact integer overlay)
//     slivers                 the part of missing + extra in XOR islands no wider than `tol` (mean width
//                             2·area/perimeter): boundary offsets of tessellation, not objects
//     islands                 the wider XOR islands: {sign, area, width, box, at, rings (oriented)}
//   areaWithin(island, discs)  the area of an island inside any of discs [{at, r}] (mm²)
//     maxDeviation            largest vertex distance between the two boundaries (mm, capped at
//                             DEVIATION_CAP), leaving out vertices where skip(x, y) (explained lands)
// Loads the app modules it needs; the caller loads nothing else.
const files = ["model", "parts", "sch-objects", "hierarchy", "spatial", "board-shape", "board-shape-sources", "stackup", "pcb-pours",
  "pcb-appearance", "altium-rules", "component-classes", "net-intent", "signals", "query", "rules", "project-rules", "viastack",
  "polygon-pour", "import-link", "source-file", "sch-import", "pcb-import", "io", "connectivity", "import-rules", "sexpr", "import-kicad"];
globalThis.CFB ??= require("../../app/vendor/cfb.min.js");
for (const f of files) require(require("./app-source-paths.cjs").appFile(f + ".js"));
const P = AtriumPolygonPour, PP = AtriumPCBPours, A = Atrium;

function load(input) {
  const results = AtriumImportFormats.readSet(input);
  const project = A.project("Pour oracle");
  project.documents = results.flatMap(r => r.documents || []);
  project.library = results.flatMap(r => r.library || []);
  if (globalThis.AtriumImportLink) AtriumImportLink.reconcile(project, project.documents);
  const board = project.documents.find(d => d.kind === "pcb"), defs = new Map(project.library.map(d => [d.id, d]));
  const stored = JSON.parse(JSON.stringify(board.pcbDrawing?.pours || []));
  AtriumSignals?.attach?.(project);
  // Altium boards bring their rules as source records; KiCad's importer converts them itself.
  if (board.sourceRules?.length) AtriumImportRules.apply(board, project, defs);
  return {project, board, defs, stored};
}
function repour({project, board}) {
  const copy = A.clone(project), b = copy.documents.find(d => d.id === board.id);
  AtriumSignals?.attach?.(copy);
  P.apply(b, new Map(copy.library.map(d => [d.id, d])), {project: copy, reuse: false});
  return b.pcbDrawing?.pours || [];
}

const ringArea = r => { let a = 0; const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; return a / 2; };
const reversed = r => { const n = r.length >> 1, o = new Float64Array(r.length); for (let i = 0; i < n; i++) { o[2 * i] = r[2 * (n - 1 - i)]; o[2 * i + 1] = r[2 * (n - 1 - i) + 1]; } return o; };
// A region's rings oriented for nonzero winding: outline counter-clockwise, holes clockwise.
const oriented = regions => regions.flatMap(r => PP.contours(r).map((ring, k) => (k === 0) === (ringArea(ring) > 0) ? ring : reversed(ring)));
const flat = pts => pts.flatMap(q => [q[0], q[1]]);
const islandArea = o => Math.abs(ringArea(flat(o.outline))) - o.holes.reduce((s, h) => s + Math.abs(ringArea(flat(h))), 0);
const area = rings => P.union(rings).reduce((s, o) => s + islandArea(o), 0);
function perimeter(o) {
  let s = 0;
  for (const r of [o.outline, ...o.holes]) for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return s;
}
function boxOf(pts) { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of pts) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); } return b; }
// Largest distance from a vertex of either ring set to the other's boundary (a uniform grid of edges),
// up to cap; vertices where skip(x, y) are left out.
const DEVIATION_CAP = 10;
function maxDeviation(ra, rb, cap = DEVIATION_CAP, skip = null) {
  const cell = .5, grid = rings => {
    const g = new Map();
    for (const r of rings) { const n = r.length >> 1; for (let i = 0; i < n; i++) { const j = (i + 1) % n, s = [r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]];
      for (let x = Math.floor(Math.min(s[0], s[2]) / cell); x <= Math.floor(Math.max(s[0], s[2]) / cell); x++)
        for (let y = Math.floor(Math.min(s[1], s[3]) / cell); y <= Math.floor(Math.max(s[1], s[3]) / cell); y++) { const k = x + "," + y; (g.get(k) || g.set(k, []).get(k)).push(s); } } }
    return g;
  };
  const seg = (x, y, s) => { const dx = s[2] - s[0], dy = s[3] - s[1], l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / l)) : 0; return Math.hypot(s[0] + t * dx - x, s[1] + t * dy - y); };
  const directed = (from, g) => {
    let worst = 0; const R = Math.ceil(cap / cell);
    for (const r of from) for (let i = 0; i < r.length; i += 2) {
      const x = r[i], y = r[i + 1], cx = Math.floor(x / cell), cy = Math.floor(y / cell); let best = cap;
      if (skip && skip(x, y)) continue;
      for (let ring = 0; ring <= R && best > (ring - 1) * cell; ring++)
        for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const s of g.get((cx + dx) + "," + (cy + dy)) || []) best = Math.min(best, seg(x, y, s));
        }
      worst = Math.max(worst, best);
    }
    return worst;
  };
  return Math.max(directed(ra, grid(rb)), directed(rb, grid(ra)));
}
const orient = o => [signed(flat(o.outline), 1), ...o.holes.map(h => signed(flat(h), -1))];
const signed = (r, sign) => Math.sign(ringArea(r)) === sign ? r : Array.from(reversed(r));
// A disc as a 64-gon (counter-clockwise).
const disc = ({at, r}) => { const out = []; for (let k = 0; k < 64; k++) { const a = k * Math.PI / 32; out.push(at[0] + r * Math.cos(a), at[1] + r * Math.sin(a)); } return out; };
function areaWithin(island, discs) {
  const b = island.box, near = discs.filter(d => d.at[0] + d.r >= b[0] && d.at[0] - d.r <= b[2] && d.at[1] + d.r >= b[1] && d.at[1] - d.r <= b[3]);
  if (!near.length) return 0;
  return P.intersection(island.rings, P.union(near.map(disc)).flatMap(orient)).reduce((s, o) => s + islandArea(o), 0);
}
function compare(stored, poured, {tol = .0127, board = null, polygon, skip = null}) {
  let a = oriented(stored.filter(r => r.polygon === polygon.id && r.layer === polygon.layer));
  const b = oriented(poured.filter(r => r.polygon === polygon.id && r.layer === polygon.layer));
  const out = {pour: polygon.name || polygon.id, layer: polygon.layer, net: polygon.net || "", outside: 0};
  if (!a.length) return {...out, skipped: "no stored fill"};
  if (board?.length >= 3) {
    const inside = P.intersection(a, [flat(board)]), all = area(a);
    const as = (r, sign) => Math.sign(ringArea(r)) === sign ? r : Array.from(reversed(r));
    a = inside.flatMap(o => [as(flat(o.outline), 1), ...o.holes.map(h => as(flat(h), -1))]);
    out.outside = all - inside.reduce((s, o) => s + islandArea(o), 0);
  }
  out.stored = area(a); out.poured = b.length ? area(b) : 0;
  const pieces = [...P.difference(a, b).map(o => ["missing", o]), ...(b.length ? P.difference(b, a) : []).map(o => ["extra", o])];
  out.missing = 0; out.extra = 0; out.slivers = 0; out.islands = [];
  for (const [sign, o] of pieces) {
    const s = islandArea(o); if (!(s > 0)) continue;
    out[sign] += s;
    const width = 2 * s / perimeter(o);
    if (width <= tol) { out.slivers += s; continue; }
    const box = boxOf(o.outline);
    out.islands.push({sign, area: s, width, box, at: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], rings: orient(o)});
  }
  out.islands.sort((x, y) => y.area - x.area);
  out.xor = out.missing + out.extra;
  out.maxDeviation = maxDeviation(a, b, DEVIATION_CAP, skip);
  return out;
}
module.exports = {load, repour, compare, areaWithin, settings: P.settings, DEVIATION_CAP};
