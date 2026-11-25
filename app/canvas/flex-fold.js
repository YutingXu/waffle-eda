"use strict";
// Rigid-flex folding for the 3D view (view3d.js; loaded lazily with it).
//
// Bend lines (doc.stackup.bends, rigid-flex.js) fold the board about their axis. The
// fixed part of the board is the largest rigid region (or the largest region when every
// region is flex). Each bend folds the side away from the fixed part; a positive angle
// lifts it toward the top side, a negative one toward the bottom. Bends fold in their fold
// order (bend.order, 1 first; bends without an order fold together with the first group),
// so an animation from t = 0 (flat) to t = 1 (folded) plays the fold sequence.
//
// Geometry. The bend zone is the strip of the bend's width across the line (width 0 = the
// neutral-axis arc length, radius x angle). Inside the zone the board wraps a cylinder whose
// neutral-axis arc length equals the zone width, so the flex neither stretches nor shrinks;
// past the zone everything moves rigidly. A point at distance s across the line (toward the
// moving side) and height z' above the neutral axis maps, for a fold toward the top, to
//   c = clamp(s + w/2, 0, w), phi = c / Re (Re = w / |angle|), r = Re - z'
//   s' = -w/2 + r sin(phi) + (s + w/2 - c) cos(phi),  z'' = Re - r cos(phi) + (s + w/2 - c) sin(phi)
// which is a translation by -c across the line followed by a rotation by phi about the
// centre of curvature (s = -w/2, z' = Re). Bends further from the fixed part are applied
// first, in flat coordinates, then the nearer bends move the result rigidly.
//
// Which bends move a point: the regions are cut along every bend line; the pieces form a
// graph (shared edges), searched from the fixed piece. Crossing a bend line adds that bend
// to the chain of the piece reached. A bend line that does not cut across its region (it
// ends inside the flex) cannot fold and is reported in plan().notes.
//
// Coordinates follow AtriumSTEP.model/mesh: mm, Y up (a board point (x, y) is (x, -y)),
// z up with the board bottom at z = 0 and the top at the board thickness.
//
//   AtriumFlexFold.hasBends(doc)                 -> bends exist
//   AtriumFlexFold.plan(doc, defs, {thickness})  -> {bends, pieces, fixed, groups, notes}
//   AtriumFlexFold.fold(parts, {doc, defs|project, thickness, t}) -> mesh parts, folded
//   AtriumFlexFold.matrixAt(plan, [x, y], t)     -> column-major 4x4 for a board point
//   AtriumFlexFold.pointAt(plan, [x, y, z], t)   -> folded model point
globalThis.AtriumFlexFold = (() => {
  const DEG = Math.PI / 180, EPS = 1e-9;
  const RF = () => globalThis.AtriumRigidFlex;
  const hasBends = doc => Array.isArray(doc?.stackup?.bends) && doc.stackup.bends.length > 0;

  // ---------------------------------------------------------------- 2D helpers (board coordinates, Y down)
  const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
  function centroid(P) {
    let a = 0, x = 0, y = 0;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const f = P[j][0] * P[i][1] - P[i][0] * P[j][1];
      a += f; x += (P[j][0] + P[i][0]) * f; y += (P[j][1] + P[i][1]) * f;
    }
    if (Math.abs(a) < EPS) return P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length], [0, 0]);
    return [x / (3 * a), y / (3 * a)];
  }
  function edgeDist(p, poly) {
    const G = RF().geometry;
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, G.segDist(p, poly[j], poly[i]));
    return d;
  }
  // Length two segments share on one line (both on it, overlapping).
  function sharedLength(a, b, c, d) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) return 0;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-u[1], u[0]], tol = 1e-5;
    if (Math.abs(dot2(sub2(c, a), n)) > tol || Math.abs(dot2(sub2(d, a), n)) > tol) return 0;
    const t0 = dot2(sub2(c, a), u), t1 = dot2(sub2(d, a), u);
    return Math.max(0, Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
  }

  // ---------------------------------------------------------------- plan
  // thickness: the board (master stack) thickness, so z in the resolved stack (measured down
  // from the top) becomes z up from the bottom.
  function plan(doc, defs, opts = {}) {
    const R = RF().regionsResolved(doc, defs), notes = [];
    const T = opts.thickness > 0 ? opts.thickness : (() => {try {return globalThis.AtriumStackup.thickness(doc, defs);} catch {return 1.6;}})();
    const G = RF().geometry;
    const bends = R.bends.map((b, i) => {
      const raw = (doc.stackup?.bends || []).find(x => x.id === b.id) || {};
      return {...b, index:i, order:Number.isInteger(raw.order) && raw.order > 0 ? raw.order : 0, folds:false, sign:1, parents:new Set(), depth:Infinity, zUp:T - b.neutralZ};
    });
    // Cut every region along every bend line (extended a little past its ends, so a line
    // drawn to the board edge still crosses it).
    let pieces = [];
    for (const g of R.regions) {
      let list = [g.points];
      for (const b of bends) {
        const d = b.axis.direction, e = 0.05, a = [b.a[0] - d[0] * e, b.a[1] - d[1] * e], c = [b.b[0] + d[0] * e, b.b[1] + d[1] * e];
        list = list.flatMap(P => RF().splitPolygon(P, a, c));
      }
      for (const P of list) pieces.push({region:g.id, rigid:!g.flex, points:P, box:G.box(P), area:Math.abs(G.area(P)), centre:centroid(P), chain:null, links:[]});
    }
    pieces = pieces.filter(p => p.area > 1e-9);
    // Adjacency: shared edges. An edge on a bend line (within its extent) links across it.
    const onBend = (p, q) => {
      for (const b of bends) {
        const n = b.axis.normal, d = b.axis.direction;
        if (Math.abs(dot2(sub2(p, b.a), n)) > 1e-5 || Math.abs(dot2(sub2(q, b.a), n)) > 1e-5) continue;
        const t = [dot2(sub2(p, b.a), d), dot2(sub2(q, b.a), d)], m = (t[0] + t[1]) / 2;
        if (m >= -0.06 && m <= b.axis.length + 0.06) return b;
      }
      return null;
    };
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
      const A = pieces[i], B = pieces[j];
      if (!(A.box[0] <= B.box[2] + 1e-6 && B.box[0] <= A.box[2] + 1e-6 && A.box[1] <= B.box[3] + 1e-6 && B.box[1] <= A.box[3] + 1e-6)) continue;
      let link = null;
      for (let a = 0, a0 = A.points.length - 1; a < A.points.length && !link; a0 = a++) for (let k = 0, k0 = B.points.length - 1; k < B.points.length; k0 = k++) {
        if (sharedLength(A.points[a0], A.points[a], B.points[k0], B.points[k]) > 1e-4) {link = {bend:onBend(A.points[a0], A.points[a])}; break;}
      }
      if (link) {A.links.push({to:B, bend:link.bend}); B.links.push({to:A, bend:link.bend});}
    }
    // The fixed piece: the largest piece of the largest rigid region (else of any region).
    const rigid = R.regions.filter(g => !g.flex), pool = rigid.length ? rigid : R.regions;
    const fixedRegion = pool.slice().sort((a, b) => b.area - a.area)[0];
    const fixed = pieces.filter(p => p.region === fixedRegion?.id).sort((a, b) => b.area - a.area)[0] || pieces[0];
    if (fixed) {
      fixed.chain = [];
      const queue = [fixed];
      while (queue.length) {
        const p = queue.shift();
        for (const {to, bend} of p.links) {
          if (to.chain) {
            // Reached both sides of a bend without crossing it: the line does not cut through.
            if (bend && !p.chain.includes(bend) && !to.chain.includes(bend)) bend.loop = true;
            continue;
          }
          if (bend && !p.chain.includes(bend)) {
            const side = Math.sign(dot2(sub2(to.centre, bend.a), bend.axis.normal)) || 1;
            if (!bend.folds) {bend.folds = true; bend.sign = side; bend.depth = p.chain.length;}
            bend.parents.add(p);
            to.chain = [...p.chain, bend];
          } else to.chain = p.chain.slice();
          queue.push(to);
        }
      }
    }
    for (const p of pieces) if (!p.chain) p.chain = [];
    for (const b of bends) {
      if (b.loop) {b.folds = false; notes.push(b.name + " does not cut across its flex region, so it cannot fold. Extend the bend line to the region edges.");}
      else if (!b.folds) notes.push(b.name + " is not on a path from the fixed region " + (fixedRegion?.name || "") + ", so it does not fold.");
      if (!b.region) notes.push(b.name + " lies outside every board region.");
    }
    for (const p of pieces) p.chain = p.chain.filter(b => b.folds);
    // Fold order: distinct orders ascending; bends without an order fold with the first group.
    const orders = [...new Set(bends.filter(b => b.folds).map(b => b.order || 0))].sort((a, b) => a - b);
    const first = orders.filter(o => o > 0);
    const groups = first.length ? first : [0];
    for (const b of bends) b.group = Math.max(0, groups.indexOf(b.order || 0) >= 0 ? groups.indexOf(b.order || 0) : 0);
    const piece = p => {
      for (const q of pieces) if (p[0] >= q.box[0] - 1e-6 && p[0] <= q.box[2] + 1e-6 && p[1] >= q.box[1] - 1e-6 && p[1] <= q.box[3] + 1e-6 && G.inside(p, q.points)) return q;
      let best = null, bd = Infinity;
      for (const q of pieces) {const d = edgeDist(p, q.points); if (d < bd) {bd = d; best = q;}}
      return best;
    };
    return {bends, pieces, fixed, fixedRegion:fixedRegion?.id || null, groups:groups.length, notes, thickness:T, piece};
  }

  // Bends acting on a board point, nearest the fixed part first: the piece's chain, plus a bend
  // whose zone starts on this piece (the root half of the zone).
  function chainAt(P, p) {
    const q = P.piece(p);
    if (!q) return [];
    const out = q.chain.slice();
    for (const b of P.bends) {
      if (!b.folds || out.includes(b) || !b.parents.has(q)) continue;
      const n = [b.axis.normal[0] * b.sign, b.axis.normal[1] * b.sign], s = dot2(sub2(p, b.a), n), u = dot2(sub2(p, b.a), b.axis.direction);
      if (s > -b.width / 2 - EPS && s <= EPS && u >= -b.width && u <= b.axis.length + b.width) out.push(b);
    }
    return out;
  }
  // Per-bend state at time t: fold fraction of the bend's group, signed angle, curvature.
  function stateOf(P, t) {
    const G = Math.max(1, P.groups), k = Math.max(0, Math.min(1, t));
    return P.bends.map(b => {
      const f = Math.max(0, Math.min(1, k * G - b.group)), theta = (b.angle || 0) * DEG * f;
      if (!b.folds || Math.abs(theta) < 1e-7 || !(b.width > 0)) return null;
      const n = [b.axis.normal[0] * b.sign, -b.axis.normal[1] * b.sign, 0], d = [b.axis.direction[0], -b.axis.direction[1], 0];
      const sg = Math.sign(theta), Re = b.width / Math.abs(theta), hw = b.width / 2;
      const o = [b.a[0], -b.a[1], b.zUp];
      // Rotation axis K = N x up, so rotating by +phi turns N toward +z.
      const K = [n[1], -n[0], 0];
      const C = [o[0] - n[0] * hw, o[1] - n[1] * hw, o[2] + sg * Re];
      return {b, n, d, K, C, o, sg, Re, hw, w:b.width, theta:Math.abs(theta), nFlat:[b.axis.normal[0] * b.sign, b.axis.normal[1] * b.sign]};
    });
  }
  // Rotation by angle a about unit axis K (Rodrigues), as a 3x3 row-major array.
  function rot(K, a) {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c, [x, y, z] = K;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  const apply3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  // Rigid motion of bend state st for a point at flat across-distance s: {R (3x3), c}.
  function motion(st, s) {
    const c = Math.max(0, Math.min(st.w, s + st.hw));
    return {c, R:rot(st.K, st.sg * c / st.Re)};
  }
  // Apply the motion to a point already moved by deeper bends.
  function movePoint(st, mo, p) {
    const q = [p[0] - st.n[0] * mo.c - st.C[0], p[1] - st.n[1] * mo.c - st.C[1], p[2] - st.C[2]], r = apply3(mo.R, q);
    return [r[0] + st.C[0], r[1] + st.C[1], r[2] + st.C[2]];
  }
  // The folded position of a model point (x, y up, z up) and the rotation applied to it.
  function pointAt(P, p, t, states = stateOf(P, t), chain = chainAt(P, [p[0], -p[1]])) {
    let out = [p[0], p[1], p[2]], Rm = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let i = chain.length - 1; i >= 0; i--) {
      const st = states[chain[i].index];
      if (!st) continue;
      const s = (p[0] - st.o[0]) * st.n[0] + (p[1] - st.o[1]) * st.n[1], mo = motion(st, s);
      out = movePoint(st, mo, out);
      Rm = mul3(mo.R, Rm);
    }
    return {p:out, R:Rm};
  }
  function mul3(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  }
  // Column-major 4x4 of the rigid fold motion at a board point (x, y in board coordinates,
  // Y down), evaluated on the neutral plane.
  function matrixAt(P, xy, t, states = stateOf(P, t)) {
    const chain = chainAt(P, xy), p = [xy[0], -xy[1], 0], f = pointAt(P, p, t, states, chain), R = f.R;
    const tx = f.p[0] - (R[0] * p[0] + R[1] * p[1] + R[2] * p[2]), ty = f.p[1] - (R[3] * p[0] + R[4] * p[1] + R[5] * p[2]), tz = f.p[2] - (R[6] * p[0] + R[7] * p[1] + R[8] * p[2]);
    return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, tx, ty, tz, 1];
  }
  function mul4(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }

  // ---------------------------------------------------------------- mesh slicing
  // Split triangles along vertical planes (normal nx, ny; offset d: nx*x + ny*y = d), so the
  // bend zones have vertices to curve. Only triangles whose box meets `box` are tested.
  function slice(mesh, planes) {
    let P = Array.from(mesh.positions), N = Array.from(mesh.normals), I = Array.from(mesh.indices);
    const vert = (a, b, t) => {
      const k = P.length / 3;
      for (let c = 0; c < 3; c++) {P.push(P[a * 3 + c] + (P[b * 3 + c] - P[a * 3 + c]) * t); N.push(N[a * 3 + c] + (N[b * 3 + c] - N[a * 3 + c]) * t);}
      return k;
    };
    for (const pl of planes) {
      const out = [];
      for (let i = 0; i < I.length; i += 3) {
        const v = [I[i], I[i + 1], I[i + 2]];
        if (pl.box) {
          let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
          for (const k of v) {lo = Math.min(lo, P[k * 3]); hi = Math.max(hi, P[k * 3]); lo2 = Math.min(lo2, P[k * 3 + 1]); hi2 = Math.max(hi2, P[k * 3 + 1]);}
          if (hi < pl.box[0] || lo > pl.box[2] || hi2 < pl.box[1] || lo2 > pl.box[3]) {out.push(...v); continue;}
        }
        const d = v.map(k => P[k * 3] * pl.nx + P[k * 3 + 1] * pl.ny - pl.d);
        const pos = d.map(x => x > 1e-7), neg = d.map(x => x < -1e-7);
        if (!(pos.some(Boolean) && neg.some(Boolean))) {out.push(...v); continue;}
        // Rotate so vertex 0 is alone on its side (or the zero vertex sits between).
        let r = 0;
        for (let k = 0; k < 3; k++) {const s = k => pos[k] ? 1 : neg[k] ? -1 : 0, a = s(k), b = s((k + 1) % 3), c = s((k + 2) % 3); if (a !== 0 && a !== b && a !== c) {r = k; break;}}
        const a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3], da = d[r], db = d[(r + 1) % 3], dc = d[(r + 2) % 3];
        if (Math.abs(db) <= 1e-7) {const m = vert(a, c, da / (da - dc)); out.push(a, b, m, b, c, m); continue;}
        if (Math.abs(dc) <= 1e-7) {const m = vert(a, b, da / (da - db)); out.push(a, m, c, m, b, c); continue;}
        const m1 = vert(a, b, da / (da - db)), m2 = vert(a, c, da / (da - dc));
        out.push(a, m1, m2, m1, b, c, m1, c, m2);
      }
      I = out;
    }
    return {positions:new Float32Array(P), normals:new Float32Array(N), indices:new Uint32Array(I)};
  }
  // Cut planes across each folding bend zone (every ~7.5° of the full angle, at least 6).
  function planesOf(P) {
    const out = [];
    for (const b of P.bends) {
      if (!b.folds || !(b.width > 0) || !b.angle) continue;
      const n = [b.axis.normal[0] * b.sign, -b.axis.normal[1] * b.sign], o = [b.a[0], -b.a[1]], count = Math.max(6, Math.ceil(Math.abs(b.angle) / 7.5));
      const ends = [b.a, b.b].map(p => [p[0], -p[1]]), m = b.width + 0.1;
      const box = [Math.min(ends[0][0], ends[1][0]) - m, Math.min(ends[0][1], ends[1][1]) - m, Math.max(ends[0][0], ends[1][0]) + m, Math.max(ends[0][1], ends[1][1]) + m];
      for (let k = 0; k <= count; k++) out.push({nx:n[0], ny:n[1], d:n[0] * o[0] + n[1] * o[1] - b.width / 2 + b.width * k / count, box});
    }
    return out;
  }

  // ---------------------------------------------------------------- fold mesh parts
  // Cache: plan and sliced geometry per (document stack signature, thickness, source array).
  const plans = new WeakMap(), sliced = new WeakMap();
  function planFor(doc, defs, thickness) {
    const sig = JSON.stringify(doc.stackup || null) + "|" + thickness + "|" + JSON.stringify(doc.outline || null);
    const hit = plans.get(doc);
    if (hit && hit.sig === sig) return hit.plan;
    const P = plan(doc, defs, {thickness});
    plans.set(doc, {sig, plan:P});
    return P;
  }
  // Flat geometry with the cut planes applied, and per-vertex bend chains (computed once).
  function prepared(part, P) {
    let c = sliced.get(part.positions);
    if (c && c.plan === P) return c;
    const planes = planesOf(P);
    const g = planes.length && part.kind !== "component" ? slice(part, planes) : {positions:part.positions, normals:part.normals, indices:part.indices};
    const n = g.positions.length / 3, chains = new Array(n), memo = new Map();
    for (let v = 0; v < n; v++) {
      const xy = [g.positions[v * 3], -g.positions[v * 3 + 1]], ch = chainAt(P, xy), key = ch.map(b => b.index).join(",");
      if (!memo.has(key)) memo.set(key, ch);
      chains[v] = memo.get(key);
    }
    c = {plan:P, g, chains};
    sliced.set(part.positions, c);
    return c;
  }
  // Returns new parts: board, stiffener, copper and silk meshes deformed per vertex,
  // components moved rigidly with the fold at their origin. t in [0, 1].
  function fold(parts, ctx) {
    const doc = ctx.doc, defs = ctx.defs || new Map((ctx.project?.library || []).map(d => [d.id, d]));
    if (!hasBends(doc)) return parts;
    const P = planFor(doc, defs, ctx.thickness), t = ctx.t == null ? 1 : +ctx.t;
    if (!(t > 0)) return parts;
    const states = stateOf(P, t);
    if (!states.some(Boolean)) return parts;
    return parts.map(part => {
      if (part.kind === "component") {
        const M = part.matrix, F = matrixAt(P, [M[12], -M[13]], t, states);
        return {...part, matrix:mul4(F, M)};
      }
      if (!part.positions?.length) return part;
      const {g, chains} = prepared(part, P), n = g.positions.length / 3;
      const pos = new Float32Array(g.positions.length), nor = new Float32Array(g.normals.length);
      for (let v = 0; v < n; v++) {
        const p = [g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]], ch = chains[v];
        if (!ch.length) {pos.set(p, v * 3); nor[v * 3] = g.normals[v * 3]; nor[v * 3 + 1] = g.normals[v * 3 + 1]; nor[v * 3 + 2] = g.normals[v * 3 + 2]; continue;}
        const f = pointAt(P, p, t, states, ch), q = apply3(f.R, [g.normals[v * 3], g.normals[v * 3 + 1], g.normals[v * 3 + 2]]);
        pos[v * 3] = f.p[0]; pos[v * 3 + 1] = f.p[1]; pos[v * 3 + 2] = f.p[2];
        nor[v * 3] = q[0]; nor[v * 3 + 1] = q[1]; nor[v * 3 + 2] = q[2];
      }
      return {...part, positions:pos, normals:nor, indices:g.indices};
    });
  }

  return Object.freeze({hasBends, plan, fold, matrixAt, pointAt, chainAt, stateOf, slice});
})();
