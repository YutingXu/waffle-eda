"use strict";
// STEP round trip for ECAD-MCAD work (docs/mcad.md): an enclosure STEP as a reference body, 3D
// clearance between the components and the enclosure, a board outline and keep-outs derived from
// an enclosure face or section, and a board outline (with holes and cutouts) read back from a STEP
// that a mechanical engineer edited, as reviewable proposals (AtriumMCAD).
//
// STEP files are untrusted: AtriumSTEPImport's bounded reader and tessellator does the reading
// (its caps apply), and nothing referenced by the file is fetched. Coordinates are the STEP
// export's (step-export.js): mm, Y up (a Waffle point (x, y) is (x, -y)), the board bottom at
// z = 0 and its top at z = thickness. An enclosure can be offset and turned about Z to fit.
//
//   AtriumMCADStep.enclosure(text, {name, offset:[x,y,z], rz})  -> enclosure {name, digest, tris, bbox, levels, triangles, notes}
//   AtriumMCADStep.place(enc, {offset, rz})                       -> the same enclosure placed again
//   AtriumMCADStep.clearance(project, doc, enc, {gap})            -> {findings:[{id, ref, distance, kind, at3d}], stats}
//   AtriumMCADStep.levels(enc)                                    -> horizontal face levels [{z, up, area}]
//   AtriumMCADStep.faceLoops(enc, z, {up}) / section(enc, z)      -> closed loops (Y up)
//   AtriumMCADStep.derive(project, doc, enc, {mode, z, up, inset}) -> design (board outline, keep-outs) for AtriumMCAD
//   AtriumMCADStep.boardFromStep(text)                             -> design (board outline, cutouts, holes) for AtriumMCAD
//   AtriumMCADStep.sceneParts(doc)                                 -> 3D view parts for the placed enclosure (view3d.js)
globalThis.AtriumMCADStep = (() => {
  const G = globalThis, D2R = Math.PI / 180, Q = 1e3;
  const now = () => G.performance?.now ? performance.now() : Date.now();
  const SI = () => G.AtriumSTEPImport || (() => { throw Error("Reading STEP needs the STEP reader (step-import.js)."); })();
  function digest(text) {
    let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519) + (b >>> 13); }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }

  // ---------------------------------------------------------------- enclosure
  function trianglesOf(res) {
    let n = 0;
    for (const p of res.parts) n += p.indices.length / 3;
    const T = new Float64Array(n * 9);
    let k = 0;
    for (const p of res.parts) {
      const P = p.positions, I = p.indices;
      for (let i = 0; i < I.length; i++) { const v = I[i] * 3; T[k++] = P[v]; T[k++] = P[v + 1]; T[k++] = P[v + 2]; }
    }
    return T;
  }
  function enclosure(text, o = {}) {
    const t0 = now(), res = typeof text === "string" ? SI().tessellate(text) : text;
    if (res.error || !res.parts?.length) throw Error("The enclosure STEP could not be read" + (res.error || res.notes?.[0] ? ": " + (res.error || res.notes[0]) : "."));
    const enc = {name: String(o.name || "Enclosure"), digest: typeof text === "string" ? digest(text) : o.digest || "", bytes: typeof text === "string" ? text.length : 0,
      raw: trianglesOf(res), parts: res.parts, stats: res.stats, notes: res.notes || [], ms: 0};
    place(enc, o);
    enc.ms = Math.round(now() - t0);
    return enc;
  }
  // Rotate about Z (degrees) then translate; rebuilds the triangle list, its bounds and the grid.
  function place(enc, o = {}) {
    const off = Array.isArray(o.offset) ? o.offset.map(v => +v || 0) : enc.offset || [0, 0, 0], rz = Number.isFinite(+o.rz) ? +o.rz : enc.rz || 0;
    const c = Math.cos(rz * D2R), s = Math.sin(rz * D2R), R = enc.raw, T = new Float64Array(R.length), b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < R.length; i += 3) {
      const x = R[i] * c - R[i + 1] * s + off[0], y = R[i] * s + R[i + 1] * c + off[1], z = R[i + 2] + off[2];
      T[i] = x; T[i + 1] = y; T[i + 2] = z;
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z; if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
    }
    Object.assign(enc, {offset: off, rz, tris: T, bbox: b, triangles: T.length / 9, grid: null, matrix: [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, off[0], off[1], off[2], 1]});
    return enc;
  }
  const CELL = 4;
  function gridOf(enc) {
    if (enc.grid) return enc.grid;
    const T = enc.tris, g = new Map(), K = (x, y, z) => x + "," + y + "," + z;
    for (let t = 0; t < T.length; t += 9) {
      const x0 = Math.floor(Math.min(T[t], T[t + 3], T[t + 6]) / CELL), x1 = Math.floor(Math.max(T[t], T[t + 3], T[t + 6]) / CELL);
      const y0 = Math.floor(Math.min(T[t + 1], T[t + 4], T[t + 7]) / CELL), y1 = Math.floor(Math.max(T[t + 1], T[t + 4], T[t + 7]) / CELL);
      const z0 = Math.floor(Math.min(T[t + 2], T[t + 5], T[t + 8]) / CELL), z1 = Math.floor(Math.max(T[t + 2], T[t + 5], T[t + 8]) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) { (g.get("big") || g.set("big", []).get("big")).push(t); continue; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const k = K(x, y, z), l = g.get(k); if (l) l.push(t); else g.set(k, [t]); }
    }
    return enc.grid = g;
  }

  // ---------------------------------------------------------------- clearance
  // Each component body (generated outline prism or model box, as Component Clearance uses) against
  // the enclosure's triangles: GJK distance between the body's convex hull and each nearby triangle.
  function clearance(project, doc, enc, o = {}) {
    const C = G.AtriumCollision3D || (() => { throw Error("Enclosure clearance needs the 3D collision module (collision-3d.js)."); })();
    const t0 = now(), gap = Math.max(0, +o.gap || 0), defs = new Map((project.library || []).map(d => [d.id, d]));
    const B = C.bodies(doc, defs, {project, variant: o.variant}), grid = gridOf(enc), T = enc.tris, findings = [], stats = {bodies: B.list.length, tests: 0, triangles: enc.triangles};
    for (const b of B.list) {
      if (b.box[3] + gap < enc.bbox[0] || b.box[0] - gap > enc.bbox[3] || b.box[4] + gap < enc.bbox[1] || b.box[1] - gap > enc.bbox[4] || b.box[5] + gap < enc.bbox[2] || b.box[2] - gap > enc.bbox[5]) continue;
      const hull = C.hull(b), seen = new Set();
      let best = Infinity, at = null;
      const cand = [...(grid.get("big") || [])];
      for (let x = Math.floor((b.box[0] - gap) / CELL); x <= Math.floor((b.box[3] + gap) / CELL); x++)
        for (let y = Math.floor((b.box[1] - gap) / CELL); y <= Math.floor((b.box[4] + gap) / CELL); y++)
          for (let z = Math.floor((b.box[2] - gap) / CELL); z <= Math.floor((b.box[5] + gap) / CELL); z++) for (const t of grid.get(x + "," + y + "," + z) || []) cand.push(t);
      for (const t of cand) {
        if (seen.has(t)) continue; seen.add(t);
        const tx0 = Math.min(T[t], T[t + 3], T[t + 6]), tx1 = Math.max(T[t], T[t + 3], T[t + 6]), ty0 = Math.min(T[t + 1], T[t + 4], T[t + 7]), ty1 = Math.max(T[t + 1], T[t + 4], T[t + 7]);
        const tz0 = Math.min(T[t + 2], T[t + 5], T[t + 8]), tz1 = Math.max(T[t + 2], T[t + 5], T[t + 8]);
        if (tx0 > b.box[3] + gap || tx1 < b.box[0] - gap || ty0 > b.box[4] + gap || ty1 < b.box[1] - gap || tz0 > b.box[5] + gap || tz1 < b.box[2] - gap) continue;
        stats.tests++;
        const d = C.gjk(hull, [T[t], T[t + 1], T[t + 2], T[t + 3], T[t + 4], T[t + 5], T[t + 6], T[t + 7], T[t + 8]]);
        if (d < best) { best = d; at = [(T[t] + T[t + 3] + T[t + 6]) / 3, (T[t + 1] + T[t + 4] + T[t + 7]) / 3, (T[t + 2] + T[t + 5] + T[t + 8]) / 3]; if (d <= 1e-9) break; }
      }
      // A body wholly inside an enclosure wall (no triangle touches it) is found by a ray test.
      const centre = [(b.box[0] + b.box[3]) / 2, (b.box[1] + b.box[4]) / 2, (b.box[2] + b.box[5]) / 2];
      if (best > 1e-9 && insideMesh(enc, centre)) { best = 0; at = centre; }
      if (best < gap - 1e-9 || best <= 1e-9) findings.push({id: b.id, ref: b.ref, side: b.side, distance: Math.round(best * 1e4) / 1e4, required: gap, kind: best <= 1e-9 ? "collision" : "clearance", at3d: at, xy: b.xy});
    }
    findings.sort((a, b) => a.distance - b.distance || (a.ref < b.ref ? -1 : 1));
    stats.ms = Math.round((now() - t0) * 10) / 10;
    return {findings, stats, gap};
  }
  // Ray along +X: an odd number of crossings means inside the (closed) enclosure solid.
  function insideMesh(enc, p) {
    const T = enc.tris;
    if (p[0] < enc.bbox[0] || p[0] > enc.bbox[3] || p[1] < enc.bbox[1] || p[1] > enc.bbox[4] || p[2] < enc.bbox[2] || p[2] > enc.bbox[5]) return false;
    let n = 0;
    const y = p[1] + 1.234e-7, z = p[2] + 2.345e-7;
    for (let t = 0; t < T.length; t += 9) {
      const ay = T[t + 1], by = T[t + 4], cy = T[t + 7], az = T[t + 2], bz = T[t + 5], cz = T[t + 8];
      if ((ay > y && by > y && cy > y) || (ay < y && by < y && cy < y) || (az > z && bz > z && cz > z) || (az < z && bz < z && cz < z)) continue;
      // Barycentric in the (y, z) projection.
      const d = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
      if (Math.abs(d) < 1e-14) continue;
      const u = ((y - ay) * (cz - az) - (cy - ay) * (z - az)) / d, v = ((by - ay) * (z - az) - (y - ay) * (bz - az)) / d;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const x = T[t] + u * (T[t + 3] - T[t]) + v * (T[t + 6] - T[t]);
      if (x > p[0]) n++;
    }
    return n % 2 === 1;
  }

  // ---------------------------------------------------------------- faces and sections
  const key2 = (x, y) => Math.round(x * Q) + "," + Math.round(y * Q);
  // Chain directed segments [[ax, ay, bx, by], ...] into closed loops (Y up).
  function chain(segs) {
    const from = new Map();
    for (const s of segs) { const k = key2(s[0], s[1]); const l = from.get(k); if (l) l.push(s); else from.set(k, [s]); }
    const used = new Set(), loops = [];
    for (const s of segs) {
      if (used.has(s)) continue;
      const loop = [[s[0], s[1]]];
      let cur = s, guard = 0;
      used.add(s);
      while (guard++ < segs.length + 2) {
        const k = key2(cur[2], cur[3]);
        if (k === key2(loop[0][0], loop[0][1])) break;
        loop.push([cur[2], cur[3]]);
        const next = (from.get(k) || []).find(x => !used.has(x));
        if (!next) { loop.length = 0; break; }
        used.add(next); cur = next;
      }
      if (loop.length >= 3) loops.push(simplify(loop));
    }
    return loops.filter(l => l.length >= 3);
  }
  // Drop collinear vertices (tessellation splits straight edges).
  function simplify(P) {
    const out = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[(i + P.length - 1) % P.length], b = P[i], c = P[(i + 1) % P.length];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) > 1e-6 * Math.max(1, Math.hypot(c[0] - a[0], c[1] - a[1]))) out.push([Math.round(b[0] * 1e4) / 1e4, Math.round(b[1] * 1e4) / 1e4]);
    }
    return out;
  }
  const area = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  function inside(P, x, y) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  function normalOf(T, t) {
    const ux = T[t + 3] - T[t], uy = T[t + 4] - T[t + 1], uz = T[t + 5] - T[t + 2], vx = T[t + 6] - T[t], vy = T[t + 7] - T[t + 1], vz = T[t + 8] - T[t + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0], n[1], n[2]);
    return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l, l / 2] : null;
  }
  // Horizontal face levels: z, facing up or down, and their total area (largest first).
  function levels(enc) {
    const T = enc.tris, by = new Map();
    for (let t = 0; t < T.length; t += 9) {
      const n = normalOf(T, t);
      if (!n || Math.abs(n[2]) < 0.9999) continue;
      const z = Math.round((T[t + 2] + T[t + 5] + T[t + 8]) / 3 * 1e3) / 1e3, up = n[2] > 0, k = z + (up ? "u" : "d");
      const e = by.get(k);
      if (e) e.area += n[3]; else by.set(k, {z, up, area: n[3]});
    }
    return [...by.values()].map(l => ({...l, area: Math.round(l.area * 100) / 100})).sort((a, b) => b.area - a.area);
  }
  function faceLoops(enc, z, o = {}) {
    const T = enc.tris, segs = [], count = new Map(), up = o.up !== false;
    const ek = (ax, ay, bx, by) => { const a = key2(ax, ay), b = key2(bx, by); return a < b ? a + "|" + b : b + "|" + a; };
    const tri = [];
    for (let t = 0; t < T.length; t += 9) {
      const n = normalOf(T, t);
      if (!n || Math.abs(n[2]) < 0.9999 || (n[2] > 0) !== up) continue;
      if (Math.abs(T[t + 2] - z) > 2e-3 || Math.abs(T[t + 5] - z) > 2e-3 || Math.abs(T[t + 8] - z) > 2e-3) continue;
      tri.push(t);
      for (let e = 0; e < 3; e++) { const a = t + e * 3, b = t + ((e + 1) % 3) * 3, k = ek(T[a], T[a + 1], T[b], T[b + 1]); count.set(k, (count.get(k) || 0) + 1); }
    }
    for (const t of tri) for (let e = 0; e < 3; e++) {
      const a = t + e * 3, b = t + ((e + 1) % 3) * 3;
      if (count.get(ek(T[a], T[a + 1], T[b], T[b + 1])) === 1) segs.push(up ? [T[a], T[a + 1], T[b], T[b + 1]] : [T[b], T[b + 1], T[a], T[a + 1]]);
    }
    return chain(segs);
  }
  function section(enc, z) {
    const T = enc.tris, segs = [], zz = z + 1.37e-7;
    for (let t = 0; t < T.length; t += 9) {
      const pts = [];
      for (let e = 0; e < 3; e++) {
        const a = t + e * 3, b = t + ((e + 1) % 3) * 3, da = T[a + 2] - zz, db = T[b + 2] - zz;
        if ((da < 0) !== (db < 0)) { const k = da / (da - db); pts.push([T[a] + k * (T[b] - T[a]), T[a + 1] + k * (T[b + 1] - T[a + 1])]); }
      }
      if (pts.length !== 2) continue;
      const n = normalOf(T, t);
      if (!n) continue;
      // Orient so solid material is on the left (the outward normal points right of the segment).
      const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
      if (dy * n[0] - dx * n[1] > 0) segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
      else segs.push([pts[1][0], pts[1][1], pts[0][0], pts[0][1]]);
    }
    return chain(segs);
  }
  // Simple polygon offset (miter, clamped): positive grows a counter-clockwise loop.
  function offsetPoly(P, d) {
    if (!d) return P;
    const s = area(P) > 0 ? 1 : -1, n = P.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = P[(i + n - 1) % n], b = P[i], c = P[(i + 1) % n];
      const n1 = norm2([b[1] - a[1], a[0] - b[0]]), n2 = norm2([c[1] - b[1], b[0] - c[0]]), m = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
      const k = Math.min(4, 1 / Math.max(0.25, m[0] * n1[0] + m[1] * n1[1]));
      out.push([b[0] + m[0] * d * s * k, b[1] + m[1] * d * s * k]);
    }
    return out;
  }
  const norm2 = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const down = P => P.map(p => [Math.round(p[0] * 1e4) / 1e4, Math.round(-p[1] * 1e4) / 1e4 || 0]);

  // A design from an enclosure: mode "section" (a cut at z: the loop round the board is the outline,
  // islands inside it are keep-outs) or "face" (the horizontal faces at z: downward faces above the
  // board become keep-outs whose height is their distance above the board top; with outline, the
  // face's boundary round the board becomes the outline). inset: the outline is pulled in by this.
  function derive(project, doc, enc, o = {}) {
    const MC = G.AtriumMCAD, snap = MC.snapshot(project, doc), t = snap.board.thickness;
    const P = snap.board.outline.map(p => [p[0], -p[1]]), c = P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length], [0, 0]);
    const z = Number.isFinite(+o.z) ? +o.z : t + 0.5;
    const loops = o.mode === "face" ? faceLoops(enc, z, {up: o.up}) : section(enc, z);
    const design = {source: "enclosure", kind: "baseline", full: false, parts: [], holes: [], keepouts: [], removed: [], responses: [], notes: [], board: null,
      header: {system: "STEP", creator: enc.name, transaction: (o.mode === "face" ? "Face" : "Section") + " at z = " + z}};
    if (!loops.length) { design.notes.push("Nothing of the enclosure lies at z = " + z + " mm."); return design; }
    // The boundary: the smallest loop that contains the board's centre (an inner wall).
    const around = loops.filter(l => inside(l, c[0], c[1])).sort((a, b) => Math.abs(area(a)) - Math.abs(area(b)));
    const wall = around[0];
    if (o.outline !== false && wall && o.mode !== "face") {
      let w = wall;
      if (area(w) < 0) w = w.slice().reverse();
      design.board = {ident: null, outline: down(offsetPoly(w, -(+o.inset || 0))), cutouts: null};
    } else if (o.outline && wall && o.mode === "face") {
      let w = wall; if (area(w) < 0) w = w.slice().reverse();
      design.board = {ident: null, outline: down(offsetPoly(w, -(+o.inset || 0))), cutouts: null};
    }
    for (const l of loops) {
      if (l === wall) continue;
      if (Math.abs(area(l)) < 0.01) continue;
      const q = l[0];
      if (wall && !inside(wall, q[0], q[1])) continue;
      if (o.mode === "face") {
        const h = Math.round((z - t) * 1e4) / 1e4;
        if (h < 0) continue;
        design.keepouts.push({ident: null, kind: "component", points: down(l), z0: 0, z1: h});
      } else design.keepouts.push({ident: null, kind: "component", points: down(l), z0: 0, z1: null});
    }
    if (o.mode === "face" && wall && !o.outline) {
      const h = Math.round((z - t) * 1e4) / 1e4;
      if (h >= 0 && !(design.keepouts.length)) design.keepouts.push({ident: null, kind: "keepin", points: down(wall), z0: 0, z1: h});
    }
    return design;
  }

  // ---------------------------------------------------------------- board outline from a STEP
  // The largest upward-facing horizontal level is the board top; a section through the board gives
  // the outline; round inner loops up to 6.5 mm are holes, the other inner loops are cutouts.
  function boardFromStep(text, o = {}) {
    const res = typeof text === "string" ? SI().tessellate(text) : text;
    if (res.error || !res.parts?.length) throw Error("The STEP file could not be read" + (res.error ? ": " + res.error : "."));
    const enc = {name: "board", raw: trianglesOf(res)};
    place(enc, {});
    const lv = levels(enc).filter(l => l.up);
    if (!lv.length) throw Error("The STEP has no horizontal faces: it does not look like a board.");
    const top = o.z != null ? lv.find(l => Math.abs(l.z - o.z) < 1e-3) || lv[0] : lv[0];
    // The board's own bottom: the largest downward level under the top. The outline is a section
    // half way through the board (robust where the top face's triangulation bridges its holes).
    const under = levels(enc).filter(l => !l.up && l.z < top.z - 1e-3)[0], bottom = under ? under.z : top.z - 1.6;
    const loops = section(enc, (top.z + bottom) / 2).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    const outer = loops[0], design = {source: "step", kind: "baseline", full: true, scope: {holes: true, keepouts: false}, compare: {pinHoles: true, vias: true, tolerance: 0.03, ignorePlating: true}, parts: [], holes: [], keepouts: [], removed: [], responses: [], notes: [],
      header: {system: "STEP", creator: "", transaction: "Board top at z = " + top.z}, board: null};
    if (!outer) throw Error("The board top face has no closed outline.");
    const cutouts = [];
    for (const l of loops.slice(1)) {
      if (!inside(outer, l[0][0], l[0][1])) continue;
      const fit = circleFit(l);
      if (fit && fit.d <= (o.maxHole ?? 6.5)) design.holes.push({ident: null, x: Math.round(fit.c[0] * 1e4) / 1e4, y: Math.round(-fit.c[1] * 1e4) / 1e4, d: Math.round(fit.d * 1e3) / 1e3, plated: false});
      else cutouts.push(down(l));
    }
    let w = outer; if (area(w) < 0) w = w.slice().reverse();
    design.board = {ident: null, outline: down(w), cutouts, thickness: Math.round((top.z - bottom) * 1e4) / 1e4};
    return design;
  }
  function circleFit(P) {
    if (P.length < 6) return null;
    const c = P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length], [0, 0]);
    const r = P.map(p => Math.hypot(p[0] - c[0], p[1] - c[1])), m = r.reduce((s, v) => s + v, 0) / r.length;
    return r.every(v => Math.abs(v - m) <= Math.max(0.02, m * 0.02)) ? {c, d: 2 * m} : null;
  }

  // ---------------------------------------------------------------- 3D view
  const loaded = new Map(); // board doc id -> enclosure (with its meshes) in this session
  function sceneParts(doc) {
    const enc = doc && loaded.get(doc.id);
    if (!enc || enc.hidden) return [];
    const M = new Float32Array(enc.matrix);
    return enc.parts.map((g, i) => ({kind: "enclosure", name: enc.name + " " + (i + 1), color: [0.62, 0.66, 0.72], matrix: M, positions: g.positions, normals: g.normals, indices: g.indices}));
  }
  function attach(doc, enc) { if (enc) loaded.set(doc.id, enc); else loaded.delete(doc.id); }
  const current = doc => doc ? loaded.get(doc.id) || null : null;
  return Object.freeze({digest, enclosure, place, clearance, insideMesh, levels, faceLoops, section, derive, boardFromStep, sceneParts, attach, current, offsetPoly});
})();
