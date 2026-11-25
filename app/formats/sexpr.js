"use strict";
// Shared infrastructure for the KiCad, Eagle and EasyEDA importers.
//
// AtriumSexpr parses S-expression text (KiCad 6–9 .kicad_sch/.kicad_pcb) into
// nested arrays: (head a "b" (c)) -> ["head","a","b",["c"]]. Quoted strings and
// bare atoms both become strings; numbers are read on demand with num().
//
// AtriumImportFormats is the entry point the editor and the MCP server use:
//   handles(name)            -> true for an extension one of these importers reads
//   read(name, bytes)        -> {documents, library, notes} for one file
//   readSet([{name, bytes}]) -> one result per file, in order, after cross-file
//                               linking (KiCad project settings, sheet references)
// Everything is written from the publicly documented file formats; see
// tests/import-*.cjs for the synthetic fixtures that pin the behaviour.
globalThis.AtriumSexpr = (() => {
  const MAX_DEPTH = 256, MAX_TEXT = 512 * 1024 * 1024, MAX_LISTS = 20000000;
  function parse(text, {comments = false} = {}) {
    if (text.length > MAX_TEXT) throw Error("The file is too large to import.");
    const n = text.length, root = [], stack = [root];
    let i = 0, top = root, lists = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 40) {
        if (stack.length > MAX_DEPTH) throw Error("The file nests lists too deeply (over " + MAX_DEPTH + " levels).");
        if (++lists > MAX_LISTS) throw Error("The file has too many objects to import (over " + MAX_LISTS.toLocaleString("en") + " lists).");
        const l = []; top.push(l); stack.push(l); top = l; i++;
      }
      else if (c === 41) { if (stack.length < 2) throw Error("Unbalanced ')' at character " + i + "."); stack.pop(); top = stack[stack.length - 1]; i++; }
      else if (comments && c === 35) { const next = text.indexOf("\n", i); i = next < 0 ? n : next + 1; }
      else if (c <= 32) i++;
      else if (c === 34) {
        let s = "", j = i + 1;
        for (;;) {
          if (j >= n) throw Error("Unterminated string: the file is truncated.");
          const d = text.charCodeAt(j);
          if (d === 34) break;
          if (d === 92) {
            const e = text[j + 1];
            s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === undefined ? "" : e;
            j += 2; continue;
          }
          let k = j;
          while (k < n) { const x = text.charCodeAt(k); if (x === 34 || x === 92) break; k++; }
          s += text.slice(j, k); j = k;
        }
        top.push(s); i = j + 1;
      } else {
        let j = i;
        while (j < n) { const x = text.charCodeAt(j); if (x <= 32 || x === 40 || x === 41) break; j++; }
        top.push(text.slice(i, j)); i = j;
      }
    }
    if (stack.length !== 1) throw Error("Unbalanced parentheses: the file is truncated.");
    if (!Array.isArray(root[0])) throw Error("This is not an S-expression file.");
    return root[0];
  }
  const isList = Array.isArray;
  const all = (node, head) => node ? node.filter(x => isList(x) && x[0] === head) : [];
  const one = (node, head) => node ? node.find(x => isList(x) && x[0] === head) : undefined;
  const val = (node, head, i = 1) => one(node, head)?.[i];
  const num = (v, fallback = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : fallback; };
  const xy = (node, head) => { const k = one(node, head); return k ? [num(k[1]), num(k[2])] : null; };
  // A flag written as a bare atom (KiCad 6–8: "hide") or as (word yes) (KiCad 9).
  const flag = (node, word) => !!node && (node.includes(word) || (one(node, word)?.[1] === "yes"));
  // A KiCad schematic bitmap is centered on its anchor. PNG pHYs, when
  // present in pixels/meter, supplies the physical pixel pitch.
  function pngInfo(bytes) {
    if(!(bytes instanceof Uint8Array)||bytes.length<45||bytes.length>6000000)return null;
    if(![137,80,78,71,13,10,26,10].every((b,n)=>bytes[n]===b))return null;
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let width=0,height=0,ppi=300;
    for(let p=8;p+12<=bytes.length;){
      const n=view.getUint32(p),type=String.fromCharCode(...bytes.subarray(p+4,p+8));
      if(n>bytes.length-p-12)return null;
      if(p===8){
        if(type!=="IHDR" || n!==13)return null;
        width=view.getUint32(p+8);height=view.getUint32(p+12);
        if(!width||!height||width>100000||height>100000||width*height>120000000)return null;
      }
      if(type==="pHYs" && n===9 && bytes[p+16]===1){
        const value=view.getUint32(p+8)*.0254;
        if(value>0 && value<=100000)ppi=value;
      }
      if(type==="IEND")return n===0?{width,height,ppi}:null;
      p+=n+12;
    }
    return null;
  }
  return {parse, all, one, val, num, xy, flag,pngInfo};
})();

globalThis.AtriumImportFormats = (() => {
  const EXT = /\.(kicad_pro|kicad_sch|kicad_pcb|kicad_dru|kicad_sym|kicad_mod|sch|brd|json|epro|esch|epcb|eprj)$/i;
  const handles = name => EXT.test(String(name || ""));
  const utf8 = bytes => new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  const ext = name => (/\.([^.\\/]+)$/.exec(name || "")?.[1] || "").toLowerCase();
  const baseName = name => String(name || "").split(/[\\/]/).pop();
  const stem = name => baseName(name).replace(/\.[^.]+$/, "");

  // ------------------------------------------------------------ bytes
  function base64(text) {
    const s = String(text).replace(/[^A-Za-z0-9+/]/g, ""), out = new Uint8Array(Math.floor(s.length * 3 / 4));
    const v = c => c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 71 : c >= 48 && c <= 57 ? c + 4 : c === 43 ? 62 : 63;
    let n = 0;
    for (let i = 0; i + 1 < s.length; i += 4) {
      const a = v(s.charCodeAt(i)), b = v(s.charCodeAt(i + 1)), c = i + 2 < s.length ? v(s.charCodeAt(i + 2)) : -1, d = i + 3 < s.length ? v(s.charCodeAt(i + 3)) : -1;
      out[n++] = a << 2 | b >> 4;
      if (c >= 0) out[n++] = (b & 15) << 4 | c >> 2;
      if (d >= 0) out[n++] = (c & 3) << 6 | d;
    }
    return out.subarray(0, n);
  }
  // Raw DEFLATE (RFC 1951): stored, fixed and dynamic Huffman blocks.
  const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  function huffman(lengths, strict) {
    const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(lengths.length);
    for (const l of lengths) count[l]++;
    count[0] = 0;
    if (strict) {
      let unused = 1, symbols = 0;
      for (let l = 1; l <= 15; l++) {
        unused = unused * 2 - count[l]; symbols += count[l];
        if (unused < 0) throw Error("Oversubscribed compressed code table.");
      }
      if (unused && !(strict === "distance" && symbols === 0) && !(strict !== "codes" && symbols === 1 && count[1] === 1))
        throw Error("Incomplete compressed code table.");
    }
    for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
    for (let s = 0; s < lengths.length; s++) if (lengths[s]) sym[offs[lengths[s]]++] = s;
    return {count, sym};
  }
  let fixed = null;
  function inflate(data, expected = 0, limit = 256 * 1024 * 1024, exact = false) {
    let pos = 0, bitbuf = 0, bitcnt = 0, out = new Uint8Array(Math.min(limit, Math.max(1024, expected))), len = 0;
    const need = n => {
      if (len + n > limit) throw Error("A compressed entry expands beyond its declared size.");
      if (len + n > out.length) { const g = new Uint8Array(Math.min(limit, Math.max(out.length * 2, len + n))); g.set(out.subarray(0, len)); out = g; }
    };
    const bits = n => {
      while (bitcnt < n) { if (pos >= data.length) throw Error("The compressed data is truncated."); bitbuf |= data[pos++] << bitcnt; bitcnt += 8; }
      const v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v;
    };
    const decode = h => {
      let code = 0, first = 0, index = 0;
      for (let l = 1; l <= 15; l++) {
        code |= bits(1);
        const c = h.count[l];
        if (code - c < first) return h.sym[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw Error("Invalid compressed data.");
    };
    if (!fixed) {
      const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
      fixed = {lit: huffman(l), dist: huffman(new Uint8Array(32).fill(5))};
    }
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        if (pos + 4 > data.length) throw Error("The compressed data is truncated.");
        const n = data[pos] | data[pos + 1] << 8;
        if ((n ^ (data[pos + 2] | data[pos + 3] << 8)) !== 0xffff) throw Error("Invalid compressed data.");
        pos += 4;
        if (pos + n > data.length) throw Error("The compressed data is truncated.");
        need(n); out.set(data.subarray(pos, pos + n), len); len += n; pos += n;
        continue;
      }
      let lit, dist;
      if (type === 1) ({lit, dist} = fixed);
      else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4, cl = new Uint8Array(19);
        if (exact && hlit > 286) throw Error("Invalid number of compressed literal codes.");
        for (let i = 0; i < hclen; i++) cl[ORDER[i]] = bits(3);
        const ch = huffman(cl, exact && "codes"), lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = decode(ch);
          if (s < 16) lengths[i++] = s;
          else {
            let rep, v = 0;
            if (s === 16) { if (!i) throw Error("Invalid compressed data."); v = lengths[i - 1]; rep = 3 + bits(2); }
            else rep = s === 17 ? 3 + bits(3) : 11 + bits(7);
            if (i + rep > hlit + hdist) throw Error("Invalid compressed data.");
            lengths.fill(v, i, i + rep); i += rep;
          }
        }
        if (exact && !lengths[256]) throw Error("The compressed block has no end marker.");
        lit = huffman(lengths.subarray(0, hlit), exact && "literal");
        dist = huffman(lengths.subarray(hlit), exact && "distance");
      } else throw Error("Invalid compressed block type.");
      for (;;) {
        const s = decode(lit);
        if (s < 256) { need(1); out[len++] = s; continue; }
        if (s === 256) break;
        const k = s - 257;
        if (k >= 29) throw Error("Invalid compressed data.");
        const n = LBASE[k] + bits(LEXT[k]), dk = decode(dist);
        if (dk >= 30) throw Error("Invalid compressed data.");
        const d = DBASE[dk] + bits(DEXT[dk]);
        if (d > len) throw Error("Invalid compressed back-reference.");
        need(n);
        for (let i = 0; i < n; i++, len++) out[len] = out[len - d];
      }
    }
    if (exact && (pos !== data.length || expected != null && len !== expected)) throw Error("The compressed entry has trailing bytes or the wrong expanded length.");
    return out.subarray(0, len);
  }
  // Altium Models/N is an RFC 1950 zlib stream around a Part 21 file. Its
  // compressed payload stays on the board until an actual 3D output requests it.
  function stepBytes(asset) {
    const limit = 32 * 1048576;
    if (typeof asset?.stepText === "string" && asset.stepText.length <= limit) {
      const bytes = new TextEncoder().encode(asset.stepText);
      if (bytes.byteLength > limit) throw Error("The STEP body exceeds the byte limit.");
      return bytes;
    }
    if (typeof asset?.zlib !== "string" || asset.zlib.length > Math.ceil(limit / 3) * 4) throw Error("Invalid compressed STEP size.");
    return inflateStepBytes(base64(asset.zlib));
  }
  function inflateStepBytes(b, exact = false) {
    const limit = 32 * 1048576;
    if (b.length < 6 || (b[0] & 15) !== 8 || (b[0] >> 4) > 7 || ((b[0] * 256 + b[1]) % 31) || (b[1] & 32)) throw Error("Invalid STEP zlib header.");
    const raw = inflate(b.subarray(2, -4), null, limit, exact);
    let a = 1, sum = 0;
    for (let k = 0; k < raw.length; k++) { a = (a + raw[k]) % 65521; sum = (sum + a) % 65521; }
    const checksum = new DataView(b.buffer, b.byteOffset + b.length - 4, 4).getUint32(0);
    if (checksum !== ((sum << 16 | a) >>> 0)) throw Error("Invalid STEP zlib checksum.");
    return raw;
  }
  function stepText(asset) {
    return new TextDecoder().decode(stepBytes(asset));
  }
  // ZIP archives (.epro): central directory, stored and deflated entries. Entry count,
  // per-entry and total sizes and the compression ratio are capped (ZIP bombs).
  const ZIP = {entries: 10000, entry: 128 * 1024 * 1024, total: 512 * 1024 * 1024, ratio: 400};
  function unzip(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = new Map();
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw Error("This is not a ZIP archive.");
    const count = v.getUint16(end + 10, true);
    if (count > ZIP.entries) throw Error("The archive has too many entries.");
    let p = v.getUint32(end + 16, true), total = 0;
    const dec = new TextDecoder("utf-8");
    for (let k = 0; k < count; k++) {
      if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw Error("The ZIP directory is damaged.");
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
      const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (name.endsWith("/")) continue;
      if (files.has(name) || /(^|\/)\.\.(\/|$)/.test(name)) continue;
      total += size;
      if (size > ZIP.entry || total > ZIP.total) throw Error("The archive expands beyond " + (ZIP.total >> 20) + " MB.");
      if (size > 1024 * 1024 && size > csize * ZIP.ratio) throw Error("The archive has a suspicious compression ratio (possible ZIP bomb).");
      if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw Error("The ZIP entry " + name + " is damaged.");
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      if (start + csize > bytes.length) throw Error("The ZIP entry " + name + " is truncated.");
      const raw = bytes.subarray(start, start + csize);
      if (method === 0) { if (csize !== size) throw Error("The ZIP entry " + name + " is damaged."); files.set(name, raw); }
      else if (method === 8) files.set(name, inflate(raw, size, size));
      else throw Error("Unsupported ZIP compression method " + method + ".");
    }
    return files;
  }

  // ------------------------------------------------------------ geometry
  const D = Math.PI / 180;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const P = p => [r6(p[0]), r6(p[1])];
  // Circle through three points (any axis orientation) -> {c, r} or null.
  function circle3(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
    const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    return {c: [x, y], r: Math.hypot(a[0] - x, a[1] - y)};
  }
  // Points along an arc in the coordinates given, `sweep` degrees from angle `start`.
  // Import-wide geometry budget: every generated or parsed point is spent from it, so a
  // small file cannot expand into gigabytes of arcs, polygons or zones (review finding 1).
  const BUDGET = 2000000, budget = {used: 0};
  function fatal(message) { const e = Error(message); e.fatal = true; return e; }
  // Library indexing reads many small files one by one: each starts with a full budget.
  const resetBudget = () => { budget.used = 0; };
  function spend(n) {
    budget.used += n;
    if (budget.used > BUDGET) throw fatal("The design has more geometry than Waffle imports at once (over " + BUDGET.toLocaleString("en") + " points in arcs, polygons and outlines).");
  }
  // Retain the importer's two-degree floor and per-command point budget.
  function projectArc(c, r, start, sweep, tol = 0.005) {
    if (!(Number.isFinite(r) && Number.isFinite(start) && Number.isFinite(sweep))) return [P(c), P(c)];
    if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("../pcb/resolved-geometry-curves.js");
    const edge = {kind: "arc", center: c, radius: Math.abs(r), start: -start + (r < 0 ? 180 : 0), sweep: -sweep};
    const points = r ? AtriumGeometryCurves.project([edge], tol, {minSegments: 2, maxSegments: 720, minStep: 2, maxStep: r > tol ? 360 : 45}) : [c];
    if (points.length === 1) points.push(points[0], points[0]);
    spend(points.length);
    return points.map(P);
  }
  // Arc from a through m to b -> polyline (straight line when collinear).
  function arc3(a, m, b, tol) {
    const k = circle3(a, m, b);
    if (!k) return [P(a), P(b)];
    const ang = p => Math.atan2(p[1] - k.c[1], p[0] - k.c[0]) / D;
    const s = ang(a), e = ang(b), mm = ang(m);
    const n = x => ((x % 360) + 360) % 360;
    const ccw = n(mm - s) < n(e - s);
    const sweep = ccw ? n(e - s) || 360 : -(n(s - e) || 360);
    const pts = projectArc(k.c, k.r, s, sweep, tol);
    pts[0] = P(a); pts[pts.length - 1] = P(b);
    return pts;
  }
  // Arc from a to b turning `angle` degrees counter-clockwise in Y-up axes
  // (Eagle "curve"), returned in the same axes.
  function arcByAngle(a, b, angle, tol) {
    if (!angle) return [a, b];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d < 1e-12) return [a, b];
    const t = angle * D, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], nrm = [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
    const h = d / 2 / Math.tan(t / 2), c = [m[0] + nrm[0] * h, m[1] + nrm[1] * h], r = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const pts = projectArc(c, r, Math.atan2(a[1] - c[1], a[0] - c[0]) / D, angle, tol);
    pts[0] = a; pts[pts.length - 1] = b;
    return pts;
  }
  const circlePoints = (c, r, tol) => projectArc(c, r, 0, 360, tol);
  // Pad outlines centred on the origin: a rectangle with rounded corners of radius r
  // and/or chamfers of size c on the listed corners (tl, tr, br, bl; Y down).
  function padOutline(w, h, r = 0, c = 0, corners = ["tl", "tr", "br", "bl"]) {
    const x = w / 2, y = h / 2, out = [];
    r = Math.max(0, Math.min(r, x, y)); c = Math.max(0, Math.min(c, x * 2, y * 2));
    const spec = {tl: [-x, -y, 180], tr: [x, -y, 270], br: [x, y, 0], bl: [-x, y, 90]};
    for (const k of ["tl", "tr", "br", "bl"]) {
      const [cx, cy, a0] = spec[k], sx = Math.sign(cx), sy = Math.sign(cy);
      if (c > 0 && corners.includes(k)) {
        // Chamfer: the corner cut at 45 degrees, entering along the previous edge.
        const p1 = k === "tl" || k === "br" ? [cx, cy - sy * c] : [cx - sx * c, cy], p2 = k === "tl" || k === "br" ? [cx - sx * c, cy] : [cx, cy - sy * c];
        out.push(p1, p2);
      } else if (r > 0) out.push(...projectArc([cx - sx * r, cy - sy * r], r, a0, 90, Math.max(.002, r / 50)));
      else out.push([cx, cy]);
    }
    return out.map(P);
  }
  // Convex hull (monotone chain), counter-clockwise.
  function hull(points) {
    const p = points.map(P).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], hi = [];
    for (const q of p) { while (lo.length > 1 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (hi.length > 1 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  }
  function area(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - a[1] * b[0]; }
    return s / 2;
  }
  // Board outline from edge primitives: [{kind:"line",a,b} | {kind:"arc",a,m,b} | {kind:"circle",c,r}]
  // in Waffle axes. Sets doc.outline (and doc.boardShape with true arcs and cutouts
  // when board-shape.js is loaded) and returns any warnings.
  function setOutline(doc, edges, observe) {
    if (!edges.length) return ["No board outline (edge cuts) was found."];
    const BS = globalThis.AtriumBoardShape, sources = globalThis.AtriumBoardShapeSources;
    if (BS && sources) {
      const input = [];
      edges.forEach((e, i) => {
        let seg;
        if (e.kind === "line") seg = BS.line(e.a, e.b);
        else if (e.kind === "arc") seg = BS.arcThrough(e.a, e.m, e.b);
        else if (e.kind === "circle") seg = BS.arc(e.c, e.r, 0, 0, true);
        else if (e.kind === "path") { for (let j = 1; j < e.points.length; j++) input.push({seg: BS.line(e.points[j - 1], e.points[j]), id: "e" + i + "/" + j}); return; }
        if (seg) input.push({seg, id: "e" + i});
      });
      try {
        const r = sources.fromSegments(input, {source: "import", collectSourceIds: !!observe});
        if (r.shape) {
          const flat = BS.flatten(r.shape);
          if (flat.outline.length >= 3) {
            doc.outline = flat.outline.map(P);
            doc.boardShape = r.shape;
            if (observe) edges.forEach((e, i) => {
              const count = e.kind === "path" ? e.points.length - 1 : 1;
              let kept = 0;
              for (let j = 1; j <= count; j++) if (r.sourceIds.has("e" + i + (e.kind === "path" ? "/" + j : ""))) kept++;
              if (kept === 0) observe(i, "dropped", "The primitive is outside the retained board outline or cutouts.");
              else if (kept < count || r.bridged) observe(i, "approximated", "The outline was partially traced or a gap was bridged.");
              else observe(i, "kept");
            });
            return r.warnings || [];
          }
        }
        if (r.warnings?.length) return [...r.warnings, ...fallback()];
      } catch (error) { return ["The board outline could not be traced: " + error.message, ...fallback()]; }
    }
    return fallback();
    function fallback() {
      // Chaining of flattened primitives; the largest closed loop is the board. Path ends are
      // indexed in a 0.01 mm hash grid, so each step is O(1) (review finding 6).
      if (edges.length > 200000) {
        if (observe) edges.forEach((_, i) => observe(i, "dropped", "The outline exceeds the tracing limit."));
        return ["The board outline has too many edges (" + edges.length + ") to trace; draw it as fewer primitives."];
      }
      const pathSources = observe && [];
      const paths = edges.map(e => e.kind === "line" ? [e.a, e.b] : e.kind === "arc" ? arc3(e.a, e.m, e.b) : e.kind === "path" ? e.points : circlePoints(e.c, e.r)).filter((p, i) => {
        if (p.length < 2) return false;
        if (pathSources) pathSources.push(i);
        return true;
      });
      const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01, loops = [], used = new Uint8Array(paths.length), grid = new Map();
      const cell = (p, dx = 0, dy = 0) => (Math.round(p[0] / .01) + dx) + "," + (Math.round(p[1] / .01) + dy);
      paths.forEach((p, i) => { for (const e of [p[0], p.at(-1)]) { const k = cell(e); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); } });
      const nextAt = q => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
          for (const i of grid.get(cell(q, dx, dy)) || []) if (!used[i] && (near(q, paths[i][0]) || near(q, paths[i].at(-1)))) return i;
        return -1;
      };
      for (let s = 0; s < paths.length; s++) {
        if (used[s]) continue;
        used[s] = 1;
        const loop = paths[s].slice(), sources = observe ? [pathSources[s]] : null;
        for (;;) {
          if (loop.length > 2 && near(loop[0], loop.at(-1))) break;
          const i = nextAt(loop.at(-1));
          if (i < 0) break;
          used[i] = 1;
          if (sources) sources.push(pathSources[i]);
          const p = paths[i];
          for (const q of near(loop.at(-1), p[0]) ? p.slice(1) : p.slice(0, -1).reverse()) loop.push(q);
        }
        if (loop.length > 3 && near(loop[0], loop.at(-1))) loops.push({points: loop.slice(0, -1), sources});
      }
      if (!loops.length) {
        if (observe) edges.forEach((_, i) => observe(i, "dropped", "The board outline does not close."));
        return ["The board outline does not close."];
      }
      loops.sort((a, b) => Math.abs(area(b.points)) - Math.abs(area(a.points)));
      doc.outline = loops[0].points.map(P);
      if (observe) {
        const retained = new Set(loops[0].sources);
        edges.forEach((e, i) => {
          if (!retained.has(i)) observe(i, "dropped", "The fallback outline retains only the outer closed loop.");
          else if (e.kind === "arc" || e.kind === "circle") observe(i, "approximated", "Boundary curve was sampled into line segments.");
          else observe(i, "kept");
        });
      }
      return loops.length > 1 ? [(loops.length - 1) + " board cutout(s) need board-shape support and were omitted."] : [];
    }
  }
  // Collects repeated notes as "message (n)".
  function notebook() {
    const counts = new Map();
    const add = (message, n = 1) => counts.set(message, (counts.get(message) || 0) + n);
    const list = () => [...counts].map(([m, n]) => n > 1 ? m + " (" + n + ")" : m);
    return {add, list};
  }
  // Symbol and footprint definitions shared by identical geometry.
  function definitions() {
    const byKey = new Map(), list = [];
    function add(def, key) {
      const k = key ?? JSON.stringify([def.name, def.symbol, def.footprint, def.footprintName, def.value]);
      const hit = byKey.get(k);
      if (hit) return hit;
      byKey.set(k, def); list.push(def); return def;
    }
    return {add, list};
  }
  // Version 1 Waffle rules from a default class and per-net class overrides.
  function rulesFrom(defaults, overrides) {
    const ok = v => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000;
    const pick = o => { const g = {}; for (const k of ["clearance", "trackWidth", "viaDrill"]) if (ok(o?.[k])) g[k] = r6(o[k]); return g; };
    const base = {clearance: .2, trackWidth: .25, viaDrill: .3, ...pick(defaults)};
    const nets = {};
    for (const [net, o] of Object.entries(overrides || {})) {
      const name = String(net).trim();
      if (!name || name.length > 512 || name === "__proto__") continue;
      const g = pick(o);
      for (const k of Object.keys(g)) if (g[k] === base[k]) delete g[k];
      if (Object.keys(g).length) nets[name] = g;
    }
    return {format: "atrium-rules", version: 1, units: "mm", defaults: base, nets};
  }

  // Migrating a foreign default class supplies dimensions for missing fields.
  // Remember which dimensions the source supplied, before the native rule book is built.
  const classDefaults = new WeakMap();
  function classRuleEvidence(set,defaults) {
    const R=globalThis.AtriumRules;
    if(!R)return [];
    const keys={clearance:["clearance","gap"],width:["trackWidth","min"],viaStyle:["viaDrill","holeMin"]};
    return R.migrate(set).list.filter(r=>keys[r.type] && R.kit.allScope(r.scope)).map(r=>{
      const [key,field]=keys[r.type],n=defaults?.[key];
      return {id:r.id,type:r.type,priority:r.priority,field,value:r[field],explicit:Number.isFinite(n) && n>0 && n<=1000};
    }).filter(r=>r.value!=null);
  }
  function setClassRules(doc,defaults,overrides,audit,set=rulesFrom(defaults,overrides)) {
    doc.rules=set;
    if(audit && globalThis.AtriumRules)classDefaults.set(doc,classRuleEvidence(doc.rules,defaults));
  }

  function sourceClassDefaults(doc) {
    const evidence = classDefaults.get(doc);
    const R = globalThis.AtriumRules;
    if (!R) return evidence;
    const derived = new Set((doc?.rules?.list || []).filter(rule =>
      rule.origin?.kind === "default" && rule.origin.key === rule.id && !R.kit.allScope(rule.scope)).map(rule => rule.id));
    if (!derived.size) return evidence;
    // Use the final imported rule. A linked source can raise the priority of
    // its own constraint while keeping the generated pad-only limit as a fallback.
    const baselines = R.migrate(doc.rules).list.filter(rule => derived.has(rule.id)).map(rule =>
      ({id:rule.id, type:rule.type, explicit:false, baseline:rule}));
    return [...(evidence || []), ...baselines];
  }

  // ------------------------------------------------------------ hostile-input guards
  // Dictionaries keyed by file content: no prototype, so "__proto__" or "constructor"
  // can neither reach Object.prototype nor read inherited members.
  const dict = (init) => Object.assign(Object.create(null), init || {});
  // Stores value under a content-supplied key on a model object; refuses "__proto__".
  const put = (o, k, v) => { if (k === "__proto__") return false; o[k] = v; return true; };
  // Glob (* and ?) match without regular expressions: O(n·m), no backtracking blow-up.
  // `cost` (optional {steps, max}) caps the total work of many matches (review finding 7).
  function wildcard(pattern, text, cost) {
    const p = String(pattern).slice(0, 256), t = String(text).slice(0, 255);
    let pi = 0, ti = 0, star = -1, mark = 0;
    while (ti < t.length) {
      if (cost && ++cost.steps > cost.max) throw fatal("Net class patterns are too costly to match (over " + cost.max.toLocaleString("en") + " steps).");
      if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) { pi++; ti++; }
      else if (pi < p.length && p[pi] === "*") { star = pi++; mark = ti; }
      else if (star >= 0) { pi = star + 1; ti = ++mark; }
      else return false;
    }
    while (pi < p.length && p[pi] === "*") pi++;
    return pi === p.length;
  }
  // Drops geometry with non-finite or absurd coordinates so one hostile number cannot make a
  // whole import fail validation; returns how many objects were removed.
  const LIMIT = 1e6;
  const fin = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < LIMIT;
  const okPoint = p => Array.isArray(p) && p.length === 2 && fin(p[0]) && fin(p[1]);
  const okXY = o => fin(o.x) && fin(o.y) && (o.angle == null || fin(o.angle));
  function scrub(result, fidelity) {
    let dropped = 0;
    const keep = (list, test) => { const out = list.filter(o => { const ok = test(o); if (!ok) fidelity?.reject(o); return ok; }); dropped += list.length - out.length; return out; };
    const widthOk = o => o.width == null || fin(o.width) && o.width >= 0;
    const shapeOk = sh => widthOk(sh) && (sh.size == null || fin(sh.size) && sh.size > 0) && (sh.kind !== "text" || typeof sh.text === "string") &&
      (sh.points ? sh.points.length > 0 && sh.points.every(okPoint) : okXY(sh) && (sh.kind !== "circle" || fin(sh.r) && sh.r > 0));
    const str = (o, k, d = "") => { if (typeof o[k] !== "string") o[k] = o[k] == null ? d : String(o[k]); };
    for (const def of result.library || []) { str(def, "name", "Imported"); str(def, "value"); str(def, "prefix", "U"); }
    for (const def of result.library || []) {
      for (const g of [def.symbol, def.footprint].filter(Boolean)) {
        g.shapes = keep(g.shapes || [], shapeOk);
        if (g.pins) { g.pins = keep(g.pins, okXY); for (const pin of g.pins) { str(pin, "number"); str(pin, "name"); } }
        if (g.pads) g.pads = keep(g.pads, p => okXY(p) && fin(p.w) && p.w > 0 && fin(p.h) && p.h > 0 && (p.drill == null || fin(p.drill) && p.drill >= 0) &&
          (p.poly == null || Array.isArray(p.poly) && p.poly.every(okPoint)));
      }
    }
    for (const doc of result.documents || []) {
      for (const i of doc.items) if (i.kind === "part") { str(i, "ref", "U?"); str(i, "value"); }
      doc.items = keep(doc.items, i => (!["label", "netlabel", "power", "port", "offsheet"].includes(i.kind) || typeof i.text === "string") && i.points ? i.points.length >= (i.kind === "polygon" ? 3 : 2) && i.points.every(okPoint) : okXY(i) &&
        (i.diameter == null || fin(i.diameter) && i.diameter > 0) && (i.w == null || fin(i.w) && i.w > 0) && (i.h == null || fin(i.h) && i.h > 0) &&
        (i.r == null || fin(i.r)) && (i.size == null || fin(i.size) && i.size > 0) && (i.width == null || fin(i.width) && i.width >= 0));
      doc.outline = (doc.outline || []).every(okPoint) ? doc.outline : [];
      if (doc.items.length > 4e6) throw Error("The design has too many objects to import.");
    }
    if (dropped) {
      const note = dropped + " object(s) with invalid coordinates or sizes were skipped.";
      result.notes = [...(result.notes || []), note];
      for (const d of result.documents || []) d.notes = [...(d.notes || []), note];
    }
    return result;
  }

  // Runs one object's import; a missing or malformed required value skips that object
  // with a note instead of failing the file (review finding 10). Budget and size errors
  // still stop the import.
  function guard(notes, fn) {
    try { return fn(); }
    catch (error) {
      if (error?.fatal || error instanceof RangeError) throw error;
      notes.add("Objects with missing or malformed required values were skipped");
      return undefined;
    }
  }
  // The first object that makes a project invalid, as a sentence, or null.
  function explain(project) {
    const A = globalThis.Atrium;
    if (!A?.validate) return null;
    const ok = p => { try { A.validate(p); return true; } catch { return false; } };
    const base = {...project, documents: []};
    for (const def of project.library || []) if (!ok({...base, library: [def], documents: [A.sheet("schematic", "x")]})) return "Library entry " + JSON.stringify(String(def.name || def.id)) + " is invalid.";
    for (const doc of project.documents || []) {
      if (ok({...project, documents: [doc]})) continue;
      if (!ok({...project, documents: [{...doc, items: []}]})) return "Document " + JSON.stringify(String(doc.name)) + " has invalid settings.";
      for (const item of doc.items.slice(0, 20000)) if (!ok({...project, documents: [{...doc, items: [item]}]}))
        return "Document " + JSON.stringify(String(doc.name)) + ": " + item.kind + " " + JSON.stringify(String(item.ref || item.text || item.id)) + " is invalid.";
      return "Document " + JSON.stringify(String(doc.name)) + " is invalid.";
    }
    return null;
  }

  // ------------------------------------------------------------ dispatch
  function importerFor(name, bytes, format) {
    const e = ext(name), head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
    const K = globalThis.AtriumKiCadImport, E = globalThis.AtriumEagleImport, Y = globalThis.AtriumEasyEDAImport;
    const missing = n => { throw Error(n + " import is not available in this build."); };
    if (bytes.length >= 16 && new TextDecoder("latin1").decode(bytes.subarray(0, 16)) === "SQLite format 3\0")
      throw Error("EasyEDA Pro .eprj projects (SQLite databases) are not supported. In EasyEDA Pro, use File → Save As (or Export) to write an .epro project, then open that.");
    if (format === "easyeda") return Y || missing("EasyEDA");
    if (format === "eagle" && e !== "sch" && e !== "brd") return E || missing("Eagle");
    if (format === "kicad") {
      if (e === "kicad_sym" || e === "kicad_mod") return globalThis.AtriumLibraryImportKiCad || missing("KiCad library");
      return K || missing("KiCad");
    }
    if (e === "kicad_pro" || e === "kicad_sch" || e === "kicad_pcb" || e === "kicad_dru") return K || missing("KiCad");
    // KiCad symbol and footprint libraries: paired into components across the chosen files (library-import-kicad.js).
    if (e === "kicad_sym" || e === "kicad_mod") return globalThis.AtriumLibraryImportKiCad || missing("KiCad library");
    if (e === "sch" || e === "brd") {
      if (/^<\?xml|^<!DOCTYPE eagle|^<eagle/i.test(head) || /<eagle[\s>]/i.test(head)) return E || missing("Eagle");
      if (/^\(kicad_(sch|pcb)/.test(head)) return K || missing("KiCad");
      if (/^EESchema|^PCBNEW/.test(head)) throw Error("Legacy KiCad 4/5 files are not supported. Open and save them in KiCad 6 or later.");
      if (bytes[0] === 0x10 || bytes[0] === 0x00) throw Error("Binary Eagle files (before version 6) are not supported. Open and save them in Eagle 6 or later.");
      throw Error("Unrecognised .sch/.brd file. Waffle reads Eagle 6+ XML designs.");
    }
    if (e === "json" && /^\{\s*"format"\s*:\s*"atrium"/.test(head)) throw Error("This is a Waffle project saved as .json. Rename it to .waffle and open it.");
    if (e === "json" || e === "epro" || e === "esch" || e === "epcb" || e === "eprj") return Y || missing("EasyEDA");
    throw Error("Unsupported file type ." + e + ".");
  }
  function read(name, bytes) {
    const [result] = readSet([{name, bytes}]);
    return result;
  }
  const MAX_FILE = 256 * 1024 * 1024, MAX_SET = 1024 * 1024 * 1024;
  function readSet(files, options = {}) {
    const results = [], hooks = [];
    budget.used = 0;
    if (!Array.isArray(files) || files.length > 500) throw Error("Choose at most 500 files to import at once.");
    let total = 0;
    for (const [index, f] of files.entries()) {
      options.progress?.({done: index, total: files.length, name: baseName(f.name)});
      const fidelity = options.fidelityFor?.(f) || options.fidelity;
      const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      total += bytes.length;
      if (bytes.length > MAX_FILE) throw Error(baseName(f.name) + " — the file is larger than 256 MB.");
      if (total > MAX_SET) throw Error("The selected files are larger than 1 GB in total.");
      const format = options.formatFor?.(f);
      if (format === "altium" || !format && !handles(f.name)) {
        if (!globalThis.AtriumIO) throw Error("Unsupported file type.");
        try { results.push(AtriumIO.read(f.name, bytes, {fidelity})); }
        catch (error) { throw Error(baseName(f.name) + " — " + (error instanceof RangeError || error instanceof TypeError ? "the file is damaged or too complex to read" : error?.message || String(error))); }
        continue;
      }
      const importer = importerFor(f.name, bytes, format);
      try {
        const r = importer.read(baseName(f.name), bytes, {utf8, unzip, base64, fidelity});
        results.push(scrub(r, fidelity));
        if (importer.link && !hooks.includes(importer)) hooks.push(importer);
      } catch (error) {
        // Stack overflows and allocation failures from hostile input become ordinary errors.
        const m = error instanceof RangeError ? "the file is malformed or too complex (" + error.message + ")" :
          error instanceof TypeError ? "the file is damaged: a required value is missing or malformed" : error?.message || String(error);
        throw Error(baseName(f.name) + " — " + m);
      }
    }
    for (const h of hooks) h.link(results, files, options);
    options.progress?.({done: files.length, total: files.length, name: ""});
    const docs = results.flatMap(r => r.documents || []), libs = results.flatMap(r => r.library || []);
    if (!docs.length && !libs.length && !results.some(r=>r.pairing?.skipped)) {
      if (files.some(f => ext(f.name)==="kicad_dru")) throw Error("Select the .kicad_dru with its matching .kicad_pcb board.");
      if (results.some(r => r.kicadProject)) throw Error("Select the .kicad_pro together with its .kicad_sch and .kicad_pcb files.");
      throw Error("No supported documents were found.");
    }
    return results;
  }
  return {handles, read, readSet, base64, inflate, inflateStepBytes, stepBytes, stepText, unzip, utf8, stem, baseName, dict, put, wildcard, scrub, fatal, spend, resetBudget, explain, guard,
    geom: {circle3, arcPoints: projectArc, arc3, arcByAngle, circlePoints, area, setOutline, padOutline, hull, P, r6}, notebook, definitions, rulesFrom, setClassRules, classRuleEvidence, sourceClassDefaults};
})();
