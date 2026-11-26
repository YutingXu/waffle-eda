"use strict";
// STEP (ISO 10303-21) component models for the 3D view: a bounded reader and tessellator,
// run in a worker. Loaded lazily (AtriumLazy "AtriumSTEPImport") by the 3D view and the
// footprint editor; the STEP export copies embedded models verbatim (step-export.js).
//
// STEP is untrusted input. The reader caps the text size, the entity count, the nesting depth
// of entity arguments, reference-chain depth, faces, loop points and triangles, and a worker
// watchdog stops a slow job. Nothing is evaluated: the text is tokenised into plain values.
//
// Supported (tessellated exactly, to a chord tolerance):
//   solids   MANIFOLD_SOLID_BREP, BREP_WITH_VOIDS, FACETED_BREP, SHELL_BASED_SURFACE_MODEL
//            (CLOSED_SHELL / OPEN_SHELL), under SHAPE_REPRESENTATION items, MAPPED_ITEM and
//            nested assemblies (REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION +
//            ITEM_DEFINED_TRANSFORMATION)
//   faces    ADVANCED_FACE / FACE_SURFACE on PLANE and CYLINDRICAL_SURFACE; FACE with POLY_LOOP
//   edges    LINE, CIRCLE, ELLIPSE, B_SPLINE_CURVE_WITH_KNOTS (rational too), POLYLINE,
//            TRIMMED_CURVE, SURFACE_CURVE / SEAM_CURVE (their 3D curve)
//   colours  STYLED_ITEM -> COLOUR_RGB on solids and faces
//   units    millimetre, metre, inch
// Approximated: faces on any other surface (B-spline, cone, sphere, torus, revolution ...) are
// drawn as their boundary polygon, triangulated on its best-fit plane; the result counts them.
// When nothing can be tessellated the caller falls back to the model's bounding box.
//
//   AtriumSTEPImport.LIMITS
//   AtriumSTEPImport.tessellate(text, opts)  -> result (synchronous, this thread)
//   AtriumSTEPImport.load(text, opts)        -> Promise<result> (worker when possible, cached)
//   AtriumSTEPImport.cached(text)            -> result or null
//   AtriumSTEPImport.ensure(text)            -> result (synchronous, cached; for DRC)
//   AtriumSTEPImport.summary(result)         -> one line for the UI
// result: {parts:[{color:[r,g,b], positions, normals, indices}], bbox:[x0,y0,z0,x1,y1,z1] (mm),
//          stats:{entities, solids, faces, planar, cylindrical, faceted, approximated, skipped, triangles, ms},
//          notes:[...]}
globalThis.AtriumSTEPImport = (() => {
  // The core is self-contained (no outer references) so it can be sent to a worker as text.
  function STEPCore() {
    const LIMITS = {bytes: 32 * 1048576, entities: 400000, depth: 32, refDepth: 24, faces: 60000, loopPoints: 20000, curvePoints: 256, triangles: 1500000};
    const TAU = Math.PI * 2;
    class Limit extends Error {}

    // ---------------------------------------------------------------------------
    // Polygon-with-holes triangulation: y-monotone decomposition (sweep line),
    // then the stack algorithm per monotone piece. O(n log n), no Steiner points.
    // rings: arrays of [x0,y0,x1,y1,...] with the interior on the left of every
    // ring (outer counter-clockwise, holes clockwise). Returns a Uint32Array of
    // counter-clockwise triangles indexing the concatenated ring points.
    class TriangulationError extends Error {}
    function triangulate(rings, verify = false) {
      let N = 0;
      for (const r of rings) N += r.length >> 1;
      const X = new Float64Array(N), Y = new Float64Array(N), prev = new Int32Array(N), next = new Int32Array(N);
      let k = 0;
      for (const r of rings) {
        const n = r.length >> 1, s = k;
        for (let i = 0; i < n; i++, k++) { X[k] = r[2 * i]; Y[k] = r[2 * i + 1]; prev[k] = s + (i + n - 1) % n; next[k] = s + (i + 1) % n; }
      }
      // A shear makes equal heights distinct without changing connectivity or orientation.
      const SH = 1.3712e-7, YS = new Float64Array(N);
      for (let i = 0; i < N; i++) YS[i] = Y[i] + SH * X[i];
      const above = (a, b) => YS[a] > YS[b] || (YS[a] === YS[b] && X[a] < X[b]);
      const order = new Int32Array(N);
      for (let i = 0; i < N; i++) order[i] = i;
      order.sort((a, b) => YS[b] - YS[a] || X[a] - X[b]);
      const xAt = (e, y) => { const a = e, b = next[e], ya = YS[a], yb = YS[b]; if (ya === yb) return Math.max(X[a], X[b]); return X[a] + (X[b] - X[a]) * (y - ya) / (yb - ya); };
      const T = [], helper = new Int32Array(N).fill(-1), isMerge = new Uint8Array(N);
      const diag = [];
      const leftOf = v => { // index in T of the edge directly left of v
        const y = YS[v], x = X[v];
        let lo = 0, hi = T.length - 1, best = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (xAt(T[m], y) < x) { best = m; lo = m + 1; } else hi = m - 1; }
        return best;
      };
      const insert = (e, v) => { const y = YS[v], x = X[v]; let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (xAt(T[m], y) < x) lo = m + 1; else hi = m; } T.splice(lo, 0, e); };
      const remove = e => { const i = T.lastIndexOf(e); if (i >= 0) T.splice(i, 1); };
      for (let oi = 0; oi < N; oi++) {
        const v = order[oi], p = prev[v], n = next[v];
        const pa = above(p, v), na = above(n, v);
        const cross = (X[v] - X[p]) * (YS[n] - YS[v]) - (YS[v] - YS[p]) * (X[n] - X[v]);
        if (!pa && !na) {
          if (cross > 0) { insert(v, v); helper[v] = v; } // start
          else { // split
            const j = leftOf(v);
            if (j >= 0) { const e = T[j]; diag.push(v, helper[e]); helper[e] = v; }
            insert(v, v); helper[v] = v;
          }
        } else if (pa && na) {
          if (helper[p] >= 0 && isMerge[helper[p]]) diag.push(v, helper[p]);
          remove(p);
          if (cross <= 0) { // merge
            isMerge[v] = 1;
            const j = leftOf(v);
            if (j >= 0) { const e = T[j]; if (isMerge[helper[e]]) diag.push(v, helper[e]); helper[e] = v; }
          }
        } else if (pa) { // regular, interior to the right
          if (helper[p] >= 0 && isMerge[helper[p]]) diag.push(v, helper[p]);
          remove(p); insert(v, v); helper[v] = v;
        } else { // regular, interior to the left
          const j = leftOf(v);
          if (j >= 0) { const e = T[j]; if (isMerge[helper[e]]) diag.push(v, helper[e]); helper[e] = v; }
        }
      }
      // Half-edge faces. Each vertex has its boundary edge plus diagonals.
      const out = [];
      const extra = new Map();
      for (let i = 0; i < diag.length; i += 2) {
        const a = diag[i], b = diag[i + 1];
        if (a === b) continue;
        (extra.get(a) || extra.set(a, []).get(a)).push(b);
        (extra.get(b) || extra.set(b, []).get(b)).push(a);
      }
      const usedBoundary = new Uint8Array(N), usedDiag = new Set();
      const nextOf = (u, w) => { // next vertex after half-edge u->w on the face to its left
        const ex = extra.get(w);
        if (!ex) return next[w];
        const rx = X[u] - X[w], ry = YS[u] - YS[w];
        let best = next[w], bestA = Infinity;
        for (const x of [next[w], ...ex]) {
          if (x === u && x !== next[w]) continue;
          const dx = X[x] - X[w], dy = YS[x] - YS[w];
          let a = Math.atan2(dx * ry - dy * rx, dx * rx + dy * ry); // clockwise angle from (u - w)
          if (a <= 0) a += TAU;
          if (a < bestA) { bestA = a; best = x; }
        }
        return best;
      };
      const markUsed = (u, w) => { if (next[u] === w && !usedBoundary[u]) usedBoundary[u] = 1; else usedDiag.add(u * N + w); };
      const face = [];
      const walk = (u, w) => {
        face.length = 0;
        let a = u, b = w, guard = 0;
        do {
          face.push(a); markUsed(a, b);
          const c = nextOf(a, b); a = b; b = c;
          if (++guard > N + diag.length + 4) throw new TriangulationError("Triangulation failed to close a face.");
        } while (!(a === u && b === w));
        monotone(face, out);
      };
      for (let u = 0; u < N; u++) if (!usedBoundary[u]) walk(u, next[u]);
      for (const [a, list] of extra) for (const b of list) if (!usedDiag.has(a * N + b)) walk(a, b);
      if (verify) {
        const cross = (a, b, c) => (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
        let expected = 0, actual = 0, begin = 0;
        for (const r of rings) {
          const end = begin + (r.length >> 1);
          for (let i = begin + 1; i + 1 < end; i++) expected += cross(begin, i, i + 1);
          begin = end;
        }
        for (let i = 0; i < out.length; i += 3) actual += cross(out[i], out[i + 1], out[i + 2]);
        if (!(expected > 0 && actual > 0 && Math.abs(expected - actual) <= 1e-10 * Math.max(1, expected)))
          throw new TriangulationError("The triangles do not cover the region and its holes.");
      }
      return Uint32Array.from(out);

      function monotone(f, out) {
        const n = f.length;
        if (n < 3) return;
        if (n === 3) { emit(f[0], f[1], f[2]); return; }
        let top = 0, bot = 0;
        for (let i = 1; i < n; i++) { if (above(f[i], f[top])) top = i; if (above(f[bot], f[i])) bot = i; }
        const left = new Map();
        for (let i = top; i !== bot; i = (i + 1) % n) left.set(f[i], true);
        for (let i = bot; i !== top; i = (i + 1) % n) left.set(f[i], false);
        // Merge the two chains in sweep order.
        const s = [];
        { let i = top, j = top; s.push(f[top]); i = (top + 1) % n; j = (top + n - 1) % n;
          while (s.length < n) { if (i === bot && j === bot) { s.push(f[bot]); break; } if (j === bot || (i !== bot && above(f[i], f[j]))) { s.push(f[i]); i = (i + 1) % n; } else { s.push(f[j]); j = (j + n - 1) % n; } } }
        const st = [s[0], s[1]];
        for (let j = 2; j < n - 1; j++) {
          const u = s[j];
          if (left.get(u) !== left.get(st[st.length - 1])) {
            while (st.length > 1) { const a = st.pop(); emit(u, a, st[st.length - 1]); }
            st.pop(); st.push(s[j - 1], u);
          } else {
            let last = st.pop();
            while (st.length) {
              const t = st[st.length - 1];
              const c = (X[last] - X[u]) * (YS[t] - YS[u]) - (YS[last] - YS[u]) * (X[t] - X[u]);
              if (left.get(u) ? c < 0 : c > 0) { emit(u, last, t); last = st.pop(); } else break;
            }
            st.push(last, u);
          }
        }
        const u = s[n - 1];
        while (st.length > 1) { const a = st.pop(); emit(u, a, st[st.length - 1]); }
      }
      function emit(a, b, c) {
        const cr = (X[b] - X[a]) * (YS[c] - YS[a]) - (YS[b] - YS[a]) * (X[c] - X[a]);
        if (cr >= 0) out.push(a, b, c); else out.push(a, c, b);
      }
    }

    // ------------------------------------------------------------ reader
    // Import reads a compact map for tessellation. The writer also needs ordered
    // source records for copying, and its public entity representation.
    function stringEnd(text, start) {
      for (let i = start + 1; i < text.length; i++) if (text[i] === "'") {
        if (text[i + 1] !== "'") return i;
        i++;
      }
      return text.length;
    }
    function commentEnd(text, start) {
      const end = text.indexOf("*/", start + 2);
      return end < 0 ? text.length : end + 2;
    }
    // Component merging has always removed comments before copying original bodies.
    function withoutComments(text, start) {
      if (text.indexOf("/*", start) < 0) return text;
      const chunks = [];
      let from = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "'") i = stringEnd(text, i);
        else if (text[i] === "/" && text[i + 1] === "*") {
          chunks.push(text.slice(from, i));
          from = commentEnd(text, i);
          i = from - 1;
        }
      }
      chunks.push(text.slice(from));
      return chunks.join("");
    }
    function read(text, L, writer = false, bodyOnly = false) {
      let i = 0;
      if (!bodyOnly) {
        if (typeof text !== "string") throw new Limit("The STEP model is not text.");
        if (text.length > L.bytes) throw new Limit("The STEP model is larger than " + Math.round(L.bytes / 1048576) + " MB.");
        if (!writer && !/^\s*ISO-10303-21\s*;/.test(text.slice(0, 256))) throw new Limit("Not an ISO 10303-21 (STEP) file.");
        const ds = text.search(/\bDATA\s*;/);
        if (ds < 0) throw new Limit(writer ? "The STEP text has no DATA section." : "The STEP file has no DATA section.");
        i = text.indexOf(";", ds) + 1;
        if (writer) text = withoutComments(text, i);
      }
      const n = text.length;
      function ws() {
        if (writer) { while (i < n && /\s/.test(text[i])) i++; return; }
        for (;;) {
          while (i < n && text.charCodeAt(i) <= 32) i++;
          if (text[i] !== "/" || text[i + 1] !== "*") return;
          i = commentEnd(text, i);
        }
      }
      function kw() {
        const s = i, end = writer ? Math.min(n, i + 80) : n;
        if (writer && !/^[A-Z_]/.test(text[i] || "")) return "";
        while (i < end) {
          const c = text.charCodeAt(i);
          if (c >= 65 && c <= 90 || c >= 48 && c <= 57 || c === 95 || !writer && c >= 97 && c <= 122) i++;
          else break;
        }
        return text.slice(s, i).toUpperCase();
      }
      function list(depth) {
        if (depth > L.depth) throw new Limit("The STEP model nests entity arguments deeper than " + L.depth + " levels.");
        if (text[i] !== "(") throw Error("Expected ( near offset " + i);
        i++; const out = []; ws();
        if (text[i] === ")") { i++; return out; }
        for (;;) {
          out.push(value(depth)); ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === ")") { i++; return out; }
          throw Error("Expected , or ) near offset " + i);
        }
      }
      function digits(end = n) {
        const s = i;
        while (i < end && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
        if (writer && i === s) throw Error("Bad reference near offset " + i);
        return +text.slice(s, i);
      }
      function value(depth) {
        ws();
        const ch = text[i];
        if (ch === "#") {
          const end = writer ? Math.min(n, i + 24) : n;
          i++; const ref = digits(end); return writer ? {ref} : {r: ref};
        }
        if (ch === "'") {
          const j = stringEnd(text, i);
          if (writer && j >= n) throw Error("Unterminated string");
          const s = text.slice(i + 1, j); i = j + 1;
          return writer ? {str: s.replace(/''/g, "'")} : {s};
        }
        if (ch === ".") {
          const j = text.indexOf(".", i + 1), e = text.slice(i + 1, j);
          if (j < 0 || j - i > (writer ? 79 : 64) || writer && !/^[A-Z_][A-Z0-9_]*$/.test(e)) throw Error("Bad enumeration");
          i = j + 1; return writer ? {enum: e} : {e};
        }
        if (ch === "$" || ch === "*") { i++; return writer ? {omit: ch} : null; }
        if (ch === "(") return list(depth + 1);
        if (ch === "\"") { const j = text.indexOf("\"", i + 1); if (j < 0) throw Error("Bad binary"); i = j + 1; return writer ? {bin: true} : null; }
        if (ch === "-" || ch === "+" || (ch >= "0" && ch <= "9")) {
          if (writer) {
            const number = /^[+-]?\d+(\.\d*)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
            if (!number) throw Error("Bad number near offset " + i);
            i += number[0].length; return +number[0];
          }
          const s = i++;
          while (i < n && /[0-9.eE+-]/.test(text[i])) i++;
          const number = +text.slice(s, i);
          if (!Number.isFinite(number)) throw Error("Bad number");
          return number;
        }
        return named(depth + 1, "Unexpected '" + ch + "'");
      }
      function named(depth, diagnosis = "Bad entity") {
        const k = kw();
        if (!k) throw Error(diagnosis + " near offset " + i);
        ws(); const a = list(depth);
        return writer ? {type: k, args: a} : {t: k, a};
      }
      function entity() {
        if (text[i] !== "(") return named(1);
        i++; const parts = writer ? [] : {}; ws();
        while (text[i] !== ")") {
          const part = named(1);
          if (writer) parts.push(part); else parts[part.t] = part.a;
          ws();
          if (i >= n) throw Error("Unterminated entity");
        }
        i++;
        return writer ? {complex: parts} : {t: "", parts};
      }
      if (bodyOnly) {
        ws(); const e = entity(); ws();
        if (i !== n) throw Error("Trailing text in entity: " + text.slice(0, 80));
        return e;
      }
      const E = new Map(), records = writer ? [] : null;
      for (;;) {
        ws();
        if (i >= n) throw Error("The STEP DATA section is not terminated.");
        if (writer ? /^ENDSEC$/i.test(text.slice(i, i + 6)) : text.startsWith("ENDSEC", i)) {
          if (!writer) break;
          i += 6; ws();
          if (text[i] === ";") break;
          throw Error("The STEP DATA section is not terminated.");
        }
        if (text[i] !== "#") throw Error("Bad instance near offset " + i);
        i++; const id = digits(); ws();
        if (text[i] !== "=") throw Error("Bad instance #" + id);
        i++; ws();
        const from = i, e = entity(), to = i;
        ws();
        if (text[i] !== ";") throw Error("Expected ; after #" + id);
        i++;
        if (records) records.push({id, body: text.slice(from, to), entity: e});
        else {
          if (E.has(id)) throw Error("Duplicate STEP instance #" + id + ".");
          E.set(id, e);
        }
        if ((records ? records.length : E.size) > L.entities) throw new Limit("The STEP model has more than " + L.entities + " entities.");
      }
      return records || E;
    }
    const readImport = (text, limits) => /** @type {Map<number, any>} */ (read(text, limits));
    const readWriter = (text, limits, bodyOnly = false) => read(text, limits, true, bodyOnly);

    // ------------------------------------------------------------ vectors and placements
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };
    // 4x4 as 12 numbers, row-major [R | t].
    const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const mul = (A, B) => { const o = new Array(12); for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) o[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c]; o[r * 4 + 3] = A[r * 4] * B[3] + A[r * 4 + 1] * B[7] + A[r * 4 + 2] * B[11] + A[r * 4 + 3]; } return o; };
    const inv = M => { const R = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]], t = [M[3], M[7], M[11]]; return [R[0], R[1], R[2], -(R[0] * t[0] + R[1] * t[1] + R[2] * t[2]), R[3], R[4], R[5], -(R[3] * t[0] + R[4] * t[1] + R[5] * t[2]), R[6], R[7], R[8], -(R[6] * t[0] + R[7] * t[1] + R[8] * t[2])]; };
    const xp = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
    const xd = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2], M[4] * p[0] + M[5] * p[1] + M[6] * p[2], M[8] * p[0] + M[9] * p[1] + M[10] * p[2]];

    function tessellate(text, opts = {}) {
      const L = {...LIMITS, ...(opts.limits || {})}, t0 = Date.now(), notes = [], tol = opts.tolerance > 0 ? opts.tolerance : 0.02;
      const E = readImport(text, L);
      const stats = {entities: E.size, solids: 0, faces: 0, planar: 0, cylindrical: 0, spherical: 0, faceted: 0, approximated: 0, skipped: 0, triangles: 0, ms: 0};
      const get = r => r && r.r != null ? E.get(r.r) : null;
      const args = (e, type) => !e ? null : e.t === type ? e.a : e.t === "" ? e.parts[type] || null : null;
      const isA = (e, type) => !!e && (e.t === type || e.t === "" && !!e.parts[type]);
      // A single STEP assembly can mix mm and inch representations. Points,
      // radii and placement origins use their representation's selected context.
      function lengthScale(e) {
        if (!isA(e, "LENGTH_UNIT")) return null;
        const si = args(e, "SI_UNIT"), cb = args(e, "CONVERSION_BASED_UNIT");
        if (cb && /inch/i.test(cb[0]?.s || "")) return 25.4;
        if (si) return ({MILLI: 1, CENTI: 10, MICRO: .001, "": 1000})[si[0]?.e || ""] ?? 1;
        return null;
      }
      let defaultScale = 1, scale;
      for (const e of E.values()) { const n = lengthScale(e); if (n != null) { defaultScale = n; break; } }
      scale = defaultScale;
      const scales = new Map();
      function repScale(rep) {
        const ctx = rep?.a?.[2]?.r;
        if (ctx == null) return defaultScale;
        if (!scales.has(ctx)) {
          const units = args(E.get(ctx), "GLOBAL_UNIT_ASSIGNED_CONTEXT")?.[0] || [];
          scales.set(ctx, units.map(r => lengthScale(get(r))).find(n => n != null) ?? defaultScale);
        }
        return scales.get(ctx);
      }
      const pointsByScale = new Map();
      function pointIn(r, factor) {
        if (!pointsByScale.has(factor)) pointsByScale.set(factor, new Map());
        const pts = pointsByScale.get(factor);
        if (pts.has(r?.r)) return pts.get(r.r);
        const a = args(get(r), "CARTESIAN_POINT");
        if (!Array.isArray(a?.[1])) return null;
        const p = [0, 1, 2].map(i => (+a[1][i] || 0) * factor);
        pts.set(r.r, p);
        return p;
      }
      const point = r => pointIn(r, scale);
      const direction = (r, def) => { const a = args(get(r), "DIRECTION"); return a && Array.isArray(a[1]) ? norm([+a[1][0] || 0, +a[1][1] || 0, +a[1][2] || 0]) : def; };
      // AXIS2_PLACEMENT_3D -> frame {o, x, y, z} and matrix.
      function frame(r, factor = scale) {
        const a = args(get(r), "AXIS2_PLACEMENT_3D");
        if (!a) return {o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]};
        const o = pointIn(a[1], factor) || [0, 0, 0], z = direction(a[2], [0, 0, 1]);
        let x = direction(a[3], Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
        x = norm(sub(x, [z[0] * dot(x, z), z[1] * dot(x, z), z[2] * dot(x, z)]));
        return {o, x, y: cross(z, x), z};
      }
      const matOf = f => [f.x[0], f.y[0], f.z[0], f.o[0], f.x[1], f.y[1], f.z[1], f.o[1], f.x[2], f.y[2], f.z[2], f.o[2]];

      // Colours: STYLED_ITEM -> ... -> COLOUR_RGB, walked with a depth cap.
      const colourOf = new Map();
      function findRGB(v, depth) {
        if (depth > 24 || v == null) return null;
        if (Array.isArray(v)) { for (const x of v) { const c = findRGB(x, depth + 1); if (c) return c; } return null; }
        if (v.r != null) {
          const e = E.get(v.r);
          if (!e) return null;
          const rgb = args(e, "COLOUR_RGB");
          if (rgb) return [+rgb[1] || 0, +rgb[2] || 0, +rgb[3] || 0].map(x => Math.max(0, Math.min(1, x)));
          if (args(e, "DRAUGHTING_PRE_DEFINED_COLOUR")) return null;
          return findRGB(e.t ? e.a : Object.values(e.parts), depth + 1);
        }
        return null;
      }
      for (const e of E.values()) {
        const a = args(e, "STYLED_ITEM") || args(e, "OVER_RIDING_STYLED_ITEM");
        if (!a || !a[2]?.r) continue;
        const c = findRGB(a[1], 0);
        if (c && !colourOf.has(a[2].r)) colourOf.set(a[2].r, c);
      }

      // Representation tree from the root (the shape of the top product), with transforms.
      const repTf = new Map(), children = new Map(), productReps = new Map(), parentFor = new Map();
      for (const e of E.values()) {
        const shape = args(e, "SHAPE_DEFINITION_REPRESENTATION");
        const def = shape && args(get(shape[0]), "PRODUCT_DEFINITION_SHAPE")?.[2]?.r;
        if (def != null && shape[1]?.r != null) productReps.set(def, shape[1].r);
      }
      // STEP permits either representation endpoint to be the parent. The product
      // occurrence, referenced by the context-dependent shape, fixes its direction.
      for (const e of E.values()) {
        const link = args(e, "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION");
        if (!link) continue;
        const occurrence = args(get(args(get(link[1]), "PRODUCT_DEFINITION_SHAPE")?.[2]), "NEXT_ASSEMBLY_USAGE_OCCURRENCE");
        if (occurrence) parentFor.set(link[0].r, productReps.get(occurrence[3]?.r));
      }
      const addChild = (parent, child, M) => { if (!children.has(parent)) children.set(parent, []); children.get(parent).push({child, M}); };
      for (const [id, e] of E) {
        if (e.t === "SHAPE_REPRESENTATION_RELATIONSHIP") {
          // The product shape is often just a coordinate frame. Its related
          // B-rep supplies the geometry in that same frame (no transform).
          const a = e.a[2]?.r, b = e.a[3]?.r;
          if (E.get(b)?.t === "SHAPE_REPRESENTATION" && E.get(a)?.t !== "SHAPE_REPRESENTATION") addChild(b, a, I4);
          else if (a != null && b != null) addChild(a, b, I4);
          continue;
        }
        const rr = args(e, "REPRESENTATION_RELATIONSHIP");
        if (!rr) continue;
        const rel = args(e, "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION");
        let M = I4;
        if (rel) {
          const idt = args(get(rel[0]), "ITEM_DEFINED_TRANSFORMATION");
          if (idt) M = mul(matOf(frame(idt[3], repScale(get(rr[3])))), inv(matOf(frame(idt[2], repScale(get(rr[2]))))));
        }
        if (rr[2]?.r != null && rr[3]?.r != null) {
          if (parentFor.get(id) === rr[2].r) addChild(rr[2].r, rr[3].r, inv(M));
          else addChild(rr[3].r, rr[2].r, M);
        }
      }
      const isRep = e => !!e && /REPRESENTATION$/.test(e.t || Object.keys(e.parts || {}).find(k => /REPRESENTATION$/.test(k)) || "") && !/RELATIONSHIP/.test(e.t || "");
      const childSet = new Set();
      for (const l of children.values()) for (const c of l) childSet.add(c.child);
      // Root: the shape representation of the product definition no assembly uses; else every rep without a parent.
      const nauoChild = new Set();
      for (const e of E.values()) { const a = args(e, "NEXT_ASSEMBLY_USAGE_OCCURRENCE"); if (a?.[4]?.r != null) nauoChild.add(a[4].r); }
      let roots = [];
      for (const [, e] of E) {
        const a = args(e, "SHAPE_DEFINITION_REPRESENTATION");
        if (!a) continue;
        const pds = args(get(a[0]), "PRODUCT_DEFINITION_SHAPE");
        if (pds?.[2]?.r != null && isA(E.get(pds[2].r), "PRODUCT_DEFINITION") && !nauoChild.has(pds[2].r) && a[1]?.r != null) roots.push(a[1].r);
      }
      if (!roots.length) for (const [id, e] of E) if (isRep(e) && !childSet.has(id)) roots.push(id);
      const queue = roots.map(r => ({id: r, M: I4, d: 0})), seen = new Set();
      while (queue.length) {
        const {id, M, d} = queue.shift();
        if (d > L.refDepth) { notes.push("The model's assembly tree is deeper than " + L.refDepth + " levels; deeper parts were skipped."); continue; }
        const key = id + "|" + M.map(v => v.toFixed(6)).join(",");
        if (seen.has(key)) continue; seen.add(key);
        if (seen.size > 20000) throw new Limit("The STEP model places more than 20000 representations.");
        if (!repTf.has(id)) repTf.set(id, []);
        repTf.get(id).push(M);
        for (const c of children.get(id) || []) queue.push({id: c.child, M: mul(M, c.M), d: d + 1});
      }

      // ---------------------------------------------------------- curves
      // Points of an edge from its start vertex to its end vertex.
      function curvePoints(cr, a, b, same, depth = 0) {
        const c = get(cr);
        if (!c || depth > 4) return [a, b];
        let x;
        if ((x = args(c, "LINE"))) return [a, b];
        if ((x = args(c, "SURFACE_CURVE") || args(c, "SEAM_CURVE") || args(c, "INTERSECTION_CURVE"))) return curvePoints(x[1], a, b, same, depth + 1);
        if ((x = args(c, "TRIMMED_CURVE"))) return curvePoints(x[1], a, b, same, depth + 1);
        if ((x = args(c, "CIRCLE")) || (x = args(c, "ELLIPSE"))) {
          const f = frame(x[1]), r1 = (+x[2] || 0) * scale, r2 = args(c, "ELLIPSE") ? (+x[3] || 0) * scale : r1;
          if (!(r1 > 0) || !(r2 > 0)) return [a, b];
          const ang = p => { const d = sub(p, f.o); return Math.atan2(dot(d, f.y) / r2, dot(d, f.x) / r1); };
          let t0 = ang(a), t1 = ang(b), d = t1 - t0;
          const closed = Math.hypot(...sub(a, b)) < 1e-9;
          if (same) { while (d <= 1e-12) d += TAU; if (closed) d = TAU; } else { while (d >= -1e-12) d -= TAU; if (closed) d = -TAU; }
          const r = Math.max(r1, r2), step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 4;
          const k = Math.min(L.curvePoints, Math.max(2, Math.ceil(Math.abs(d) / Math.min(step, Math.PI / 8))));
          const out = [a];
          for (let i = 1; i < k; i++) { const t = t0 + d * i / k; out.push(add(add(f.o, f.x, r1 * Math.cos(t)), f.y, r2 * Math.sin(t))); }
          out.push(b); return out;
        }
        if ((x = args(c, "POLYLINE"))) return slice((x[1] || []).map(point).filter(Boolean), a, b, same);
        const bs = args(c, "B_SPLINE_CURVE_WITH_KNOTS"), bc = args(c, "B_SPLINE_CURVE");
        if (bs) {
          // Simple entity: (name, degree, points, form, closed, self, mults, knots, spec); complex: B_SPLINE_CURVE + WITH_KNOTS (+ RATIONAL).
          const deg = bc ? +bc[0] : +bs[1], ctrl = (bc ? bc[1] : bs[2]) || [], mults = bc ? bs[0] : bs[6], knots0 = bc ? bs[1] : bs[7];
          const w = args(c, "RATIONAL_B_SPLINE_CURVE")?.[0];
          const P = ctrl.map(point);
          if (P.some(p => !p) || !(deg >= 1) || deg > 12 || !Array.isArray(mults) || !Array.isArray(knots0)) return [a, b];
          const U = [];
          for (let i = 0; i < knots0.length; i++) for (let m = 0; m < Math.min(64, +mults[i] || 0); m++) U.push(+knots0[i]);
          if (U.length !== P.length + deg + 1 || P.length > 4096) return [a, b];
          const W = Array.isArray(w) && w.length === P.length ? w.map(Number) : null;
          const u0 = U[deg], u1 = U[U.length - deg - 1], N = Math.min(L.curvePoints, Math.max(8, (P.length - deg) * 6)), out = [];
          for (let s = 0; s <= N; s++) out.push(deBoor(deg, U, P, W, u0 + (u1 - u0) * s / N));
          return slice(out, a, b, same);
        }
        return [a, b];
      }
      function deBoor(p, U, P, W, u) {
        let k = p; while (k < U.length - p - 2 && u >= U[k + 1]) k++;
        const d = [];
        for (let j = 0; j <= p; j++) { const q = P[k - p + j], w = W ? W[k - p + j] : 1; d.push([q[0] * w, q[1] * w, q[2] * w, w]); }
        for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
          const i = k - p + j, den = U[i + p - r + 1] - U[i], al = den > 1e-15 ? (u - U[i]) / den : 0;
          for (let c = 0; c < 4; c++) d[j][c] = (1 - al) * d[j - 1][c] + al * d[j][c];
        }
        const h = d[p][3] || 1;
        return [d[p][0] / h, d[p][1] / h, d[p][2] / h];
      }
      // The run of sampled points between the vertices nearest a and b.
      function slice(S, a, b, same) {
        if (S.length < 2) return [a, b];
        const near = p => { let bi = 0, bd = Infinity; S.forEach((q, i) => { const d = Math.hypot(...sub(p, q)); if (d < bd) { bd = d; bi = i; } }); return bi; };
        const list = same ? S : S.slice().reverse();
        let ia = near(a), ib = near(b);
        if (!same) { ia = S.length - 1 - ia; ib = S.length - 1 - ib; }
        if (Math.hypot(...sub(a, b)) < 1e-9) return [a, ...list.slice(1, -1), b];
        if (ib < ia) return [a, b];
        return [a, ...list.slice(ia + 1, ib), b];
      }

      // ---------------------------------------------------------- loops
      // A face bound -> 3D points (closed ring, last point not repeated).
      function loopPoints(br) {
        const fb = get(br), ba = args(fb, "FACE_OUTER_BOUND") || args(fb, "FACE_BOUND");
        if (!ba) return null;
        const lp = get(ba[1]), flip = ba[2]?.e === "F", out = [];
        let curved = false, la;
        if ((la = args(lp, "POLY_LOOP"))) { for (const r of la[1] || []) { const p = point(r); if (p) out.push(p); } }
        else if ((la = args(lp, "EDGE_LOOP"))) {
          for (const oe of la[1] || []) {
            const o = args(get(oe), "ORIENTED_EDGE");
            if (!o) continue;
            const ec = args(get(o[3]), "EDGE_CURVE");
            if (!ec) continue;
            const v1 = point(args(get(ec[1]), "VERTEX_POINT")?.[1]), v2 = point(args(get(ec[2]), "VERTEX_POINT")?.[1]);
            if (!v1 || !v2) continue;
            let seg = curvePoints(ec[3], v1, v2, ec[4]?.e !== "F");
            if (opts.faceResult && !isA(get(ec[3]), "LINE")) curved = true;
            if (o[4]?.e === "F") seg = seg.slice().reverse();
            for (let k = 0; k < seg.length - 1; k++) out.push(seg[k]);
            if (out.length > L.loopPoints) throw new Limit("A face of the STEP model has more than " + L.loopPoints + " boundary points.");
          }
        } else return null;
        const clean = out.filter((p, k) => Math.hypot(...sub(p, out[(k + 1) % out.length])) > 1e-9);
        if (flip) clean.reverse();
        return {pts: clean, outer: isA(fb, "FACE_OUTER_BOUND"), curved};
      }

      // ---------------------------------------------------------- 2D triangulation
      const area2 = R => { let s = 0; for (let i = 0, j = R.length - 1; i < R.length; j = i++) s += R[j][0] * R[i][1] - R[i][0] * R[j][1]; return s / 2; };
      function triangulateFace(rings) {
        const ids = [], coords = rings.map((ring, i) => {
          if ((area2(ring) > 0) !== (i === 0)) ring.reverse();
          return ring.flatMap(([x, y, id]) => { ids.push(id); return [x, y]; });
        });
        try { return triangulate(coords, true).map(i => ids[i]); }
        catch (e) { if (e instanceof TriangulationError) return new Uint32Array(); throw e; }
      }
      // Lawson flips toward Delaunay on 2D coordinates UV (indexed by vertex id); boundary edges stay.
      function flip(T, UV) {
        const key = (a, b) => a < b ? a * 4194304 + b : b * 4194304 + a, edges = new Map(), stack = [];
        for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) { const kk = key(T[t * 3 + k], T[t * 3 + (k + 1) % 3]); const l = edges.get(kk); if (l) l.push(t); else edges.set(kk, [t]); }
        for (const [kk, l] of edges) if (l.length === 2) stack.push(kk);
        const ccw = (a, b, c) => (UV[b][0] - UV[a][0]) * (UV[c][1] - UV[a][1]) - (UV[b][1] - UV[a][1]) * (UV[c][0] - UV[a][0]);
        const inCircle = (a, b, c, d) => {
          const m = [a, b, c].map(v => { const x = UV[v][0] - UV[d][0], y = UV[v][1] - UV[d][1]; return [x, y, x * x + y * y]; });
          return m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) - m[0][1] * (m[1][0] * m[2][2] - m[2][0] * m[1][2]) + m[0][2] * (m[1][0] * m[2][1] - m[2][0] * m[1][1]) > 1e-12;
        };
        const swap = (kk, from, to) => { const l = edges.get(kk); if (l) { const i = l.indexOf(from); if (i >= 0) l[i] = to; } };
        let budget = T.length * 4;
        while (stack.length && budget-- > 0) {
          const kk = stack.pop(), l = edges.get(kk);
          if (!l || l.length !== 2) continue;
          const [t1, t2] = l, A = [T[t1 * 3], T[t1 * 3 + 1], T[t1 * 3 + 2]], B = [T[t2 * 3], T[t2 * 3 + 1], T[t2 * 3 + 2]];
          const p = A.find(v => !B.includes(v)), q = B.find(v => !A.includes(v));
          if (p == null || q == null) continue;
          const ia = A.indexOf(p), a = A[(ia + 1) % 3], b = A[(ia + 2) % 3];
          if (!inCircle(p, a, b, q) || !(ccw(p, a, q) > 1e-14 && ccw(q, b, p) > 1e-14)) continue;
          T[t1 * 3] = p; T[t1 * 3 + 1] = a; T[t1 * 3 + 2] = q; T[t2 * 3] = q; T[t2 * 3 + 1] = b; T[t2 * 3 + 2] = p;
          edges.delete(kk); edges.set(key(p, q), [t1, t2]);
          swap(key(a, q), t2, t1); swap(key(b, p), t1, t2);
          stack.push(key(p, a), key(a, q), key(q, b), key(b, p));
        }
        return T;
      }

      // ---------------------------------------------------------- faces
      const groups = new Map();
      const groupFor = c => { const k = c.map(v => v.toFixed(3)).join(","); let g = groups.get(k); if (!g) groups.set(k, g = {color: c, P: [], N: [], I: []}); return g; };
      const DEFAULT = [0.62, 0.62, 0.64];
      // Emit triangles: P3 world points, N3 normals (per vertex), T index triples into them.
      function emit(g, P3, N3, T) {
        const b = g.P.length / 3;
        for (let k = 0; k < P3.length; k++) { g.P.push(P3[k][0], P3[k][1], P3[k][2]); g.N.push(N3[k][0], N3[k][1], N3[k][2]); }
        for (const t of T) g.I.push(b + t);
        stats.triangles += T.length / 3;
        if (stats.triangles > L.triangles) throw new Limit("The STEP model needs more than " + L.triangles + " triangles.");
      }
      function newell(R) { let n = [0, 0, 0]; for (let i = 0; i < R.length; i++) { const a = R[i], b = R[(i + 1) % R.length]; n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); } return n; }
      function planar(loops, o, x, y, z, M, g) {
        const flat = [], rings = [];
        for (const l of loops) { const ring = []; for (const p of l) { const d = sub(p, o); ring.push([dot(d, x), dot(d, y), flat.length]); flat.push(p); } if (ring.length >= 3) rings.push(ring); }
        if (!rings.length) return false;
        rings.sort((a, b) => Math.abs(area2(b)) - Math.abs(area2(a)));
        const T = triangulateFace(rings);
        if (!T.length) return false;
        const wn = norm(xd(M, z));
        emit(g, flat.map(p => xp(M, p)), flat.map(() => wn), T);
        return true;
      }
      function face(fr, M, solidColour) {
        const f = get(fr);
        let a = args(f, "ADVANCED_FACE") || args(f, "FACE_SURFACE");
        const plain = !a && args(f, "FACE");
        if (!a && !plain) return;
        if (++stats.faces > L.faces) throw new Limit("The STEP model has more than " + L.faces + " faces.");
        const bounds = (a || plain)[1] || [], loops = [];
        let curved = false;
        for (const b of bounds) { const l = loopPoints(b); if (l && l.pts.length >= 3) { loops.push(l.pts); curved ||= l.curved; } }
        const same = a ? a[3]?.e !== "F" : true, surf = a ? get(a[2]) : null;
        const colour = colourOf.get(fr.r) || solidColour || DEFAULT;
        let s;
        if (!bounds.length && (s = args(surf, "SPHERICAL_SURFACE")) && s[2] > 0) {
          // An untrimmed spherical face needs no boundary (e.g. BGA solder balls).
          const f = frame(s[1]), r = s[2] * scale, g = groupFor(colour);
          const strips = Math.max(3, Math.min(64, Math.ceil(Math.PI / (2 * Math.acos(Math.max(-1, 1 - tol / r))))));
          const P = [], N = [], T = [], around = strips * 2;
          for (let j = 0; j <= strips; j++) {
            const lat = Math.PI * (j / strips - .5);
            for (let i = 0; i < around; i++) {
              const lon = TAU * i / around, d = add(add([0, 0, 0], f.x, Math.cos(lat) * Math.cos(lon)), f.y, Math.cos(lat) * Math.sin(lon));
              const radial = add(d, f.z, Math.sin(lat));
              P.push(xp(M, add(f.o, radial, r))); N.push(norm(xd(M, same ? radial : radial.map(v => -v))));
              if (j === strips) continue;
              const p = j * around + i, q = j * around + (i + 1) % around;
              if (j > 0) T.push(p, q, p + around);
              if (j < strips - 1) T.push(q, q + around, p + around);
            }
          }
          if (!same) for (let i = 0; i < T.length; i += 3) [T[i], T[i + 1]] = [T[i + 1], T[i]];
          emit(g, P, N, T); stats.spherical++; opts.faceResult?.(fr.r, "spherical"); return;
        }
        if (!loops.length) { stats.skipped++; opts.faceResult?.(fr.r, "skipped"); return; }
        const g = groupFor(colour);
        const record = (drawn, kind, label = kind) => {
          stats[drawn ? kind : "skipped"]++;
          opts.faceResult?.(fr.r, drawn ? label : "skipped");
        };
        if ((s = args(surf, "PLANE"))) {
          const F = frame(s[1]), z = same ? F.z : [-F.z[0], -F.z[1], -F.z[2]], x = F.x, y = cross(z, x);
          record(planar(loops, F.o, x, y, z, M, g), "planar", curved ? "curved boundary" : "planar"); return;
        }
        if ((s = args(surf, "CYLINDRICAL_SURFACE"))) {
          const F = frame(s[1]), r = (+s[2] || 0) * scale;
          if (r > 0 && cylinder(loops, F, r, same, M, g)) { stats.cylindrical++; opts.faceResult?.(fr.r, "cylindrical"); return; }
        }
        // Facets and unsupported surfaces use the boundary polygon on its best-fit plane.
        const n = norm(newell(loops[0])), x = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
        record(planar(loops, loops[0][0], x, cross(n, x), n, M, g), plain ? "faceted" : "approximated");
      }
      function cylinder(loops, F, r, same, M, g) {
        // Unwrapped (u = r*theta, v = height) per loop; a loop that winds once is a full circle.
        const un = loops.map(l => {
          const out = []; let prev = null, acc = 0;
          for (const p of l) {
            const d = sub(p, F.o); let th = Math.atan2(dot(d, F.y), dot(d, F.x));
            if (prev != null) { let dd = th - prev; while (dd > Math.PI) dd -= TAU; while (dd < -Math.PI) dd += TAU; acc += dd; } else acc = th;
            prev = th; out.push([acc, dot(d, F.z)]);
          }
          let dd = out.length ? Math.atan2(Math.sin(out[0][0] - acc), Math.cos(out[0][0] - acc)) : 0;
          return {pts: out, wind: Math.round((acc + dd - out[0][0]) / TAU)};
        });
        const toP = (th, h) => add(add(add(F.o, F.x, r * Math.cos(th)), F.y, r * Math.sin(th)), F.z, h);
        const nrm = th => { const v = add([F.x[0] * Math.cos(th), F.x[1] * Math.cos(th), F.x[2] * Math.cos(th)], F.y, Math.sin(th)); return same ? v : [-v[0], -v[1], -v[2]]; };
        const P3 = [], N3 = [], UV = [];
        const vert = (th, h) => { P3.push(xp(M, toP(th, h))); N3.push(norm(xd(M, nrm(th)))); UV.push([th * r, h]); return P3.length - 1; };
        let T;
        const winders = un.filter(l => l.wind !== 0);
        if (winders.length === 2 && un.length === 2) {
          // A band between two full circles.
          const hs = winders.map(l => l.pts.reduce((s, p) => s + p[1], 0) / l.pts.length), lo = Math.min(...hs), hi = Math.max(...hs);
          const k = Math.max(12, Math.min(L.curvePoints, Math.ceil(TAU / (r > 0.02 ? 2 * Math.acos(Math.max(-1, 1 - 0.02 / r)) : 0.5)))), ids = [];
          for (let i = 0; i <= k; i++) ids.push([vert(TAU * i / k, lo), vert(TAU * i / k, hi)]);
          T = [];
          for (let i = 0; i < k; i++) T.push(ids[i][0], ids[i + 1][0], ids[i + 1][1], ids[i][0], ids[i + 1][1], ids[i][1]);
        } else if (!winders.length) {
          // Holes unwrap independently: shift each into the outer loop's angle range.
          const ar = l => Math.abs(area2(l.pts));
          un.sort((a, b) => ar(b) - ar(a));
          const th0 = Math.min(...un[0].pts.map(p => p[0])), th1 = Math.max(...un[0].pts.map(p => p[0]));
          for (const l of un.slice(1)) { const m = l.pts.reduce((s, p) => s + p[0], 0) / l.pts.length, k = m < th0 ? Math.ceil((th0 - m) / TAU) : m > th1 ? -Math.ceil((m - th1) / TAU) : 0; if (k) for (const p of l.pts) p[0] += k * TAU; }
          const rings = un.map(l => l.pts.map(([th, h]) => { const id = vert(th, h); return [th * r, h, id]; }));
          T = triangulateFace(rings);
          if (!T.length) return false;
          flip(T, UV);
        } else return false;
        // Triangles are counter-clockwise in (r*theta, h), whose normal is the radial direction.
        if (!same) for (let i = 0; i < T.length; i += 3) { const s = T[i + 1]; T[i + 1] = T[i + 2]; T[i + 2] = s; }
        emit(g, P3, N3, T);
        return true;
      }
      function shellFaces(sr, M, colour) {
        const sh = get(sr), a = args(sh, "CLOSED_SHELL") || args(sh, "OPEN_SHELL");
        if (!a) return;
        const c = colourOf.get(sr.r) || colour;
        for (const fr of a[1] || []) face(fr, M, c);
      }
      function item(ir, M, depth = 0) {
        const e = get(ir);
        if (!e || depth > 8) return;
        const c = colourOf.get(ir.r);
        let a;
        if ((a = args(e, "MANIFOLD_SOLID_BREP")) || (a = args(e, "FACETED_BREP"))) { stats.solids++; shellFaces(a[1], M, c); return; }
        if ((a = args(e, "BREP_WITH_VOIDS"))) { stats.solids++; shellFaces(a[1], M, c); for (const v of a[2] || []) shellFaces(v, M, c); return; }
        if ((a = args(e, "SHELL_BASED_SURFACE_MODEL"))) { stats.solids++; for (const s of a[1] || []) shellFaces(s, M, c); return; }
        if ((a = args(e, "MAPPED_ITEM"))) {
          const map = args(get(a[1]), "REPRESENTATION_MAP");
          if (!map) return;
          const rep = get(map[1]), saved = scale, childScale = repScale(rep);
          const T = mul(M, mul(matOf(frame(a[2])), inv(matOf(frame(map[0], childScale)))));
          scale = childScale;
          for (const r of (rep?.a || [])[1] || []) item(r, T, depth + 1);
          scale = saved;
        }
      }
      for (const [id, list] of repTf) {
        const e = E.get(id), a = e?.t ? e.a : null;
        if (!a || !Array.isArray(a[1])) continue;
        scale = repScale(e);
        for (const M of list) for (const r of a[1]) item(r, M);
      }
      // Nothing under the root (an unusual assembly layout): draw every representation in place.
      if (!groups.size) for (const [, e] of E) if (e.t && /REPRESENTATION$/.test(e.t) && Array.isArray(e.a?.[1])) { scale = repScale(e); for (const r of e.a[1]) item(r, I4); }
      const parts = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const g of groups.values()) {
        if (!g.I.length) continue;
        const P = new Float32Array(g.P);
        for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < lo[k]) lo[k] = P[i + k]; if (P[i + k] > hi[k]) hi[k] = P[i + k]; }
        parts.push({color: g.color, positions: P, normals: new Float32Array(g.N), indices: new Uint32Array(g.I)});
      }
      if (stats.approximated) notes.push(stats.approximated + " of " + stats.faces + " faces use surfaces other than planes and cylinders and are drawn as their boundary polygon.");
      if (stats.skipped) notes.push(stats.skipped + " faces had no readable boundary and were skipped.");
      if (!parts.length) notes.push("No faces could be tessellated; the model's bounding box is shown instead.");
      stats.ms = Date.now() - t0;
      return {parts, bbox: parts.length ? [...lo, ...hi] : null, stats, notes, scale};
    }
    return {LIMITS, tessellate, read: readImport, readWriter, Limit, triangulate, TriangulationError};
  }

  const core = STEPCore();
  const cache = new Map(), inflight = new Map();
  let worker = null, workerStarted = false, unavailable = false, seq = 0;
  const waiters = new Map();
  const failure = message => ({parts: [], bbox: null, stats: {}, notes: [message], error: message});
  function remember(text, result) {
    cache.set(text, result);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return result;
  }
  function inputError(text) {
    if (typeof text !== "string") return "The STEP model is not text.";
    if (text.length > core.LIMITS.bytes) return "The STEP model is larger than " + Math.round(core.LIMITS.bytes / 1048576) + " MB.";
    return null;
  }
  function stop(w, message) {
    if (w !== worker) return;
    worker = null;
    try { w.terminate(); } catch { /* already stopped */ }
    for (const finish of waiters.values()) finish({error: message});
    waiters.clear();
  }
  function makeWorker() {
    if (unavailable || typeof Worker !== "function" || typeof Blob !== "function" || typeof globalThis.URL?.createObjectURL !== "function") return null;
    try {
      const src = '"use strict";const C=(' + STEPCore.toString() + ')();\n' +
        'onmessage=e=>{const {id,text,opts}=e.data;try{const r=C.tessellate(text,opts),tr=[];for(const p of r.parts)tr.push(p.positions.buffer,p.normals.buffer,p.indices.buffer);postMessage({id,result:r},tr);}catch(err){postMessage({id,error:String(err&&err.message||err)});}};';
      // The pool keeps the script URL alive while WebKit is still loading it.
      const w = (globalThis.AtriumWorkerPool && AtriumWorkerPool.blobWorker(src));
      if (!w) { unavailable = !workerStarted; return null; }
      workerStarted = true;
      w.onmessage = ({data}) => {
        if (worker !== w) return;
        const finish = waiters.get(data?.id);
        if (!finish) return;
        waiters.delete(data.id);
        finish(data);
      };
      w.onerror = e => { e?.preventDefault?.(); stop(w, "The STEP worker stopped while reading the model."); };
      w.onmessageerror = () => stop(w, "Could not receive the decoded STEP model.");
      return w;
    } catch { unavailable = !workerStarted; return null; }
  }
  // Foreground parsing is available on hosts that could never start a worker.
  function load(text, opts = {}) {
    const invalid = inputError(text);
    if (invalid) return Promise.resolve(failure(invalid));
    if (cache.has(text)) return Promise.resolve(cache.get(text));
    if (inflight.has(text)) return inflight.get(text);
    if (!worker) worker = makeWorker();
    if (!worker) {
      const result = workerStarted ? remember(text, failure("The STEP worker could not restart.")) : ensure(text, opts);
      return Promise.resolve(result);
    }
    const w = worker, id = ++seq, ms = opts.timeoutMs > 0 ? opts.timeoutMs : 20000;
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    inflight.set(text, pending);
    const timer = setTimeout(() => stop(w, "Reading the STEP model took longer than " + Math.round(ms / 1000) + " s and was stopped."), ms);
    waiters.set(id, data => {
      clearTimeout(timer);
      inflight.delete(text);
      resolve(remember(text, data.error ? failure(data.error) : data.result));
    });
    try { w.postMessage({id, text, opts: {tolerance: opts.tolerance}}); }
    catch { stop(w, "Could not send the model to the STEP worker."); }
    return pending;
  }
  const cached = text => cache.get(text) || null;
  // Synchronous read on this thread, cached (DRC needs the box now); errors come back as a result.
  function ensure(text, opts = {}) {
    const invalid = inputError(text);
    if (invalid) return failure(invalid);
    if (cache.has(text)) return cache.get(text);
    try { return remember(text, core.tessellate(text, opts)); }
    catch (e) { return remember(text, failure(e.message)); }
  }
  // Completed geometry is shared across views. Each request can cancel its own pending decoding.
  const assetCache = new Map();
  let assetBytes = 0;
  function rememberAsset(asset, result) {
    const key = asset.zlib || asset.stepText;
    if (!key) return result; // Folder geometry is retained by the owning viewer's board cache.
    const old = assetCache.get(key);
    if (old) { assetBytes -= old.size; assetCache.delete(key); }
    const size = key.length * 2 + result.parts.reduce((n, p) => n + p.positions.byteLength + p.normals.byteLength + p.indices.byteLength, 0);
    while (assetCache.size && (assetCache.size >= 64 || assetBytes + size > 128 * 1048576)) {
      const oldest = assetCache.keys().next().value;
      assetBytes -= assetCache.get(oldest).size; assetCache.delete(oldest);
    }
    if (size <= 128 * 1048576) { assetCache.set(key, {result, size}); assetBytes += size; }
    return result;
  }
  const cachedAsset = asset => assetCache.get(asset.zlib || asset.stepText)?.result || null;
  async function decodeAsset(asset, limit) {
    if (typeof asset?.stepText === "string" && asset.stepText.length <= limit) return asset.stepText;
    if (asset?.bytes instanceof Uint8Array && asset.bytes.byteLength <= limit) return new TextDecoder().decode(asset.bytes);
    if (typeof asset?.zlib !== "string" || asset.zlib.length > 4 * Math.ceil(limit / 3)) throw Error("Invalid compressed STEP size.");
    const bytes = typeof Uint8Array.fromBase64 === "function" ? Uint8Array.fromBase64(asset.zlib) : Uint8Array.from(atob(asset.zlib), c => c.charCodeAt(0));
    // File-origin WebKit workers cannot read their own Blob storage. Feed the
    // existing typed array directly to the inflater, without copying its buffer.
    const source = new ReadableStream({start(controller) { controller.enqueue(bytes); controller.close(); }});
    const reader = source.pipeThrough(new DecompressionStream("deflate")).getReader();
    const chunks = [], decoder = new TextDecoder();
    let total = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if ((total += value.byteLength) > limit) { await reader.cancel(); throw Error("The STEP model exceeds 32 MB."); }
      chunks.push(decoder.decode(value, {stream: true}));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  }
  // Each visible request owns one worker. It can finish a few small bodies while the
  // main thread prepares copper. Bound both the source window and unacknowledged geometry.
  function assetReader(core, decode) {
    return async ({data}) => {
      let sent = 0;
      for (let i = 0; i < data.length; i++) {
        let result, error;
        const transfer = [];
        try {
          result = core.tessellate(await decode(data[i], core.LIMITS.bytes));
          for (const p of result.parts) for (const a of [p.positions, p.normals, p.indices]) {
            transfer.push(a.buffer); sent += a.byteLength;
          }
        } catch (e) { error = e.message; }
        const last = i + 1 === data.length || sent >= 4 * 1048576;
        postMessage({result, error, last}, {transfer});
        if (last) break;
      }
    };
  }
  function assetWorker() {
    try {
      if (typeof Worker !== "function" || typeof DecompressionStream !== "function" || !globalThis.URL?.createObjectURL) return null;
      const src = '"use strict";onmessage=(' + assetReader.toString() + ')((' + STEPCore.toString() + ')(),' + decodeAsset.toString() + ');';
      return (globalThis.AtriumWorkerPool && AtriumWorkerPool.blobWorker(src)) || null;
    } catch { return null; }
  }
  /** @param {any[]} assets @param {{signal?: AbortSignal, readModel?: (asset:any) => Promise<Uint8Array>}} options @param {(asset:any, result:any) => void} receive */
  async function readAssets(assets, {signal, readModel}, receive) {
    const abort = () => Object.assign(Error("STEP loading cancelled."), {name:"AbortError"});
    const key = a => a.zlib || a.stepText || "";
    let w, at = 0;
    try {
      while (at < assets.length) {
        if (signal?.aborted) throw abort();
        const a = assets[at], hit = cachedAsset(a);
        if (hit) { at++; receive(a, hit); continue; }
        let bytes;
        if (!key(a) && a.model) {
          try {
            if (!readModel) throw Error("The project STEP model reader is unavailable.");
            bytes = await readModel(a);
          } catch (e) {
            if (signal?.aborted) throw abort();
            at++; receive(a, failure(e.message)); continue;
          }
          if (signal?.aborted) throw abort();
        }
        if (w === undefined) w = assetWorker();
        if (!w) {
          // A host without workers yields between assets, with the same parser limits.
          await new Promise(done => setTimeout(done, 0));
          if (signal?.aborted) throw abort();
          let result;
          try { result = core.tessellate(bytes ? await decodeAsset({bytes}, core.LIMITS.bytes)
            : a.stepText || globalThis.AtriumImportFormats.stepText(a)); }
          catch (e) { result = failure(e.message); }
          at++; receive(a, rememberAsset(a, result)); continue;
        }
        const batch = [bytes ? {bytes} : a], keys = new Set([key(a)]);
        let inputBytes = key(a).length * 2;
        for (let i = at + 1; !bytes && i < assets.length && batch.length < 8; i++) {
          const k = key(assets[i]); inputBytes += k.length * 2;
          if (!k || inputBytes > 4 * 1048576 || keys.has(k) || cachedAsset(assets[i])) break;
          batch.push(assets[i]); keys.add(k);
        }
        await new Promise((resolve, reject) => {
          let timer;
          const done = error => {
            clearTimeout(timer); signal?.removeEventListener("abort", cancel);
            w.onmessage = w.onerror = w.onmessageerror = null;
            if (error) reject(error); else resolve();
          };
          const cancel = () => done(abort());
          const fail = message => {
            const failed = assets[at++];
            let error;
            try { receive(failed, rememberAsset(failed, failure(message))); } catch (e) { error = e; }
            done(error); w.terminate(); w = undefined;
          };
          const watch = () => { clearTimeout(timer); timer = setTimeout(() => fail("Reading the STEP body exceeded 20 seconds."), 20000); };
          w.onmessage = ({data}) => {
            if (signal?.aborted) { cancel(); return; }
            const asset = assets[at++];
            try { receive(asset, rememberAsset(asset, data.result || failure(data.error))); }
            catch (e) { done(e); return; }
            if (signal?.aborted) return;
            if (data.last) done(); else watch();
          };
          w.onerror = e => { e.preventDefault?.(); fail("The STEP body worker stopped."); };
          w.onmessageerror = () => fail("The STEP body worker returned an unreadable result.");
          signal?.addEventListener("abort", cancel, {once:true});
          watch();
          try { w.postMessage(batch, bytes ? [bytes.buffer] : []); } catch { fail("Could not send the STEP body to its worker."); }
        });
      }
    } finally { w?.terminate(); }
  }
  /** @param {{zlib?: string, stepText?: string}} asset @param {{signal?: AbortSignal}} [options] */
  async function loadAsset(asset, options = {}) {
    let result;
    await readAssets([asset], options, (_, r) => { result = r; });
    return result;
  }
  function summary(r) {
    if (!r) return "";
    if (r.error) return "Not shown in 3D: " + r.error;
    const s = r.stats, b = r.bbox;
    const size = b ? " · " + [0, 1, 2].map(k => (b[k + 3] - b[k]).toFixed(2)).join(" × ") + " mm" : "";
    if (!r.parts.length) return "No supported faces; shown as its bounding box" + size;
    return s.faces + " faces (" + s.planar + " planar, " + s.cylindrical + " cylindrical" + (s.faceted ? ", " + s.faceted + " faceted" : "") + (s.approximated ? ", " + s.approximated + " approximated" : "") + ") · " +
      Math.round(s.triangles / 1000 * 10) / 10 + "k triangles" + size;
  }
  return Object.freeze({LIMITS: Object.freeze({...core.LIMITS}), tessellate: core.tessellate, read: core.read, load, cached, remember, ensure, loadAsset, readAssets, cachedAsset, decodeAsset, summary, core: STEPCore});
})();
