"use strict";
// AtriumSIPng: draws a waveform plot into an RGB raster and encodes it as PNG, inside the extension
// worker (no canvas, no DOM). Lines are drawn with a 1-2 px brush, text with a built-in 5×7 font.
// PNG: filter 1 (Sub) per row, then DEFLATE with fixed Huffman codes and run-length matches
// (distance 1 and 3), which suits flat plot images; CRC-32 and Adler-32 as RFC 1950/1951/2083.
(function () {
  // 5×7 glyphs, one row per entry (bit 4 = left pixel). Lower case is drawn as upper case.
  const FONT = {
    " ": [0, 0, 0, 0, 0, 0, 0], "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
    "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
    "9": [14, 17, 17, 15, 1, 2, 12], "A": [14, 17, 17, 31, 17, 17, 17], "B": [30, 17, 17, 30, 17, 17, 30], "C": [14, 17, 16, 16, 16, 17, 14], "D": [28, 18, 17, 17, 17, 18, 28],
    "E": [31, 16, 16, 30, 16, 16, 31], "F": [31, 16, 16, 30, 16, 16, 16], "G": [14, 17, 16, 23, 17, 17, 15], "H": [17, 17, 17, 31, 17, 17, 17], "I": [14, 4, 4, 4, 4, 4, 14],
    "J": [7, 2, 2, 2, 2, 18, 12], "K": [17, 18, 20, 24, 20, 18, 17], "L": [16, 16, 16, 16, 16, 16, 31], "M": [17, 27, 21, 21, 17, 17, 17], "N": [17, 17, 25, 21, 19, 17, 17],
    "O": [14, 17, 17, 17, 17, 17, 14], "P": [30, 17, 17, 30, 16, 16, 16], "Q": [14, 17, 17, 17, 21, 18, 13], "R": [30, 17, 17, 30, 20, 18, 17], "S": [15, 16, 16, 14, 1, 1, 30],
    "T": [31, 4, 4, 4, 4, 4, 4], "U": [17, 17, 17, 17, 17, 17, 14], "V": [17, 17, 17, 17, 17, 10, 4], "W": [17, 17, 17, 21, 21, 21, 10], "X": [17, 17, 10, 4, 10, 17, 17],
    "Y": [17, 17, 10, 4, 4, 4, 4], "Z": [31, 1, 2, 4, 8, 16, 31], ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8], "-": [0, 0, 0, 31, 0, 0, 0], "+": [0, 4, 4, 31, 4, 4, 0],
    "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8], "/": [1, 1, 2, 4, 8, 16, 16], ":": [0, 12, 12, 0, 12, 12, 0], "%": [24, 25, 2, 4, 8, 19, 3], "=": [0, 0, 31, 0, 31, 0, 0],
    "_": [0, 0, 0, 0, 0, 0, 31], "µ": [0, 17, 17, 17, 19, 29, 16], "Ω": [14, 17, 17, 17, 10, 10, 27], "·": [0, 0, 0, 12, 12, 0, 0], "?": [14, 17, 1, 2, 4, 0, 4], "#": [10, 10, 31, 10, 31, 10, 10]
  };
  const PALETTE = [[54, 112, 196], [214, 128, 18], [56, 150, 76], [200, 70, 62], [134, 92, 196], [32, 150, 150], [170, 140, 20], [110, 110, 110]];

  function raster(w, h, bg) {
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2]; }
    const set = (x, y, c, a = 1) => {
      x |= 0; y |= 0;
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const k = (y * w + x) * 3;
      for (let j = 0; j < 3; j++) px[k + j] = Math.round(px[k + j] * (1 - a) + c[j] * a);
    };
    const line = (x0, y0, x1, y1, c, o = {}) => {
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2)), wd = o.width || 1, dash = o.dash || null;
      for (let i = 0; i <= n; i++) {
        const f = i / n, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
        if (dash) { const d = Math.hypot(x - x0, y - y0) + (o.phase || 0); if (d % (dash[0] + dash[1]) > dash[0]) continue; }
        for (let a = 0; a < wd; a++) for (let b = 0; b < wd; b++) set(x + a - (wd >> 1), y + b - (wd >> 1), c, o.alpha ?? 1);
      }
    };
    const text = (s, x, y, c, scale = 2, anchor = "start") => {
      const str = String(s).toUpperCase(), wch = 6 * scale;
      let cx = anchor === "end" ? x - str.length * wch : anchor === "middle" ? x - str.length * wch / 2 : x;
      for (const ch of str) {
        const g = FONT[ch] || FONT["?"];
        for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (g[r] & (16 >> b)) for (let a = 0; a < scale; a++) for (let d = 0; d < scale; d++) set(cx + b * scale + a, y + r * scale + d, c);
        cx += wch;
      }
    };
    const rect = (x0, y0, x1, y1, c) => { for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(w, x1); x++) set(x, y, c); };
    return {w, h, px, set, line, text, rect};
  }

  // plot: {title, xLabel, yLabel, series:[{name, x, y, color, style}], hlines:[{y, label}], vlines:[{x, label}], xRange, yRange}
  function draw(plot, o = {}) {
    const W = o.width || 1200, H = o.height || 640, L = 110, R = 150, T = 50, B = 70;
    const bg = [255, 255, 255], ink = [40, 40, 40], grid = [222, 222, 222], warn = [200, 120, 0], accent = [30, 100, 200];
    const r = raster(W, H, bg);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of plot.series || []) for (let i = 0; i < s.x.length; i++) if (Number.isFinite(s.x[i]) && Number.isFinite(s.y[i])) { x0 = Math.min(x0, s.x[i]); x1 = Math.max(x1, s.x[i]); y0 = Math.min(y0, s.y[i]); y1 = Math.max(y1, s.y[i]); }
    if (plot.xRange) [x0, x1] = plot.xRange;
    for (const hl of plot.hlines || []) { y0 = Math.min(y0, hl.y); y1 = Math.max(y1, hl.y); }
    if (plot.yRange) [y0, y1] = plot.yRange; else { const p = (y1 - y0) * 0.05 || 0.5; y0 -= p; y1 += p; }
    if (!(x1 > x0)) { x0 = 0; x1 = 1; }
    if (!(y1 > y0)) { y0 = -1; y1 = 1; }
    const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R), sy = y => H - B - (y - y0) / (y1 - y0) * (H - T - B);
    const fmt = n => { const a = Math.abs(n); return a !== 0 && (a >= 1e4 || a < 1e-2) ? n.toExponential(1) : String(Number(n.toPrecision(3))); };
    for (let i = 0; i <= 5; i++) {
      const gx = L + (W - L - R) * i / 5, gy = T + (H - T - B) * i / 5;
      r.line(gx, T, gx, H - B, grid); r.line(L, gy, W - R, gy, grid);
      r.text(fmt(x0 + (x1 - x0) * i / 5), gx, H - B + 10, ink, 2, "middle");
      r.text(fmt(y1 - (y1 - y0) * i / 5), L - 8, gy - 7, ink, 2, "end");
    }
    r.line(L, T, W - R, T, ink); r.line(L, H - B, W - R, H - B, ink); r.line(L, T, L, H - B, ink); r.line(W - R, T, W - R, H - B, ink);
    if (plot.title) r.text(plot.title, L, 14, ink, 2);
    if (plot.xLabel) r.text(plot.xLabel, (L + W - R) / 2, H - 30, ink, 2, "middle");
    if (plot.yLabel) r.text(plot.yLabel, 10, T - 30 + 14, ink, 2);
    const inside = (x, y) => x >= L - 1 && x <= W - R + 1 && y >= T - 1 && y <= H - B + 1;
    for (const hl of plot.hlines || []) { const y = sy(hl.y); if (y >= T && y <= H - B) { r.line(L, y, W - R, y, warn, {dash: [8, 5]}); if (hl.label) r.text(hl.label, W - R + 6, y - 7, warn, 2); } }
    for (const s of plot.series || []) {
      const c = PALETTE[(s.color ?? 0) % PALETTE.length], dash = s.style === "dash" ? [9, 5] : null, alpha = s.style === "faint" ? 0.5 : 1;
      let prev = null, run = 0;
      for (let i = 0; i < s.x.length; i++) {
        if (s.y[i] == null || !Number.isFinite(s.y[i]) || !Number.isFinite(s.x[i])) { prev = null; continue; }
        const p = [sx(s.x[i]), Math.max(T, Math.min(H - B, sy(s.y[i])))];
        if (prev && inside(p[0], p[1]) && inside(prev[0], prev[1])) { r.line(prev[0], prev[1], p[0], p[1], c, {width: 2, dash, alpha, phase: run}); run += Math.hypot(p[0] - prev[0], p[1] - prev[1]); }
        prev = p;
      }
    }
    for (const vl of plot.vlines || []) { const x = sx(vl.x); if (x >= L && x <= W - R) { r.line(x, T, x, H - B, accent); if (vl.label) r.text(vl.label, x + 4, T + 4, accent, 2); } }
    // Legend on the right.
    let ly = T;
    const seen = new Set();
    for (const s of plot.series || []) {
      const key = s.name + "|" + s.color + "|" + s.style;
      if (seen.has(key) || ly > H - B - 16) continue;
      seen.add(key);
      const c = PALETTE[(s.color ?? 0) % PALETTE.length];
      r.line(W - R + 8, ly + 6, W - R + 26, ly + 6, c, {width: 2, dash: s.style === "dash" ? [5, 3] : null, alpha: s.style === "faint" ? 0.5 : 1});
      r.text(String(s.name).slice(0, 18), W - R + 30, ly, ink, 1);
      ly += 14;
    }
    return r;
  }

  // ------------------------------------------------------------------ PNG
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes, start, end) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  // Fixed-Huffman DEFLATE with run-length matches.
  function deflate(data) {
    const out = [];
    let bit = 0, cur = 0;
    const put = (v, n) => { for (let i = 0; i < n; i++) { cur |= ((v >> i) & 1) << bit; if (++bit === 8) { out.push(cur); cur = 0; bit = 0; } } };
    const putRev = (code, n) => { for (let i = n - 1; i >= 0; i--) { cur |= ((code >> i) & 1) << bit; if (++bit === 8) { out.push(cur); cur = 0; bit = 0; } } };
    const lit = v => { if (v < 144) putRev(0x30 + v, 8); else if (v < 256) putRev(0x190 + v - 144, 9); else if (v < 280) putRev(v - 256, 7); else putRev(0xc0 + v - 280, 8); };
    const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const match = (len, dist) => {
      let k = LBASE.length - 1; while (LBASE[k] > len) k--;
      lit(257 + k); put(len - LBASE[k], LEXT[k]);
      putRev(dist === 1 ? 0 : 2, 5); // distance codes 0 (1) and 2 (3), no extra bits
    };
    put(1, 1); put(1, 2); // final block, fixed Huffman
    const n = data.length;
    let i = 0;
    while (i < n) {
      let best = 0, dist = 0;
      for (const d of [1, 3]) {
        if (i < d) continue;
        let l = 0; while (l < 258 && i + l < n && data[i + l] === data[i + l - d]) l++;
        if (l > best) { best = l; dist = d; }
      }
      if (best >= 3) { match(best, dist); i += best; } else { lit(data[i]); i++; }
    }
    lit(256);
    if (bit) out.push(cur);
    return Uint8Array.from(out);
  }
  function adler32(d) { let a = 1, b = 0; for (let i = 0; i < d.length; i++) { a = (a + d[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
  function encode(r) {
    const {w, h, px} = r, stride = w * 3, raw = new Uint8Array((stride + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (stride + 1), s = y * stride;
      raw[o] = 1; // Sub
      for (let x = 0; x < stride; x++) raw[o + 1 + x] = (px[s + x] - (x >= 3 ? px[s + x - 3] : 0)) & 255;
    }
    const z = deflate(raw), ad = adler32(raw);
    const idat = new Uint8Array(2 + z.length + 4);
    idat[0] = 0x78; idat[1] = 0x01; idat.set(z, 2);
    idat[idat.length - 4] = ad >>> 24; idat[idat.length - 3] = (ad >>> 16) & 255; idat[idat.length - 2] = (ad >>> 8) & 255; idat[idat.length - 1] = ad & 255;
    const chunks = [];
    const chunk = (type, data) => {
      const c = new Uint8Array(12 + data.length), len = data.length;
      c[0] = len >>> 24; c[1] = (len >>> 16) & 255; c[2] = (len >>> 8) & 255; c[3] = len & 255;
      for (let k = 0; k < 4; k++) c[4 + k] = type.charCodeAt(k);
      c.set(data, 8);
      const crc = crc32(c, 4, 8 + len);
      c[8 + len] = crc >>> 24; c[9 + len] = (crc >>> 16) & 255; c[10 + len] = (crc >>> 8) & 255; c[11 + len] = crc & 255;
      chunks.push(c);
    };
    const ihdr = new Uint8Array(13);
    ihdr[0] = w >>> 24; ihdr[1] = (w >>> 16) & 255; ihdr[2] = (w >>> 8) & 255; ihdr[3] = w & 255;
    ihdr[4] = h >>> 24; ihdr[5] = (h >>> 16) & 255; ihdr[6] = (h >>> 8) & 255; ihdr[7] = h & 255;
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    chunk("IHDR", ihdr); chunk("IDAT", idat); chunk("IEND", new Uint8Array(0));
    const total = 8 + chunks.reduce((s, c) => s + c.length, 0), outb = new Uint8Array(total);
    outb.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    let o = 8; for (const c of chunks) { outb.set(c, o); o += c.length; }
    return outb;
  }
  const png = (plot, o) => encode(draw(plot, o));

  const api = {version: "1.0.0", draw, encode, png, deflate, crc32, FONT};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSIPng = api;
})();
