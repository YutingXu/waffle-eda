"use strict";

// The parts of PCB text that most boards never draw, loaded with vectorize.js when a project
// uses them (AtriumLazy.validatorsFor) or a text first asks for them: TrueType glyphs traced
// from the platform's canvas, Code 39 / Code 128 / QR barcodes and knockout (inverted) text.
// pcb-text.js owns the layout and calls in here; until this file has loaded such text lays out
// in the stroke font, uncached, and the editor redraws once it arrives.
globalThis.AtriumPCBTextRich = (() => {
  const V = () => globalThis.AtriumVectorize;
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

  // ---------------------------------------------------------------------------
  // TrueType glyphs: rendered by the platform's canvas at a large em size and
  // traced. Each glyph is traced once per family, weight, slant and
  // character; afterwards layout only transforms cached polygons.
  const EM = 160;
  let ttSource = null;
  function canvasSource() {
    let ctx = null;
    const context = () => {
      if (ctx) return ctx;
      const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(16, 16) : typeof document !== "undefined" ? document.createElement("canvas") : null;
      ctx = c?.getContext("2d", {willReadFrequently: true}) || null;
      return ctx;
    };
    const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-monospace", "ui-sans-serif", "ui-serif"]);
    const css = key => {
      const [family, bold, italic] = key.split("|");
      const name = generic.has(family) ? family : "\"" + family.replace(/["\\]/g, "") + "\", sans-serif";
      return (italic === "1" ? "italic " : "") + (bold === "1" ? "700 " : "400 ") + EM + "px " + name;
    };
    return {
      available: () => !!context(),
      metrics(key) {
        const c = context(); c.font = css(key);
        const m = c.measureText("H"), d = c.measureText("gjpqy");
        return {cap: (m.actualBoundingBoxAscent || EM * .7) / EM, descent: (d.actualBoundingBoxDescent || EM * .2) / EM,
          cell: (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / EM || 1};
      },
      advance(key, s) { const c = context(); c.font = css(key); return c.measureText(s).width / EM; },
      glyph(key, ch) {
        const c = context(); c.font = css(key);
        const m = c.measureText(ch);
        const left = Math.ceil(m.actualBoundingBoxLeft || 0) + 3, right = Math.ceil(m.actualBoundingBoxRight || m.width) + 3;
        const asc = Math.ceil(m.actualBoundingBoxAscent || EM) + 3, desc = Math.ceil(m.actualBoundingBoxDescent || 0) + 3;
        const w = Math.max(1, left + right), h = Math.max(1, asc + desc);
        if (w * h > 4e6) return [];
        c.canvas.width = w; c.canvas.height = h;
        c.font = css(key); c.fillStyle = "#000"; c.textBaseline = "alphabetic"; c.textAlign = "left";
        c.clearRect(0, 0, w, h); c.fillText(ch, left, asc);
        const img = c.getImageData(0, 0, w, h);
        const t = V().trace(img, {mode: "alpha", threshold: 128, tolerance: .25, turdSize: 1});
        const map = p => [(p[0] - left) / EM, (p[1] - asc) / EM];
        return t.polygons.map(poly => ({outer: poly.outer.map(map), holes: poly.holes.map(h => h.map(map))}));
      }
    };
  }
  const ttCache = new Map(), ttMetrics = new Map();
  // Replace the TrueType glyph source (tests, or a parsed font file):
  // {available(), metrics(key) -> {cap, descent}, advance(key, string) -> em,
  //  glyph(key, ch) -> [{outer, holes}] in em units, Y down from the baseline}.
  function setGlyphSource(src) { ttSource = src; ttCache.clear(); ttMetrics.clear(); globalThis.AtriumPCBText?.clearCache(); }
  const source = () => ttSource || (ttSource = canvasSource());
  const fontKey = p => p.family + "|" + (p.bold ? 1 : 0) + "|" + (p.italic ? 1 : 0);
  function ttGlyph(key, ch) {
    const k = key + "\u0000" + ch;
    let g = ttCache.get(k);
    if (!g) { g = /\s/.test(ch) ? [] : source().glyph(key, ch); ttCache.set(k, g); }
    return g;
  }
  function ttMetric(key) {
    let m = ttMetrics.get(key);
    if (!m) { m = source().metrics(key); ttMetrics.set(key, m); }
    return m;
  }
  const available = () => !!(source().available && source().available());
  // The saved contours use the PCB coordinate unit (one ten-thousandth of
  // a mil), relative to the writing baseline. Their widths are native advances.
  // Each source glyph is decoded once, on demand, in the same lazy text path.
  const savedGlyphs=new WeakMap(),pcbUnit=.00000254;
  function savedGlyph(record){
    if(!Array.isArray(record)||record.length!==2||!Number.isFinite(record[0])||
      typeof record[1]!=="string"||record[1].length>4*1024*1024)return null;
    if(savedGlyphs.has(record))return savedGlyphs.get(record);
    let result=null;
    try{
      const bytes=typeof Uint8Array.fromBase64==="function"?Uint8Array.fromBase64(record[1]):Uint8Array.from(atob(record[1]),c=>c.charCodeAt(0));
      const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=v.getUint32(0,true);
      let at=4+n*4;
      if(n>4096||at>bytes.length)throw Error();
      const rings=[];
      for(let j=0;j<n;j++){
        const count=v.getUint32(at,true);at+=4;
        if(count<3||at+count*16>bytes.length)throw Error();
        const ring=new Float64Array(count*2);
        for(let k=0;k<ring.length;k++,at+=8){
          const value=v.getFloat64(at,true)*pcbUnit*(k%2?-1:1);
          if(!Number.isFinite(value)||Math.abs(value)>10000)throw Error();
          ring[k]=value;
        }
        // nest() takes positive outer rings, negative holes in screen coordinates.
        let area=0;
        for(let k=0,q=ring.length-2;k<ring.length;q=k,k+=2)area+=ring[q]*ring[k+1]-ring[k]*ring[q+1];
        const hole=!!(v.getUint32(4+j*4,true)&1);
        if((area<0)!==hole){
          for(let l=0,r=ring.length-2;l<r;l+=2,r-=2){
            const x=ring[l],y=ring[l+1];ring[l]=ring[r];ring[l+1]=ring[r+1];ring[r]=x;ring[r+1]=y;
          }
          area=-area;
        }
        rings.push({ring,area:area/2});
      }
      if(at===bytes.length)result={advance:record[0]*pcbUnit,polygons:V().nest(rings)};
    }catch{}
    savedGlyphs.set(record,result);return result;
  }
  function savedRun(set,lines){
    const glyphs=new Map();
    for(const line of lines)for(const ch of line){
      if(glyphs.has(ch))continue;
      const g=savedGlyph(set[ch.codePointAt(0)]);
      if(!g)return null;
      glyphs.set(ch,g);
    }
    return glyphs;
  }
  function savedLayout(lines,p,glyphs,h,pitch,hFactor){
    const scale=h/p.letterSize,polygons=[];
    const advance=line=>Array.from(line).reduce((x,ch)=>x+glyphs.get(ch).advance*scale,0);
    if(p.sourceFrame){
      const limit=p.sourceFrame.width-2*(p.sourceFrame.margin || 0);
      lines=lines.flatMap(line=>{
        const out=[];let run="";
        for(const word of line.match(/\S+\s*|\s+/g)||[]){
          if(run.trim() && advance((run+word).trimEnd())>limit){out.push(run.trimEnd());run="";}
          run+=word;
        }
        out.push(run.trimEnd());return out;
      });
      pitch=h*p.lineSpacing/(5/3);
    }
    let metricsWidth=0;
    lines.forEach((line,j)=>{
      const width=advance(line);metricsWidth=Math.max(metricsWidth,width);
      let x=-width*hFactor;
      for(const ch of line){
        const g=glyphs.get(ch),place=q=>[x+q[0]*scale,j*pitch+q[1]*scale];
        for(const poly of g.polygons)polygons.push({outer:poly.outer.map(place),holes:poly.holes.map(r=>r.map(place))});
        x+=g.advance*scale;
      }
    });
    return {lines,pitch,top:-h,bottom:(lines.length-1)*pitch,metricsWidth,polygons};
  }

  // The TrueType lines of layout(): glyph polygons, the wrapped lines and the anchor extents.
  // vShift(top, bottom) is layout()'s vertical justification.
  function truetype(lines, p, h, pitch, hFactor, vShift) {
    const polygons = [];
    let metricsWidth = 0;
    const key = fontKey(p), m = ttMetric(key);
    // Altium's TrueType height includes the font's ascender and descender.
    // Waffle-authored text specifies the height of a capital letter.
    const s = h / (p.sourceMode ? m.cell || 1 : m.cap);
    if (p.sourceFrame) {
      const maxWidth = Math.max(0,p.sourceFrame.width - 2 * (p.sourceFrame.margin || 0));
      lines = lines.flatMap(line => {
        const wrapped = [];
        let run = "";
        for (const word of line.match(/\S+\s*|\s+/g) || []) {
          if (run.trim() && source().advance(key,(run+word).trimEnd())*s > maxWidth) {
            wrapped.push(run.trimEnd()); run = "";
          }
          run += word;
        }
        wrapped.push(run.trimEnd()); return wrapped;
      });
      pitch = (m.cap + m.descent) * s * p.lineSpacing / (5/3);
    }
    const top = -m.cap*s, bottom = (lines.length-1)*pitch;
    const dy0 = vShift(top, bottom);
    lines.forEach((line, li) => {
      const chars = Array.from(line), width = source().advance(key, line) * s;
      metricsWidth = Math.max(metricsWidth, width);
      const start = -width * hFactor, base = li * pitch + dy0;
      let prefix = "";
      for (const ch of chars) {
        const x0 = start + source().advance(key, prefix) * s;
        prefix += ch;
        for (const poly of ttGlyph(key, ch)) {
          const map = q => [x0 + q[0] * s, base + q[1] * s];
          polygons.push({outer: poly.outer.map(map), holes: poly.holes.map(r => r.map(map))});
        }
      }
    });
    return {lines, pitch, top, bottom, metricsWidth, polygons};
  }

  // ---------------------------------------------------------------------------
  // Barcodes
  const C39 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*";
  const C39W = ["000110100","100100001","001100001","101100000","000110001","100110000","001110000","000100101","100100100","001100100",
    "100001001","001001001","101001000","000011001","100011000","001011000","000001101","100001100","001001100","000011100",
    "100000011","001000011","101000010","000010011","100010010","001010010","000000111","100000110","001000110","000010110",
    "110000001","011000001","111000000","010010001","110010000","011010000","010000101","110000100","011000100","010101000",
    "010100010","010001010","000101010","010010100"];
  // Bars as [start, width] in modules plus the total width in modules.
  function code39(text, ratio = 3) {
    const s = String(text).toUpperCase();
    for (const ch of s) if (ch === "*" || !C39.includes(ch)) throw Error("Code 39 cannot encode \"" + ch + "\".");
    const bars = [];
    let x = 0;
    for (const ch of "*" + s + "*") {
      const w = C39W[C39.indexOf(ch)];
      for (let i = 0; i < 9; i++) {
        const width = w[i] === "1" ? ratio : 1;
        if (i % 2 === 0) bars.push([x, width]);
        x += width;
      }
      x += 1;
    }
    return {bars, width: x - 1};
  }
  const C128 = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222",
    "123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121",
    "111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
    "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421",
    "141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212",
    "124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131",
    "311141","411131","211412","211214","211232","2331112"];
  // Code 128 symbol values: code set B with code set C for digit runs.
  function code128Values(text) {
    const s = String(text);
    if (!s) throw Error("Code 128 needs at least one character.");
    for (const ch of s) { const c = ch.charCodeAt(0); if (ch.length !== 1 || c < 32 || c > 126) throw Error("Code 128 cannot encode \"" + ch + "\"."); }
    const values = [];
    let set = null, i = 0;
    const toB = () => { if (set !== "B") { values.push(set === null ? 104 : 100); set = "B"; } };
    const toC = () => { if (set !== "C") { values.push(set === null ? 105 : 99); set = "C"; } };
    while (i < s.length) {
      let run = 0;
      while (i + run < s.length && s[i + run] >= "0" && s[i + run] <= "9") run++;
      const atStart = i === 0, atEnd = i + run === s.length;
      // Set C pays off for 4+ digits at either end, 6+ in the middle, or an
      // all-digit even-length message.
      if ((run >= 4 && (atStart || atEnd || run >= 6)) || (atStart && atEnd && run >= 2 && run % 2 === 0)) {
        if (run % 2) { toB(); values.push(s.charCodeAt(i) - 32); i++; run--; }
        toC();
        for (let k = 0; k < run; k += 2) { values.push(+s.substr(i, 2)); i += 2; }
        continue;
      }
      toB(); values.push(s.charCodeAt(i) - 32); i++;
    }
    let sum = values[0];
    for (let k = 1; k < values.length; k++) sum += k * values[k];
    values.push(sum % 103, 106);
    return values;
  }
  function code128(text) {
    const bars = [];
    let x = 0;
    for (const v of code128Values(text)) {
      const w = C128[v];
      for (let i = 0; i < w.length; i++) { if (i % 2 === 0) bars.push([x, +w[i]]); x += +w[i]; }
    }
    return {bars, width: x};
  }

  // QR Code (ISO 18004): byte mode, versions 1-10, levels L/M/Q/H.
  const QR_ECC = {L: [7,10,15,20,26,18,20,24,30,18], M: [10,16,26,18,24,16,18,22,22,26], Q: [13,22,18,26,18,24,18,22,20,24], H: [17,28,22,16,22,28,26,26,24,28]};
  const QR_BLOCKS = {L: [1,1,1,1,1,2,2,2,2,4], M: [1,1,1,2,2,4,4,4,5,5], Q: [1,1,2,2,4,4,6,6,8,8], H: [1,1,2,4,4,4,5,6,8,8]};
  const QR_FORMAT = {L: 1, M: 0, Q: 3, H: 2};
  const gfMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 255; };
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0); r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      root = gfMul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = new Array(div.length).fill(0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
    return r;
  }
  const rawModules = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
  const dataCodewords = (v, e) => Math.floor(rawModules(v) / 8) - QR_ECC[e][v - 1] * QR_BLOCKS[e][v - 1];
  function alignment(v) {
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, r = [6];
    for (let pos = v * 4 + 10; r.length < n; pos -= step) r.splice(1, 0, pos);
    return r;
  }
  function qr(text, ecc = "M") {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 0;
    for (let v = 1; v <= 10; v++) if (4 + (v < 10 ? 8 : 16) + 8 * bytes.length <= dataCodewords(v, ecc) * 8) { ver = v; break; }
    if (!ver) throw Error("Text is too long for a version 10 QR code at level " + ecc + ".");
    const cap = dataCodewords(ver, ecc), bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap * 8 - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a << 1 | b, 0));
    for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
    // Error correction and interleaving.
    const nb = QR_BLOCKS[ecc][ver - 1], el = QR_ECC[ecc][ver - 1], raw = Math.floor(rawModules(ver) / 8);
    const short = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(el), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - el + (i < short ? 0 : 1)); k += dat.length;
      const e = rsRemainder(dat, div);
      if (i < short) dat.push(0);
      blocks.push(dat.concat(e));
    }
    const words = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - el || j >= short) words.push(b[i]); });
    // Function patterns.
    const size = ver * 4 + 17, mod = [], fn = [];
    for (let y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    const al = alignment(ver);
    al.forEach((a, i) => al.forEach((b, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const formatBits = mask => {
      const d = QR_FORMAT[ecc] << 3 | mask;
      let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      return ((d << 10) | r) ^ 0x5412;
    };
    const drawFormat = mask => {
      const b = formatBits(mask), bit = i => ((b >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const b = ver << 12 | r;
      for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) !== 0, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
    }
    // Data placement in the zigzag order.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < words.length * 8) { mod[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }
    const masks = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masks[m](x, y)) mod[y][x] = !mod[y][x]; };
    const penalty = () => {
      let p = 0, dark = 0;
      const line = get => {
        let run = 1, prev = get(0);
        for (let k = 1; k <= size; k++) {
          const c = k < size ? get(k) : !prev;
          if (c === prev) run++; else { if (run >= 5) p += run - 2; run = 1; prev = c; }
        }
        for (let k = 0; k + 6 < size; k++) {
          if (get(k) && !get(k + 1) && get(k + 2) && get(k + 3) && get(k + 4) && !get(k + 5) && get(k + 6)) {
            const before = k >= 4 && !get(k - 1) && !get(k - 2) && !get(k - 3) && !get(k - 4);
            const after = k + 10 < size && !get(k + 7) && !get(k + 8) && !get(k + 9) && !get(k + 10);
            if (before || after) p += 40;
          }
        }
      };
      for (let y = 0; y < size; y++) line(x => mod[y][x]);
      for (let x = 0; x < size; x++) line(y => mod[y][x]);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (mod[y][x]) dark++;
        if (x < size - 1 && y < size - 1) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
      }
      return p + 10 * (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1);
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) { apply(m); drawFormat(m); const s = penalty(); if (s < bestScore) { bestScore = s; best = m; } apply(m); }
    apply(best); drawFormat(best);
    return {size, version: ver, mask: best, ecc, modules: mod, words, blocks};
  }

  function barcodeLayout(text, p) {
    const b = p.barcode, H = p.height, strokes = [], polygons = [];
    let width = 0, top = -H, bottom = 0, error = null;
    try {
      if (b.type === "qr") {
        const q = qr(text, b.ecc), m = b.module > 0 ? b.module : H / q.size;
        const quiet = b.quiet * m, size = q.size * m;
        for (let y = 0; y < q.size; y++) {
          let x = 0;
          while (x < q.size) {
            if (!q.modules[y][x]) { x++; continue; }
            let e = x; while (e < q.size && q.modules[y][e]) e++;
            polygons.push({outer: rect(quiet + x * m, -size + y * m, quiet + e * m, -size + (y + 1) * m), holes: []});
            x = e;
          }
        }
        width = size + 2 * quiet; top = -size - quiet; bottom = quiet;
      } else {
        const enc = b.type === "code39" ? code39(text, b.ratio) : code128(text), m = b.module;
        const quiet = b.quiet * m;
        for (const [x, w] of enc.bars) polygons.push({outer: rect(quiet + x * m, -H, quiet + (x + w) * m, 0), holes: []});
        width = enc.width * m + 2 * quiet;
        if (b.text) {
          const th = Math.max(.5, Math.min(H * .22, enc.width * m / Math.max(1, text.length) * 1.1));
          const l = globalThis.AtriumPCBText.layout(b.type === "code39" ? "*" + text.toUpperCase() + "*" : text, {height: th, width: th / 6, justify: "top-center", mirrored: false, lineSpacing: 0, strokeFont: p.strokeFont});
          const gap = th * .35;
          for (const s of l.strokes) strokes.push({points: s.points.map(q => [q[0] + width / 2, q[1] + gap + th / 12]), width: th / 6});
          bottom = gap + th + th / 6;
        }
      }
    } catch (e) { error = e.message; }
    return {strokes, polygons, width, top, bottom, error};
  }

  // A rectangle minus disjoint glyphs keeps the font's exact curves and counters.
  // Overlapping glyphs, edge contacts and strokes require the general clip below.
  function disjointKnockout(polygons,r){
    if(!polygons.length || polygons.length>512)return null;
    const boxes=polygons.map(poly=>{
      const b=[Infinity,Infinity,-Infinity,-Infinity];
      for(const [x,y] of poly.outer){b[0]=Math.min(b[0],x);b[1]=Math.min(b[1],y);b[2]=Math.max(b[2],x);b[3]=Math.max(b[3],y);}
      return b;
    }).sort((a,b)=>a[0]-b[0]);
    for(let i=0;i<boxes.length;i++){
      const b=boxes[i];
      if(b[0]<=r[0] || b[1]<=r[1] || b[2]>=r[2] || b[3]>=r[3])return null;
      for(let j=i+1;j<boxes.length && boxes[j][0]<=b[2];j++)if(boxes[j][1]<=b[3] && boxes[j][3]>=b[1])return null;
    }
    const [x0,y0,x1,y1]=r,outer=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
    const holes=polygons.map(q=>q.outer.slice().reverse());
    const islands=polygons.flatMap(q=>q.holes.map(ring=>({outer:ring.slice().reverse(),holes:[]})));
    return [{outer,holes},...islands];
  }
  function knockout(strokes, polygons, r, p) {
    const w = r[2] - r[0], h = r[3] - r[1];
    if (!(w > 0 && h > 0)) return [];
    if(p.letters && !strokes.length){
      const exact=disjointKnockout(polygons,r);
      if(exact)return exact;
    }
    const feature = Math.min(p.width, p.height / 6);
    let px = feature / 6;
    const maxPixels = 3e6;
    if ((w / px) * (h / px) > maxPixels) px = Math.sqrt(w * h / maxPixels);
    const W = Math.ceil(w / px) + 2, H = Math.ceil(h / px) + 2, map = {scale: 1 / px, ox: r[0] - px, oy: r[1] - px};
    const ink = new Uint8Array(W * H);
    if (strokes.length) V().rasterStrokes(ink, W, H, strokes, map);
    if (polygons.length) V().rasterPolygons(ink, W, H, polygons.flatMap(poly => [poly.outer, ...poly.holes]), map);
    // Paper field: rectangle (pixel-aligned from the top-left) minus ink.
    const x1 = Math.round(w / px) + 1, y1 = Math.round(h / px) + 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      ink[i] = x >= 1 && y >= 1 && x < x1 && y < y1 ? 255 - ink[i] : 0;
    }
    const t = V().traceField(ink, W, H, 127.5, {tolerance: .2, turdSize: .5});
    const back = q => [q[0] * px + map.ox, q[1] * px + map.oy];
    // Snap the outer rectangle exactly onto the requested margin box.
    const snap = q => [Math.abs(q[0] - r[0]) < px * .75 ? r[0] : Math.abs(q[0] - r[2]) < px * 1.5 ? r[2] : q[0],
      Math.abs(q[1] - r[1]) < px * .75 ? r[1] : Math.abs(q[1] - r[3]) < px * 1.5 ? r[3] : q[1]];
    return t.polygons.map(poly => {
      const outer = poly.outer.map(q => snap(back(q))), holes = poly.holes.map(h => h.map(back));
      return {outer, holes, area: holes.reduce((s, h) => s + V().area(h), V().area(outer))};
    });
  }

  return {available, truetype, savedRun, savedLayout, barcodeLayout, knockout, setGlyphSource,
    code39, code128, code128Values, qr, tables: {code39: C39W, code39Chars: C39, code128: C128}, rsDivisor, rsRemainder, gfMul};
})();
