"use strict";

// Raster to vector conversion shared by PCB text (TrueType glyphs, knockout
// text) and the Logo Creator.
//
// The tracer runs marching squares over an 8-bit "ink" field (0 = paper,
// 255 = ink) and interpolates each crossing between pixel centres, so
// anti-aliased input (rendered glyphs, smooth logos) gives sub-pixel accurate
// outlines. Contours are walked cell to cell with ink on the right, which in
// the Y-down pixel frame makes outer boundaries positive (shoelace area > 0)
// and holes negative; holes are then attached to the smallest enclosing
// outer. Douglas-Peucker removes redundant vertices.
//
// Everything works on typed arrays: a 2000 x 2000 image needs the field and a
// one-byte mask and visited flag per pixel (about 12 MB) and no per-pixel
// objects. Output rings are arrays of [x, y] in pixel units with Y down.
globalThis.AtriumVectorize = (() => {
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  // ---------------------------------------------------------------------------
  // Fields
  // `mode` "luminance": ink is darker than `threshold` (composited on white).
  // `mode` "alpha": ink is at least `threshold` opaque. `invert` swaps ink and
  // paper. Returns {field, level}: a sample is ink when field > level.
  function inkField(img, o = {}) {
    const w = img.width, h = img.height, d = img.data, n = w * h, f = new Uint8Array(n);
    const t = clamp(Math.round(o.threshold ?? 128), 1, 255), alpha = o.mode === "alpha";
    // inkLow: ink is where the base value is below the threshold.
    const inkLow = alpha ? !!o.invert : !o.invert;
    if (alpha) for (let i = 0, j = 3; i < n; i++, j += 4) f[i] = d[j];
    else for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = d[j + 3], lum = (77 * d[j] + 150 * d[j + 1] + 29 * d[j + 2]) >> 8;
      f[i] = (lum * a + 255 * (255 - a) + 127) / 255 | 0;
    }
    if (inkLow) for (let i = 0; i < n; i++) f[i] = 255 - f[i];
    return {field: f, level: inkLow ? 255.5 - t : t - .5};
  }

  // Separable box blur applied twice (close to a Gaussian of sigma ~ 0.8 r),
  // with paper outside the image. In place; `tmp` is reused scratch.
  function blur(f, w, h, r) {
    r = Math.round(r);
    if (!(r >= 1)) return f;
    const tmp = new Uint8Array(f.length), div = 2 * r + 1;
    const pass = (src, dst, len, lines, step, lineStep) => {
      for (let l = 0; l < lines; l++) {
        const base = l * lineStep;
        let sum = 0;
        for (let k = 0; k <= r && k < len; k++) sum += src[base + k * step];
        for (let k = 0; k < len; k++) {
          dst[base + k * step] = (sum + (div >> 1)) / div | 0;
          const add = k + r + 1, sub = k - r;
          if (add < len) sum += src[base + add * step];
          if (sub >= 0) sum -= src[base + sub * step];
        }
      }
    };
    for (let it = 0; it < 2; it++) {
      pass(f, tmp, w, h, 1, w);
      pass(tmp, f, h, w, w, 1);
    }
    return f;
  }

  // ---------------------------------------------------------------------------
  // Marching squares
  // Corners: tl=1, tr=2, br=4, bl=8. Edges: 0 top, 1 right, 2 bottom, 3 left.
  // An edge is an entry when its first corner (clockwise) is ink and its
  // second is not; walking with ink on the right.
  const EXIT_IN = new Int8Array(64).fill(-1), EXIT_OUT = new Int8Array(64).fill(-1);
  (() => {
    const corners = [[1, 2], [2, 4], [4, 8], [8, 1]];
    for (let c = 1; c < 15; c++) {
      const entries = [], exits = [];
      corners.forEach(([a, b], e) => {
        if ((c & a) && !(c & b)) entries.push(e);
        if (!(c & a) && (c & b)) exits.push(e);
      });
      if (entries.length === 1) { EXIT_IN[c * 4 + entries[0]] = EXIT_OUT[c * 4 + entries[0]] = exits[0]; }
    }
    // Saddles: tl+br (5) and tr+bl (10). Centre ink joins the diagonal.
    EXIT_IN[5 * 4 + 0] = 1; EXIT_IN[5 * 4 + 2] = 3; EXIT_OUT[5 * 4 + 0] = 3; EXIT_OUT[5 * 4 + 2] = 1;
    EXIT_IN[10 * 4 + 3] = 0; EXIT_IN[10 * 4 + 1] = 2; EXIT_OUT[10 * 4 + 1] = 0; EXIT_OUT[10 * 4 + 3] = 2;
  })();
  const ENTRY_MASK = new Uint8Array(16);
  for (let c = 1; c < 15; c++) for (let e = 0; e < 4; e++) if (EXIT_IN[c * 4 + e] >= 0) ENTRY_MASK[c] |= 1 << e;

  let scratch = new Float64Array(8192);
  const grow = need => { if (need > scratch.length) { const s = new Float64Array(Math.max(need, scratch.length * 2)); s.set(scratch); scratch = s; } };

  // Traces every contour of `field > level`. Returns raw flat rings (Float64Array
  // x,y pairs) with their signed area, after optional simplification.
  function contours(field, w, h, level, o = {}) {
    const W2 = w + 2, mask = new Uint8Array(W2 * (h + 2));
    for (let y = 0; y < h; y++) {
      const row = (y + 1) * W2 + 1, src = y * w;
      for (let x = 0; x < w; x++) if (field[src + x] > level) mask[row + x] = 1;
    }
    const CW = w + 1, visited = new Uint8Array(CW * (h + 1));
    const minArea = Math.max(0, o.turdSize || 0), tol = Math.max(0, o.tolerance ?? .5);
    const out = [];
    const v = (x, y) => x < 0 || y < 0 || x >= w || y >= h ? 0 : field[y * w + x];
    const caseAt = (cx, cy) => {
      const i = cy * W2 + cx;
      return mask[i] | mask[i + 1] << 1 | mask[i + W2 + 1] << 2 | mask[i + W2] << 3;
    };
    function walk(sx, sy, se) {
      let cx = sx, cy = sy, e = se, n = 0;
      for (;;) {
        const c = caseAt(cx, cy);
        let exit;
        if (c === 5 || c === 10) {
          const centre = (v(cx - 1, cy - 1) + v(cx, cy - 1) + v(cx, cy) + v(cx - 1, cy)) / 4;
          exit = (centre > level ? EXIT_IN : EXIT_OUT)[c * 4 + e];
        } else exit = EXIT_IN[c * 4 + e];
        visited[cy * CW + cx] |= 1 << e;
        let x, y, a, b;
        if (exit === 0) { a = v(cx - 1, cy - 1); b = v(cx, cy - 1); x = cx - .5 + (level - a) / (b - a); y = cy - .5; }
        else if (exit === 1) { a = v(cx, cy - 1); b = v(cx, cy); x = cx + .5; y = cy - .5 + (level - a) / (b - a); }
        else if (exit === 2) { a = v(cx - 1, cy); b = v(cx, cy); x = cx - .5 + (level - a) / (b - a); y = cy + .5; }
        else { a = v(cx - 1, cy - 1); b = v(cx - 1, cy); x = cx - .5; y = cy - .5 + (level - a) / (b - a); }
        grow(n + 2); scratch[n++] = x; scratch[n++] = y;
        if (exit === 0) { cy--; e = 2; } else if (exit === 1) { cx++; e = 3; } else if (exit === 2) { cy++; e = 0; } else { cx--; e = 1; }
        if (cx === sx && cy === sy && e === se) break;
      }
      return n >> 1;
    }
    for (let cy = 0; cy <= h; cy++) {
      for (let cx = 0; cx <= w; cx++) {
        const c = caseAt(cx, cy);
        if (c === 0 || c === 15) continue;
        let free = ENTRY_MASK[c] & ~visited[cy * CW + cx];
        while (free) {
          const e = 31 - Math.clz32(free & -free);
          free &= ~(1 << e);
          if (visited[cy * CW + cx] & (1 << e)) continue;
          const count = walk(cx, cy, e);
          const area = flatArea(scratch, count);
          if (Math.abs(area) < minArea || count < 3) continue;
          const ring = simplifyFlat(scratch, count, tol);
          if (ring.length >= 6) out.push({ring, area});
        }
      }
    }
    return out;
  }

  function flatArea(p, n) {
    let s = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) s += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1];
    return s / 2;
  }

  // Douglas-Peucker on a closed flat ring; returns a new Float64Array.
  let keepBuf = new Uint8Array(1024), stackBuf = new Int32Array(2048);
  function simplifyFlat(p, n, tol) {
    if (tol <= 0 || n <= 4) return p.slice(0, 2 * n);
    if (keepBuf.length < n + 1) keepBuf = new Uint8Array(n * 2);
    if (stackBuf.length < 2 * n + 4) stackBuf = new Int32Array(4 * n + 8);
    const keep = keepBuf; keep.fill(0, 0, n + 1);
    let far = 0, best = -1;
    for (let i = 1; i < n; i++) {
      const dx = p[2 * i] - p[0], dy = p[2 * i + 1] - p[1], d = dx * dx + dy * dy;
      if (d > best) { best = d; far = i; }
    }
    keep[0] = keep[far] = 1;
    let sp = 0;
    stackBuf[sp++] = 0; stackBuf[sp++] = far; stackBuf[sp++] = far; stackBuf[sp++] = n;
    const tol2 = tol * tol;
    while (sp) {
      const b = stackBuf[--sp], a = stackBuf[--sp];
      if (b - a < 2) continue;
      const bi = b % n, ax = p[2 * a], ay = p[2 * a + 1], bx = p[2 * bi], by = p[2 * bi + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let worst = -1, at = -1;
      for (let i = a + 1; i < b; i++) {
        let ex = p[2 * i] - ax, ey = p[2 * i + 1] - ay, d;
        if (len2 > 0) {
          const t = (ex * dx + ey * dy) / len2;
          if (t <= 0) d = ex * ex + ey * ey;
          else if (t >= 1) { ex -= dx; ey -= dy; d = ex * ex + ey * ey; }
          else { const c = ex * dy - ey * dx; d = c * c / len2; }
        } else d = ex * ex + ey * ey;
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > tol2) { keep[at] = 1; stackBuf[sp++] = a; stackBuf[sp++] = at; stackBuf[sp++] = at; stackBuf[sp++] = b; }
    }
    let m = 0;
    for (let i = 0; i < n; i++) if (keep[i]) m++;
    const r = new Float64Array(2 * m);
    for (let i = 0, k = 0; i < n; i++) if (keep[i]) { r[k++] = p[2 * i]; r[k++] = p[2 * i + 1]; }
    return r;
  }

  // ---------------------------------------------------------------------------
  // Ring helpers (rings are arrays of [x, y])
  function area(ring) {
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return s / 2;
  }
  function contains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function containsFlat(p, x, y) {
    let inside = false;
    const n = p.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * j], by = p[2 * j + 1];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  }
  function boundsFlat(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }
  const toPoints = p => { const r = new Array(p.length >> 1); for (let i = 0; i < r.length; i++) r[i] = [p[2 * i], p[2 * i + 1]]; return r; };

  // Groups raw contours into polygons with holes.
  function nest(raw) {
    const outers = [], holes = [];
    for (const c of raw) { c.box = boundsFlat(c.ring); (c.area > 0 ? outers : holes).push(c); }
    outers.sort((a, b) => a.area - b.area);
    for (const o of outers) o.holes = [];
    for (const hole of holes) {
      const hb = hole.box, x = hole.ring[0], y = hole.ring[1];
      for (const o of outers) {
        const b = o.box;
        if (b[0] > hb[0] || b[1] > hb[1] || b[2] < hb[2] || b[3] < hb[3] || o.area < -hole.area) continue;
        if (containsFlat(o.ring, x, y)) { o.holes.push(hole); break; }
      }
    }
    outers.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    return outers.map(o => ({outer: toPoints(o.ring), holes: o.holes.map(h => toPoints(h.ring)),
      area: o.area + o.holes.reduce((s, h) => s + h.area, 0)}));
  }

  function stats(polygons) {
    let rings = 0, vertices = 0, inkArea = 0;
    for (const p of polygons) { rings += 1 + p.holes.length; vertices += p.outer.length; for (const h of p.holes) vertices += h.length; inkArea += p.area; }
    return {polygons: polygons.length, rings, vertices, area: inkArea};
  }

  // Traces a prepared field. Options: smoothing (blur radius px), turdSize
  // (minimum ring area px^2), tolerance (Douglas-Peucker px).
  function traceField(field, w, h, level, o = {}) {
    if (o.smoothing >= 1) field = blur(o.copy === false ? field : field.slice(), w, h, o.smoothing);
    const polygons = nest(contours(field, w, h, level, o));
    return {width: w, height: h, polygons, stats: stats(polygons)};
  }

  // ---------------------------------------------------------------------------
  // Colour quantisation (k-means on a sample, deterministic farthest-point
  // seeding). Returns {palette:[[r,g,b]], labels:Uint8Array, counts}; label
  // 255 marks transparent pixels.
  function quantize(img, k, fixed) {
    const d = img.data, n = img.width * img.height, labels = new Uint8Array(n);
    let palette;
    if (Array.isArray(fixed) && fixed.length) palette = fixed.map(c => [c[0], c[1], c[2]]);
    else {
      k = clamp(Math.round(k || 2), 2, 16);
      const step = Math.max(1, Math.floor(n / 20000)), sample = [];
      for (let i = 0; i < n; i += step) if (d[4 * i + 3] >= 128) sample.push(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
      const m = sample.length / 3;
      if (!m) return {palette: [], labels: labels.fill(255), counts: []};
      // Seed with the mean colour's farthest sample, then farthest-point.
      palette = [[sample[0], sample[1], sample[2]]];
      const dist = new Float64Array(m).fill(Infinity);
      while (palette.length < k) {
        const c = palette.at(-1);
        let best = -1, at = 0;
        for (let i = 0; i < m; i++) {
          const dr = sample[3 * i] - c[0], dg = sample[3 * i + 1] - c[1], db = sample[3 * i + 2] - c[2];
          const v = dr * dr + dg * dg + db * db;
          if (v < dist[i]) dist[i] = v;
          if (dist[i] > best) { best = dist[i]; at = i; }
        }
        if (best <= 0) break;
        palette.push([sample[3 * at], sample[3 * at + 1], sample[3 * at + 2]]);
      }
      for (let it = 0; it < 10; it++) {
        const sum = new Float64Array(palette.length * 4);
        for (let i = 0; i < m; i++) {
          const r = sample[3 * i], g = sample[3 * i + 1], b = sample[3 * i + 2];
          let best = Infinity, at = 0;
          for (let c = 0; c < palette.length; c++) {
            const p = palette[c], v = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
            if (v < best) { best = v; at = c; }
          }
          sum[4 * at] += r; sum[4 * at + 1] += g; sum[4 * at + 2] += b; sum[4 * at + 3]++;
        }
        let moved = 0;
        palette = palette.map((p, c) => {
          const cnt = sum[4 * c + 3];
          if (!cnt) return p;
          const q = [Math.round(sum[4 * c] / cnt), Math.round(sum[4 * c + 1] / cnt), Math.round(sum[4 * c + 2] / cnt)];
          moved += Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]);
          return q;
        });
        if (!moved) break;
      }
    }
    const counts = new Array(palette.length).fill(0), P = palette.length;
    const pr = new Int32Array(P), pg = new Int32Array(P), pb = new Int32Array(P);
    palette.forEach((p, c) => { pr[c] = p[0]; pg[c] = p[1]; pb[c] = p[2]; });
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (d[j + 3] < 128) { labels[i] = 255; continue; }
      const r = d[j], g = d[j + 1], b = d[j + 2];
      let best = 1e9, at = 0;
      for (let c = 0; c < P; c++) { const v = (r - pr[c]) ** 2 + (g - pg[c]) ** 2 + (b - pb[c]) ** 2; if (v < best) { best = v; at = c; } }
      labels[i] = at; counts[at]++;
    }
    return {palette, labels, counts};
  }
  const hex = c => "#" + c.map(v => clamp(v | 0, 0, 255).toString(16).padStart(2, "0")).join("");

  // Background colour index: the most common label on the image border.
  function borderLabel(labels, w, h) {
    const tally = new Map(), add = i => tally.set(labels[i], (tally.get(labels[i]) || 0) + 1);
    for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
    let best = -1, at = 255;
    for (const [k, v] of tally) if (v > best) { best = v; at = k; }
    return at;
  }

  // ---------------------------------------------------------------------------
  // Public entry point.
  // trace(imageData, {threshold, invert, mode:"luminance"|"alpha"|"color",
  //   colors (count or [[r,g,b]]), turdSize, smoothing, tolerance})
  // Monochrome result: {width, height, polygons, stats, mask?}. Colour result
  // adds layers: [{color, hex, count, background, polygons, stats}].
  function trace(img, o = {}) {
    const w = img.width, h = img.height;
    if (!(w > 0 && h > 0) || !img.data || img.data.length < w * h * 4) throw Error("Expected RGBA image data.");
    if (o.mode === "color") {
      const q = quantize(img, typeof o.colors === "number" ? o.colors : 2, Array.isArray(o.colors) ? o.colors : null);
      const bg = o.background ?? borderLabel(q.labels, w, h), f = new Uint8Array(w * h), layers = [];
      for (let c = 0; c < q.palette.length; c++) {
        if (o.skipBackground !== false && c === bg) { layers.push({color: q.palette[c], hex: hex(q.palette[c]), count: q.counts[c], background: true, polygons: [], stats: stats([])}); continue; }
        for (let i = 0; i < f.length; i++) f[i] = q.labels[i] === c ? 255 : 0;
        const r = traceField(f, w, h, 127.5, {...o, copy: true});
        layers.push({color: q.palette[c], hex: hex(q.palette[c]), count: q.counts[c], background: false, polygons: r.polygons, stats: r.stats});
      }
      const all = layers.flatMap(l => l.polygons);
      return {width: w, height: h, layers, polygons: all, stats: stats(all), labels: o.keepMask ? q.labels : undefined};
    }
    const {field, level} = inkField(img, o);
    const r = traceField(field, w, h, level, {...o, copy: false});
    if (o.keepMask) { r.field = field; r.level = level; }
    return r;
  }

  // ---------------------------------------------------------------------------
  // Minimum feature check. Uses a 3-4 chamfer distance transform: ink that
  // does not survive a morphological opening by `r` pixels is thinner than
  // 2r ("thin"); paper that does not survive a closing is a gap narrower than
  // 2r ("gaps"). Returns masks and pixel counts for preview highlighting.
  function chamfer(src, w, h, wantInk) {
    const D = new Uint16Array(w * h), BIG = 65000;
    for (let i = 0; i < D.length; i++) D[i] = (src[i] !== 0) === wantInk ? BIG : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let v = D[i]; if (!v) continue;
      // Pixels on the image border are next to paper outside.
      if (wantInk && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) v = Math.min(v, 3);
      if (x > 0) v = Math.min(v, D[i - 1] + 3);
      if (y > 0) { v = Math.min(v, D[i - w] + 3); if (x > 0) v = Math.min(v, D[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, D[i - w + 1] + 4); }
      D[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; let v = D[i]; if (!v) continue;
      if (x < w - 1) v = Math.min(v, D[i + 1] + 3);
      if (y < h - 1) { v = Math.min(v, D[i + w] + 3); if (x < w - 1) v = Math.min(v, D[i + w + 1] + 4); if (x > 0) v = Math.min(v, D[i + w - 1] + 4); }
      D[i] = v;
    }
    return D;
  }
  // Opening of `mask` (1 = set) by radius r px; returns the opened mask.
  // Chamfer distances run centre to centre, so a pixel whose distance to the
  // nearest paper centre is d lies d - 0.5 px from the boundary.
  function open(mask, w, h, r) {
    const R = r * 3 + 1.5, inner = chamfer(mask, w, h, true), core = new Uint8Array(w * h);
    for (let i = 0; i < core.length; i++) core[i] = inner[i] >= R ? 1 : 0;
    // Grow back by sqrt(2) r so square corners are kept: only features
    // narrower than 2r and acute tips are lost.
    const out = chamfer(core, w, h, false), back = 3 * (r * Math.SQRT2 + .5) + 1;
    const opened = new Uint8Array(w * h);
    for (let i = 0; i < core.length; i++) opened[i] = mask[i] && out[i] <= back ? 1 : 0;
    return opened;
  }
  function maskOf(field, level) { const m = new Uint8Array(field.length); for (let i = 0; i < m.length; i++) m[i] = field[i] > level ? 1 : 0; return m; }
  function features(mask, w, h, r) {
    if (!(r > .5)) return {thin: null, gaps: null, thinCount: 0, gapCount: 0};
    const opened = open(mask, w, h, r), thin = new Uint8Array(w * h);
    let thinCount = 0, gapCount = 0;
    for (let i = 0; i < thin.length; i++) if (mask[i] && !opened[i]) { thin[i] = 1; thinCount++; }
    const paper = new Uint8Array(w * h);
    for (let i = 0; i < paper.length; i++) paper[i] = mask[i] ? 0 : 1;
    const closed = open(paper, w, h, r), gaps = new Uint8Array(w * h);
    for (let i = 0; i < gaps.length; i++) if (paper[i] && !closed[i]) { gaps[i] = 1; gapCount++; }
    return {thin, gaps, thinCount, gapCount, opened};
  }

  // ---------------------------------------------------------------------------
  // Rasterisers (anti-aliased, max-combined into a Uint8 field). Used to turn
  // stroke text and glyph polygons into ink for knockout text.
  // map: {scale, ox, oy}: pixel = (x - ox) * scale.
  function rasterStrokes(f, w, h, strokes, map) {
    const s = map.scale;
    for (const st of strokes) {
      const r = st.width * s / 2, pts = st.points;
      const seg = (ax, ay, bx, by) => {
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1));
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        for (let y = y0; y <= y1; y++) {
          const py = y + .5;
          for (let x = x0; x <= x1; x++) {
            const px = x + .5;
            let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = px - ax - t * dx, ey = py - ay - t * dy, d = Math.sqrt(ex * ex + ey * ey);
            const c = r - d + .5;
            if (c <= 0) continue;
            const v = c >= 1 ? 255 : c * 255 + .5 | 0, i = y * w + x;
            if (v > f[i]) f[i] = v;
          }
        }
      };
      const P = pts.map(p => [(p[0] - map.ox) * s, (p[1] - map.oy) * s]);
      if (P.length === 1) seg(P[0][0], P[0][1], P[0][0], P[0][1]);
      for (let k = 1; k < P.length; k++) seg(P[k - 1][0], P[k - 1][1], P[k][0], P[k][1]);
    }
    return f;
  }
  // Nonzero-winding polygon fill with 4 sub-scanlines and exact horizontal
  // coverage. `rings` is a list of [x, y] rings (any orientation per ring is
  // honoured as winding).
  function rasterPolygons(f, w, h, rings, map) {
    const s = map.scale, edges = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = (ring[j][0] - map.ox) * s, ay = (ring[j][1] - map.oy) * s, bx = (ring[i][0] - map.ox) * s, by = (ring[i][1] - map.oy) * s;
        if (ay === by) continue;
        const dir = by > ay ? 1 : -1, y0 = Math.min(ay, by), y1 = Math.max(ay, by);
        edges.push({y0, y1, x: ay < by ? ax : bx, k: (bx - ax) / (by - ay), dir});
      }
    }
    if (!edges.length) return f;
    edges.sort((a, b) => a.y0 - b.y0);
    const S = 4, acc = new Float32Array(w + 2), diff = new Float32Array(w + 2), xs = [];
    let next = 0, active = [];
    const yStart = Math.max(0, Math.floor(edges[0].y0)), yEnd = Math.min(h - 1, Math.ceil(Math.max(...edges.map(e => e.y1))));
    const add = (xa, xb, c) => {
      xa = clamp(xa, 0, w); xb = clamp(xb, 0, w);
      if (xb <= xa) return;
      const ia = Math.floor(xa), ib = Math.floor(xb);
      if (ia === ib) { acc[ia] += (xb - xa) * c; return; }
      acc[ia] += (ia + 1 - xa) * c;
      diff[ia + 1] += c; diff[ib] -= c;
      if (ib < w) acc[ib] += (xb - ib) * c;
    };
    for (let y = yStart; y <= yEnd; y++) {
      acc.fill(0); diff.fill(0);
      let any = false;
      for (let sub = 0; sub < S; sub++) {
        const sy = y + (sub + .5) / S;
        while (next < edges.length && edges[next].y0 <= sy) active.push(edges[next++]);
        active = active.filter(e => e.y1 > sy);
        xs.length = 0;
        for (const e of active) if (e.y0 <= sy) xs.push([e.x + (sy - (e.dir > 0 ? e.y0 : e.y0)) * e.k, e.dir]);
        if (xs.length < 2) continue;
        xs.sort((a, b) => a[0] - b[0]);
        let wind = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          wind += xs[i][1];
          if (wind !== 0) { add(xs[i][0], xs[i + 1][0], 1 / S); any = true; }
        }
      }
      if (!any) continue;
      let run = 0;
      for (let x = 0; x < w; x++) {
        run += diff[x];
        const c = acc[x] + run;
        if (c <= 0) continue;
        const v = c >= 1 ? 255 : c * 255 + .5 | 0, i = y * w + x;
        if (v > f[i]) f[i] = v;
      }
    }
    return f;
  }

  // ---------------------------------------------------------------------------
  // Polygon with holes to one ring, using zero-width bridges (cut-ins) from
  // each hole's rightmost vertex to a visible outer vertex, as allowed for
  // Gerber G36 regions and used by KiCad. `outer` must have positive area
  // (Y-down shoelace) and holes negative; rings are reoriented if not.
  function bridge(polygon) {
    let ring = polygon.outer.slice();
    if (area(ring) < 0) ring.reverse();
    const holes = (polygon.holes || []).filter(h => h.length >= 3).map(h => {
      h = area(h) > 0 ? h.slice().reverse() : h.slice();
      let m = 0;
      for (let i = 1; i < h.length; i++) if (h[i][0] > h[m][0] || (h[i][0] === h[m][0] && h[i][1] < h[m][1])) m = i;
      return {h, m, x: h[m][0]};
    }).sort((a, b) => b.x - a.x);
    for (const {h, m} of holes) {
      const M = h[m], at = visible(ring, M);
      if (at < 0) continue;
      const P = ring[at], loop = [];
      for (let k = 0; k <= h.length; k++) loop.push(h[(m + k) % h.length]);
      ring = [...ring.slice(0, at + 1), ...loop, [P[0], P[1]], ...ring.slice(at + 1)];
    }
    return ring;
  }
  // Index of a ring vertex visible from M along +x (Eberly's method).
  function visible(ring, M) {
    const n = ring.length, mx = M[0], my = M[1];
    let best = Infinity, edge = -1, ix = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      if ((a[1] > my) === (b[1] > my)) continue;
      const x = a[0] + (my - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (x >= mx && x - mx < best) { best = x - mx; edge = i; ix = x; }
    }
    if (edge < 0) return -1;
    const a = ring[edge], b = ring[(edge + 1) % n];
    if (a[1] === my && a[0] === ix) return edge;
    if (b[1] === my && b[0] === ix) return (edge + 1) % n;
    let P = a[0] > b[0] ? edge : (edge + 1) % n;
    const p = ring[P];
    // Vertices inside triangle M, I, P block the view; take the one at the
    // smallest angle to the ray.
    const tri = (x, y) => {
      const s1 = (ix - mx) * (y - my) - (my - my) * (x - mx);
      const s2 = (p[0] - ix) * (y - my) - (p[1] - my) * (x - ix);
      const s3 = (mx - p[0]) * (y - p[1]) - (my - p[1]) * (x - p[0]);
      return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
    };
    let bestAngle = Infinity, bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      if (i === P) continue;
      const q = ring[i];
      if (q[0] < mx || !tri(q[0], q[1])) continue;
      const prev = ring[(i + n - 1) % n], next = ring[(i + 1) % n];
      const cross = (q[0] - prev[0]) * (next[1] - q[1]) - (q[1] - prev[1]) * (next[0] - q[0]);
      if (cross > 0) continue; // convex vertices cannot obstruct
      const ang = Math.abs(Math.atan2(q[1] - my, q[0] - mx)), dist = Math.hypot(q[0] - mx, q[1] - my);
      if (ang < bestAngle - 1e-12 || (Math.abs(ang - bestAngle) <= 1e-12 && dist < bestDist)) { bestAngle = ang; bestDist = dist; P = i; }
    }
    return P;
  }

  // Simplify a ring of [x, y] points.
  function simplify(ring, tol) {
    const flat = new Float64Array(ring.length * 2);
    ring.forEach((p, i) => { flat[2 * i] = p[0]; flat[2 * i + 1] = p[1]; });
    return toPoints(simplifyFlat(flat, ring.length, tol));
  }

  return {inkField, blur, traceField, trace, quantize, hex, features, open, maskOf, chamfer,
    rasterStrokes, rasterPolygons, bridge, simplify, area, contains, stats, contours, nest};
})();
