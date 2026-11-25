"use strict";
// AtriumPDF: a small, dependency-free vector PDF writer. Pages are display lists
// in PDF points, Y down; print.js adds the recording CanvasRenderingContext2D
// (AtriumPDF.recorder) that turns the editor's own renderer into such lists,
// and AtriumPDF.svg for previews.
//
//   const pdf = AtriumPDF.document({title}), p = pdf.page(w, h, list);
//   pdf.link(p, [x0, y0, x1, y1], {page, x, y} | {uri}); pdf.outline(tree);
//   pdf.bytes() -> Uint8Array
// Text uses the standard 14 fonts with WinAnsi encoding; other characters are
// drawn as stroke-font outlines. Once pdf-fonts.js registers an embedded font
// (AtriumPDF.useFont), all text is written in it instead: a subset Type 0 font
// with a ToUnicode map, so every character stays selectable Unicode text.
// tiles()/shift() split a page larger than the paper over several sheets.
// Streams use a built-in deflate, so output is
// synchronous and deterministic: the same pages give the same bytes.
globalThis.AtriumPDF = (() => {
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------ zlib deflate
  // Fixed-Huffman deflate with hash-chain LZ77: synchronous, deterministic.
  const LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  function deflate(d) {
    const n = d.length;
    let out = new Uint8Array(1024 + (n >> 1)), o = 0, bit = 0, nb = 0;
    const byte = v => { if (o >= out.length) { const g = new Uint8Array(out.length * 2); g.set(out); out = g; } out[o++] = v; };
    const put = (v, k) => { bit |= v << nb; nb += k; while (nb >= 8) { byte(bit & 255); bit >>>= 8; nb -= 8; } };
    const code = (c, k) => { let r = 0; for (let i = 0; i < k; i++) { r = r << 1 | c & 1; c >>= 1; } put(r, k); };
    const lit = v => v < 144 ? code(0x30 + v, 8) : v < 256 ? code(0x190 + v - 144, 9) : v < 280 ? code(v - 256, 7) : code(0xc0 + v - 280, 8);
    const find = (t, v) => { let i = t.length - 1; while (t[i] > v) i--; return i; };
    byte(0x78); byte(1); put(3, 3);
    const head = new Int32Array(32768).fill(-1), prev = new Int32Array(32768);
    const hash = i => (d[i] << 10 ^ d[i + 1] << 5 ^ d[i + 2]) & 32767;
    const insert = p => { if (p + 2 < n) { const k = hash(p); prev[p & 32767] = head[k]; head[k] = p; } };
    for (let i = 0; i < n;) {
      let bl = 0, bd = 0;
      if (i + 2 < n) {
        const max = Math.min(258, n - i);
        for (let j = head[hash(i)], chain = 48; j >= 0 && i - j <= 32768 && chain--;) {
          if (d[j + bl] === d[i + bl]) { let l = 0; while (l < max && d[j + l] === d[i + l]) l++; if (l > bl) { bl = l; bd = i - j; if (l === max) break; } }
          const nj = prev[j & 32767]; if (nj >= j) break; j = nj;
        }
      }
      if (bl >= 3) {
        const li = find(LB, bl), di = find(DB, bd);
        lit(257 + li); put(bl - LB[li], LE[li]); code(di, 5); put(bd - DB[di], DE[di]);
        for (let e = i + bl; i < e; i++) insert(i);
      } else { lit(d[i]); insert(i); i++; }
    }
    lit(256); if (nb) byte(bit & 255);
    let a = 1, b = 0;
    for (let i = 0; i < n; i++) { a = (a + d[i]) % 65521; b = (b + a) % 65521; }
    for (const v of [b >> 8, b & 255, a >> 8, a & 255]) byte(v);
    return out.slice(0, o);
  }

  // ------------------------------------------------------------ fonts
  // Standard 14 fonts, WinAnsi encoding. Widths are the AFM advances for 32-126.
  const AFM = {
    H: "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556*10 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584",
    HB: "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556*10 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584",
    T: "250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500*10 278 278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 556 611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 500 444 333 500 500 278 278 500 278 778 500 500 500 500 333 389 278 500 500 722 500 500 444 480 200 480 541"
  };
  const BASE = {H: "Helvetica", HB: "Helvetica-Bold", T: "Times-Roman", TB: "Times-Bold", C: "Courier", CB: "Courier-Bold"};
  const widths = {};
  function widthTable(key) {
    const k = key[0] === "C" ? "C" : key === "TB" ? "T" : key;
    if (!widths[k]) widths[k] = k === "C" ? null : AFM[k].split(" ").flatMap(t => { const [v, r] = t.split("*"); return Array(+r || 1).fill(+v); });
    return widths[k];
  }
  const HIGH = {0xb0: 400, 0xb1: 584, 0xb5: 556, 0xd7: 584, 0x95: 350, 0x96: 556, 0x97: 1000};
  function advance(key, c) {
    if (key[0] === "C") return 600;
    const t = widthTable(key), w = c >= 32 && c <= 126 ? t[c - 32] : HIGH[c] || (key[0] === "T" ? 500 : 556);
    return key === "TB" ? w * 1.04 : w;
  }
  const CP1252 = {0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e,
    0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f, 0x3bc: 0xb5, 0x2212: 0x2d};
  const winAnsi = u => u >= 32 && u <= 126 || u >= 0xa0 && u <= 0xff ? u : CP1252[u];
  const pendingTypefaces=[];
  function registerTypeface(family, getBytes, options) {
    if (globalThis.AtriumPDFFonts?.registerTypeface) return AtriumPDFFonts.registerTypeface(family,getBytes,options);
    pendingTypefaces.push([family,getBytes,options]);
  }
  function fontOf(css) {
    if (pendingTypefaces.length && globalThis.AtriumPDFFonts?.registerTypeface)
      for (const entry of pendingTypefaces.splice(0)) AtriumPDFFonts.registerTypeface(...entry);
    const m = /([\d.]+)px\s*(.*)$/.exec(css || "") || [0, 10, "sans-serif"], pre = css.slice(0, css.indexOf(m[0]) >>> 0);
    const fam = m[2], bold = /\bbold|\b[6-9]00\b/.test(pre) ? "B" : "";
    const first = fam.split(",")[0], requestedWeight = Number(/\b([1-9]00)\b/.exec(pre)?.[1]) || (bold ? 700 : 400);
    const style = /\b(?:italic|oblique)\b/.test(pre) ? "italic" : "normal";
    const face = globalThis.AtriumPDFFonts?.matchTypeface?.(first,requestedWeight,style);
    if (face) return {key:face.key,size:+m[1]||10,synthBold:requestedWeight>=600 && face.weight<600,synthItalic:style==="italic" && face.style==="normal"};
    const base = /mono|courier|consol|menlo|code/i.test(first) ? "C" : /sans|helvetica|arial|system-ui|inter/i.test(first) ? "H" : /times|serif|georgia|roman|garamond/i.test(fam) ? "T" : "H";
    return {key: base === "H" ? "H" + bold : base + bold, size: +m[1] || 10};
  }
  // Characters outside WinAnsi (Ω, ≤, Greek…) draw as outlined stroke glyphs.
  const G = .7 / 6, GADV = .62;
  const strokeGlyph = ch => globalThis.AtriumPCBText?.glyph?.(ch) || null;
  // Embedded Unicode font (pdf-fonts.js registers DejaVu Sans). While one is set, text in every
  // family is measured and written with it: runs carry glyph IDs (g) and font key U (UB bold).
  let embedded = null;
  const useFont = f => { embedded = f && typeof f.gid === "function" && typeof f.subset === "function" ? f : null; return !!embedded; };
  function unicodeRuns(text, E, f) {
    const out = [], em = E.unitsPerEm;
    let cur = null, x = 0;
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      let g = cp < 32 ? 0 : E.gid(cp);
      if (!g && cp >= 32) { const sg = strokeGlyph(ch); if (sg) { out.push({glyph: sg, x}); cur = null; x += GADV; continue; } g = E.gid(0xfffd) || E.gid(63); }
      if (!g) continue;
      if (!cur) out.push(cur = {s: "", u: "", g: [], f, x});
      cur.u += ch; cur.g.push(g); x += E.advance(g) / em;
    }
    return {runs: out, width: x};
  }
  function runs(text, key) {
    const face = globalThis.AtriumPDFFonts?.typeface?.(key);
    if (face) return unicodeRuns(text,face.font(),key);
    if (embedded) return unicodeRuns(text,embedded,key.endsWith("B") ? "UB" : "U");
    const out = []; let cur = null, x = 0;
    for (const ch of String(text)) {
      let c = winAnsi(ch.codePointAt(0)), g = null;
      if (c == null) { g = strokeGlyph(ch); if (!g) c = 63; }
      if (g) { out.push({glyph: g, x}); cur = null; x += GADV; continue; }
      if (!cur) out.push(cur = {s: "", u: "", x});
      cur.s += String.fromCharCode(c); cur.u += ch; x += advance(key, c) / 1000;
    }
    return {runs: out, width: x};
  }

  // ------------------------------------------------------------ colours
  const named = {black: "#000", white: "#fff", red: "#f00", green: "#008000", blue: "#00f", yellow: "#ff0", gray: "#808080", grey: "#808080", silver: "#c0c0c0", navy: "#000080", orange: "#ffa500"};
  const colours = new Map();
  function rgba(css) {
    if (typeof css !== "string") return [.5, .5, .5, 1];
    let c = colours.get(css);
    if (c) return c;
    let s = css.trim().toLowerCase(); s = named[s] || s;
    if (s === "transparent" || s === "none") c = [0, 0, 0, 0];
    else if (s[0] === "#") {
      const h = s.length < 6 ? s.slice(1).replace(/./g, "$&$&") : s.slice(1), v = i => parseInt(h.substr(i, 2), 16) / 255;
      c = [v(0), v(2), v(4), h.length >= 8 ? v(6) : 1];
    } else {
      const m = /^rgba?\(([^)]*)\)/.exec(s), p = m ? m[1].split(/[\s,/]+/).filter(Boolean) : [];
      const n = (t, k) => t == null ? 1 : t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t) / k;
      c = p.length >= 3 ? [n(p[0], 255), n(p[1], 255), n(p[2], 255), n(p[3], 1)] : [.5, .5, .5, 1];
    }
    c = c.map(v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : .5)));
    if (colours.size > 4096) colours.clear();
    colours.set(css, c); return c;
  }

  // ------------------------------------------------------------ Path2D
  // The recorder (Path2D wrapper) is path-record.js, loaded before any drawing.
  const {REC, NAMES, NARGS, radius} = globalThis.AtriumPathRecord;

  // ------------------------------------------------------------ PDF writer
  const N = v => String(Math.round(v * 100) / 100);
  const C3 = v => String(Math.round(v * 1000) / 1000);
  const latin1 = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
  const lit = s => "(" + s.replace(/[\\()]/g, "\\$&").replace(/[\x00-\x1f]/g, c => "\\" + c.charCodeAt(0).toString(8).padStart(3, "0")) + ")";
  const utf16 = s => { let h = "FEFF"; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, "0"); return "<" + h + ">"; };
  function pathOps(d, out) {
    for (let i = 0; i < d.length;) {
      const k = d[i++];
      if (k === 3) { out.push("h"); continue; }
      const n = k === 2 ? 6 : 2, a = [];
      // Keep the start and all three control/end points of a cubic to sub-micrometre
      // precision at 1:1. Rounding these to the text/line grid can exceed the arc tolerance.
      const curve = k === 2 || d[i+n] === 2;
      for (let j = 0; j < n; j++) { const v = d[i++]; a.push(curve ? String(Math.round(v * 1e6) / 1e6) : N(v)); }
      out.push(a.join(" ") + (k === 0 ? " m" : k === 1 ? " l" : " c"));
    }
  }
  function content(page, res) {
    const out = ["1 0 0 -1 0 " + N(page.h) + " cm", "q"];
    let clip = null, st = {}, layer = null, span;
    const set = (key, v, op) => { if (st[key] !== v) { st[key] = v; out.push(op); } };
    const alpha = a => { const g = "G" + Math.round(Math.min(1, a) * 100); res.gs.add(g); set("gs", g, "/" + g + " gs"); };
    const chain = c => { if (!c) return; chain(c.parent); pathOps(c.d, out); out.push(c.eo ? "W* n" : "W n"); };
    for (const op of page.list) {
      const next = op.layer || null, key = typeof next === "string" ? next : next?.id || null;
      if (key !== layer) {
        if (span) { out.push("EMC"); span = undefined; }
        out.push("Q");
        if (layer) out.push("EMC");
        if (key) {
          if (!res.layers.has(key)) res.layers.set(key, {name:next.name || key, visible:next.visible !== false, resource:"L"+(res.layers.size+1)});
          out.push("/OC /" + res.layers.get(key).resource + " BDC");
        }
        out.push("q"); clip = null; st = {}; layer = key;
      }
      if (span !== op.actualText) {
        if (span) out.push("EMC");
        span=op.actualText;
        if (span) out.push("/Span << /ActualText "+utf16(span.text)+" >> BDC");
      }
      if (op.clip !== clip) { out.push("Q", "q"); chain(op.clip); clip = op.clip; st = {}; }
      if (op.k === "i") {
        res.img.has(op.img) || res.img.set(op.img, "I" + (res.img.size + 1));
        alpha(op.a); out.push("q " + op.m.map(N).join(" ") + " cm /" + res.img.get(op.img) + " Do Q"); continue;
      }
      const rgb = op.c.slice(0, 3).map(C3).join(" ");
      alpha(op.a);
      if (op.k === "math") {
        set("f", rgb, rgb + " rg");
        AtriumMathPDF.content(op,res,out,utf16);
        continue;
      }
      if (op.k === "t") {
        const tm = op.m.map(v => String(Math.round(v * 1e4) / 1e4)).join(" ") + " Tm ";
        if (op.g) {
          // Embedded font: hex glyph IDs (Identity-H). Bold is fill plus a thin stroke of the same ink.
          const face = globalThis.AtriumPDFFonts?.typeface?.(op.f);
          let key = "U", glyphs = res.glyphs;
          if (face) {
            let usage = res.faces.get(face.key);
            if (!usage) {
              usage={name:"F"+(res.faces.size+1),face,glyphs:new Map()};
              res.faces.set(face.key,usage);
            }
            key=usage.name; glyphs=usage.glyphs;
          } else res.font.add(key);
          const cps = Array.from(op.u || "");
          op.g.forEach((g, i) => { if (!glyphs.has(g)) glyphs.set(g, cps[i] || ""); });
          const bold = (op.f === "UB" || op.synthBold) && !op.sw;
          if (op.sw) { set("S", rgb, rgb + " RG"); set("w", op.sw, N(op.sw) + " w"); }
          else { set("f", rgb, rgb + " rg"); if (bold) { const bw = Math.max(.05, Math.sqrt(Math.abs(op.m[0] * op.m[3] - op.m[1] * op.m[2])) * .035); set("S", rgb, rgb + " RG"); set("w", bw, N(bw) + " w"); } }
          out.push("BT /" + key + " 1 Tf " + (op.invisible ? "3" : op.sw ? "1" : bold ? "2" : "0") + " Tr " + tm + "<" + op.g.map(g => g.toString(16).padStart(4, "0")).join("") + "> Tj ET");
          continue;
        }
        res.font.add(op.f);
        if (op.sw) { set("S", rgb, rgb + " RG"); set("w", op.sw, N(op.sw) + " w"); }
        else set("f", rgb, rgb + " rg");
        out.push("BT /" + op.f + " 1 Tf " + (op.invisible ? "3" : op.sw ? "1" : "0") + " Tr " + tm + lit(op.s) + " Tj ET");
        continue;
      }
      if (op.fill) set("f", rgb, rgb + " rg");
      else {
        set("S", rgb, rgb + " RG"); set("w", op.w, N(op.w) + " w");
        set("J", op.cap, (op.cap === "round" ? 1 : op.cap === "square" ? 2 : 0) + " J");
        set("j", op.join, (op.join === "round" ? 1 : op.join === "bevel" ? 2 : 0) + " j");
        const dash = op.dash ? "[" + op.dash.map(N).join(" ") + "] " + N(op.off || 0) + " d" : "[] 0 d";
        set("d", dash, dash);
      }
      pathOps(op.d, out);
      out.push(op.fill ? op.eo ? "f*" : "f" : "S");
    }
    if (span) out.push("EMC");
    out.push("Q");
    if (layer) out.push("EMC");
    return out.join("\n") + "\n";
  }
  // Type 0 / CIDFontType2, widths, ToUnicode and the embedded subset. Ordinary text
  // uses CID = GID. Shaped mathematics can associate multiple semantic clusters with one GID.
  function type0(glyphs, alloc, objs, stream, ref, E = embedded, cidToGid = null) {
    const codes = [...glyphs.keys()].sort((a,b) => a-b), k = 1000 / E.unitsPerEm;
    const gids = cidToGid ? [...new Set(cidToGid)].sort((a,b)=>a-b) : codes;
    let h = 0x811c9dc5;
    for (const g of gids) h = Math.imul(h ^ g, 0x01000193) >>> 0;
    let tag = "";
    for (let i = 0; i < 6; i++) { tag += String.fromCharCode(65 + h % 26); h = Math.floor(h / 26) + i * 7919; }
    const name = tag + "+" + E.name, cid = alloc(), desc = alloc(), file = alloc(), cmap = alloc();
    const program = E.subset(gids);
    objs[file - 1] = stream("<< /Length1 " + program.length, program);
    objs[desc - 1] = "<< /Type /FontDescriptor /FontName /" + name + " /Flags " + (E.flags || 32) + " /FontBBox [" + E.bbox.map(v => Math.round(v * k)).join(" ") + "]" +
      " /ItalicAngle " + (E.italicAngle || 0) + " /Ascent " + Math.round(E.ascent * k) + " /Descent " + Math.round(E.descent * k) +
      " /CapHeight " + Math.round(E.capHeight * k) + " /StemV 80 /FontFile2 " + ref(file) + " >>";
    let mapping = "/Identity";
    if (cidToGid) {
      const id = alloc(), bytes = new Uint8Array(cidToGid.length * 2);
      cidToGid.forEach((gid,cid) => { bytes[2*cid] = gid >>> 8; bytes[2*cid+1] = gid & 255; });
      objs[id-1] = stream("<<",bytes); mapping = ref(id);
    }
    const w = codes.map(c => c + " [" + Math.round(E.advance(cidToGid ? cidToGid[c] : c) * k) + "]");
    const lines = [];
    for (let i = 0; i < w.length; i += 16) lines.push(w.slice(i, i + 16).join(" "));
    objs[cid - 1] = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /" + name + " /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>" +
      " /FontDescriptor " + ref(desc) + " /DW " + Math.round(E.advance(0) * k) + " /W [" + lines.join("\n") + "] /CIDToGIDMap " + mapping + " >>";
    const hex4 = v => v.toString(16).padStart(4, "0").toUpperCase(), utf = s => { let o = ""; for (let i = 0; i < s.length; i++) o += hex4(s.charCodeAt(i)); return o || "FFFD"; };
    const bf = [];
    const mapped = cidToGid ? codes.filter(c => glyphs.get(c)) : codes;
    for (let i = 0; i < mapped.length; i += 100) {
      const part = mapped.slice(i, i + 100);
      bf.push(part.length + " beginbfchar", ...part.map(g => "<" + hex4(g) + "> <" + utf(glyphs.get(g)) + ">"), "endbfchar");
    }
    const cm = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
      "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" + bf.join("\n") +
      "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    objs[cmap - 1] = stream("<<", latin1(cm));
    return "<< /Type /Font /Subtype /Type0 /BaseFont /" + name + " /Encoding /Identity-H /DescendantFonts [" + ref(cid) + "] /ToUnicode " + ref(cmap) + " >>";
  }

  // ------------------------------------------------------------ tiling
  // A display list larger than the paper, printed at a fixed scale, is split over several
  // sheets. tiles() lays out the grid (with an overlap for gluing) and shift() moves a display
  // list so one tile lands in the page's printable area, clipped to it.
  function tiles(width, height, area, overlap = 0, maxPages = Infinity) {
    const aw = area[2] - area[0], ah = area[3] - area[1], ov = Math.max(0, Math.min(overlap, aw / 3, ah / 3));
    const nx = Math.max(1, Math.ceil((width - ov) / (aw - ov) - 1e-9)), ny = Math.max(1, Math.ceil((height - ov) / (ah - ov) - 1e-9)), out = [];
    if (!Number.isFinite(nx * ny) || nx * ny > maxPages) throw Error("This scale requires " + (nx * ny).toLocaleString() + " pages. Choose a smaller tile scale or larger paper.");
    for (let row = 0; row < ny; row++) for (let col = 0; col < nx; col++)
      out.push({row, col, rows: ny, cols: nx, index: out.length, count: nx * ny, x: col * (aw - ov), y: row * (ah - ov), dx: area[0] - col * (aw - ov), dy: area[1] - row * (ah - ov)});
    return out;
  }
  function shift(list, dx, dy, clipRect) {
    const root = clipRect ? {d: [0, clipRect[0], clipRect[1], 1, clipRect[2], clipRect[1], 1, clipRect[2], clipRect[3], 1, clipRect[0], clipRect[3], 3], parent: null} : null;
    const moved = new Map();
    const path = d => { const o = d.slice(); for (let i = 0; i < o.length;) { const k = o[i++]; if (k === 3) continue; const n = k === 2 ? 3 : 1; for (let j = 0; j < n; j++) { o[i++] += dx; o[i++] += dy; } } return o; };
    const clip = c => {
      if (!c) return root;
      if (!moved.has(c)) moved.set(c, {d: path(c.d), eo: c.eo, parent: clip(c.parent)});
      return moved.get(c);
    };
    return list.map(op => {
      const o = {...op, clip: clip(op.clip)};
      if (op.d) o.d = path(op.d);
      if (op.m) o.m = [op.m[0], op.m[1], op.m[2], op.m[3], op.m[4] + dx, op.m[5] + dy];
      return o;
    });
  }
  // Paths and text runs in a display list (a quick measure of how much vector content a page has).
  const counts = list => list.reduce((c, op) => {
    if (op.k === "math") for (const cmd of op.layout.commands) c[cmd.kind === "glyph" ? "text" : "paths"]++;
    else c[op.k === "t" ? "text" : op.k === "i" ? "images" : "paths"]++;
    return c;
  }, {paths: 0, text: 0, images: 0});

  function hash(bytes) {
    let h = [0x811c9dc5, 0x01000193, 0x2545f491, 0x9e3779b9];
    for (let i = 0; i < bytes.length; i++) h = h.map((v, k) => Math.imul(v ^ bytes[i] ^ k, 0x01000193) >>> 0);
    return h.map(v => v.toString(16).padStart(8, "0")).join("");
  }
  function document(info = {}) {
    const pages = [], files = new Map();
    let tree = null;
    const api = {
      get pageCount() { return pages.length; },
      page(w, h, list = []) { pages.push({w, h, list, annots: []}); return pages.length - 1; },
      link(page, rect, target) { if (pages[page] && target) pages[page].annots.push({rect, target}); },
      note(page, rect, {title, contents}) {
        if (pages[page] && contents) pages[page].annots.push({rect,title:String(title || ""),contents:String(contents)});
      },
      attach({name, mime, bytes}) {
        if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name))
          throw Error("An attachment needs a filename without a path.");
        if (files.has(name)) throw Error("Duplicate PDF attachment " + name + ".");
        if (!(bytes instanceof Uint8Array) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)) throw Error("Invalid PDF attachment data.");
        files.set(name,{name,mime,bytes:bytes.slice()});
      },
      outline(items) { tree = items; },
      bytes(o = {}) {
        const compress = o.compress !== false && info.compress !== false;
        const stamp=info.date instanceof Date ? "(D:"+info.date.toISOString().replace(/[-:T]/g,"").slice(0,14)+"Z)" : "";
        const res = {font: new Set(), gs: new Set(), img: new Map(), glyphs: new Map(), faces: new Map(), layers: new Map()};
        const streams = pages.map(p => latin1(content(p, res)));
        const objs = [];   // [number] -> string | {dict, data}
        const alloc = () => objs.push(null);
        const CAT = alloc(), PAGES = alloc(), RES = alloc(), INFO = alloc();
        const ids = pages.map(() => [alloc(), alloc()]);
        const ref = n => n + " 0 R";
        const dest = t => { const p = pages[t.page]; return p ? "[" + ref(ids[t.page][0]) + " /XYZ " + (t.x == null ? "null" : N(t.x)) + " " + (t.y == null ? "null" : N(p.h - t.y)) + " " + (t.zoom == null ? "null" : N(t.zoom)) + "]" : null; };
        const stream = (dict, data) => {
          if (compress && !/\/Filter/.test(dict)) { data = deflate(data); dict += " /Filter /FlateDecode"; }
          return {dict: dict + " /Length " + data.length, data};
        };
        let noteAppearance;
        pages.forEach((p, i) => {
          const annots = p.annots.map(a => {
            const r = a.rect;
            if (a.contents) {
              // A viewer's default sticky-note icon can cover an entire symbol.
              // The part itself is the visible hit area. An explicit appearance
              // keeps the schematic legible and its native comment interactive.
              if (!noteAppearance) {
                noteAppearance=alloc();
                objs[noteAppearance-1]=stream("<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << >>",latin1("q Q\n"));
              }
              const at = [r[0], p.h-r[3], r[2], p.h-r[1]].map(N).join(" "), id = alloc();
              objs[id-1] = "<< /Type /Annot /Subtype /Text /Name /Comment /Rect [" + at + "] /P " + ref(ids[i][0]) +
                " /T " + utf16(a.title) + " /Contents " + utf16(a.contents) + (stamp ? " /M "+stamp+" /CreationDate "+stamp : "") +
                " /AP << /N "+ref(noteAppearance)+" >> /Open false /F 0 >>";
              return ref(id);
            }
            const d = a.target.uri ? null : dest(a.target);
            if (!a.target.uri && !d) return "";
            return "<< /Type /Annot /Subtype /Link /Rect [" + [r[0], p.h - r[3], r[2], p.h - r[1]].map(N).join(" ") + "] /Border [0 0 0]" +
              (a.target.uri ? " /A << /S /URI /URI " + lit(String(a.target.uri)) + " >>" : " /Dest " + d) + " >>";
          }).filter(Boolean);
          objs[ids[i][0] - 1] = "<< /Type /Page /Parent " + ref(PAGES) + " /MediaBox [0 0 " + N(p.w) + " " + N(p.h) + "] /Resources " + ref(RES) +
            " /Contents " + ref(ids[i][1]) + (annots.length ? " /Annots [" + annots.join(" ") + "]" : "") + " >>";
          objs[ids[i][1] - 1] = stream("<<", streams[i]);
        });
        const fonts = [...res.font].sort().map(k => {
          const n = alloc();
          if (k === "M") objs[n-1] = type0(res.math.unicode,alloc,objs,stream,ref,AtriumMathPDF.font(),res.math.glyphs);
          else objs[n - 1] = k === "U" ? type0(res.glyphs, alloc, objs, stream, ref) : "<< /Type /Font /Subtype /Type1 /BaseFont /" + BASE[k] + " /Encoding /WinAnsiEncoding >>";
          return "/" + k + " " + ref(n);
        });
        for (const {name,face,glyphs} of res.faces.values()) {
          const n=alloc();
          objs[n-1]=type0(glyphs,alloc,objs,stream,ref,face.font());
          fonts.push("/"+name+" "+ref(n));
        }
        const xobj = [...res.img].map(([img, name]) => {
          const n = alloc(); let smask = "";
          if (img.alpha) { const m = alloc(); objs[m - 1] = stream("<< /Type /XObject /Subtype /Image /Width " + img.w + " /Height " + img.h + " /ColorSpace /DeviceGray /BitsPerComponent 8", img.alpha); smask = " /SMask " + ref(m); }
          objs[n - 1] = img.jpeg ? stream("<< /Type /XObject /Subtype /Image /Width " + img.w + " /Height " + img.h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", img.jpeg)
            : stream("<< /Type /XObject /Subtype /Image /Width " + img.w + " /Height " + img.h + " /ColorSpace /DeviceRGB /BitsPerComponent 8" + smask, img.rgb);
          return "/" + name + " " + ref(n);
        });
        const gs = [...res.gs].sort().map(g => "/" + g + " << /ca " + +g.slice(1) / 100 + " /CA " + +g.slice(1) / 100 + " >>");
        const entries = [...res.layers.values()].map(layer => {
          const id = alloc(); objs[id-1] = "<< /Type /OCG /Name " + utf16(layer.name) + " >>"; return {...layer,ref:ref(id)};
        });
        const properties = entries.length ? " /Properties << " + entries.map(e=>"/"+e.resource+" "+e.ref).join(" ") + " >>" : "";
        objs[RES - 1] = "<< /ProcSet [/PDF /Text /ImageB /ImageC]" + properties + (fonts.length ? " /Font << " + fonts.join(" ") + " >>" : "") +
          (gs.length ? " /ExtGState << " + gs.join(" ") + " >>" : "") + (xobj.length ? " /XObject << " + xobj.join(" ") + " >>" : "") + " >>";
        objs[PAGES - 1] = "<< /Type /Pages /Kids [" + ids.map(i => ref(i[0])).join(" ") + "] /Count " + pages.length + " >>";
        // Outline (bookmarks): nested {title, page, x, y, open, children}.
        let outlines = "";
        const items = (tree || []).filter(t => t && t.title != null);
        if (items.length) {
          const root = alloc();
          const level = (list, parent) => {
            const nums = list.map(() => alloc());
            let visible = 0;
            list.forEach((t, i) => {
              const kids = (t.children || []).filter(c => c && c.title != null);
              const sub = kids.length ? level(kids, nums[i]) : null, d = t.page != null ? dest(t) : null;
              objs[nums[i] - 1] = "<< /Title " + utf16(String(t.title)) + " /Parent " + ref(parent) + (i ? " /Prev " + ref(nums[i - 1]) : "") +
                (i < list.length - 1 ? " /Next " + ref(nums[i + 1]) : "") + (sub ? " /First " + ref(sub.first) + " /Last " + ref(sub.last) + " /Count " + (t.open ? sub.count : -kids.length) : "") +
                (d ? " /Dest " + d : "") + " >>";
              visible += 1 + (sub && t.open ? sub.count : 0);
            });
            return {first: nums[0], last: nums.at(-1), count: visible};
          };
          const top = level(items, root);
          objs[root - 1] = "<< /Type /Outlines /First " + ref(top.first) + " /Last " + ref(top.last) + " /Count " + top.count + " >>";
          outlines = " /Outlines " + ref(root) + " /PageMode /UseOutlines";
        }
        const groups = entries.map(l=>l.ref).join(" "), off = entries.filter(l=>!l.visible).map(l=>l.ref).join(" ");
        const oc = groups ? " /OCProperties << /OCGs ["+groups+"] /D << /Name (Layers) /BaseState /ON /Order ["+groups+"] /OFF ["+off+"] >> >>" : "";
        const attachments = [...files.keys()].sort().map(name => {
          const {bytes,mime}=files.get(name), body=alloc(), spec=alloc();
          objs[body-1] = stream("<< /Type /EmbeddedFile /Subtype /"+mime.replace("/","#2F")+" /Params << /Size "+bytes.length+" >>",bytes);
          const fallback = lit(name.replace(/[^\x20-\x7e]/g,"_"));
          objs[spec-1] = "<< /Type /Filespec /F "+fallback+" /UF "+utf16(name)+" /EF << /F "+ref(body)+" /UF "+ref(body)+" >> >>";
          return utf16(name)+" "+ref(spec);
        });
        const names = attachments.length ? " /Names << /EmbeddedFiles << /Names ["+attachments.join(" ")+"] >> >>" : "";
        // Since PDF 1.4 the catalog can upgrade the header's version. Optional
        // content and Unicode attachment names require the later feature level.
        const version = entries.length || files.size ? " /Version /1.7" : "";
        objs[CAT - 1] = "<< /Type /Catalog /Pages " + ref(PAGES) + version + outlines + oc + names + " >>";
        const date=stamp ? " /CreationDate "+stamp : "";
        objs[INFO - 1] = "<< /Producer (Waffle) /Creator (Waffle)" + (info.title ? " /Title " + utf16(String(info.title)) : "") + (info.subject ? " /Subject " + utf16(String(info.subject)) : "") + date + " >>";
        const chunks = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")], offsets = [];
        let at = chunks[0].length;
        const push = b => { chunks.push(b); at += b.length; };
        objs.forEach((o, i) => {
          offsets.push(at);
          if (typeof o === "string") push(latin1((i + 1) + " 0 obj\n" + o + "\nendobj\n"));
          else { push(latin1((i + 1) + " 0 obj\n" + o.dict + " >>\nstream\n")); push(o.data); push(latin1("\nendstream\nendobj\n")); }
        });
        const body = new Uint8Array(at); let p = 0;
        for (const c of chunks) { body.set(c, p); p += c.length; }
        const id = hash(body.subarray(0, Math.min(body.length, 1 << 20)));
        const tail = latin1("xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n" + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") +
          "trailer\n<< /Size " + (objs.length + 1) + " /Root " + ref(CAT) + " /Info " + ref(INFO) + " /ID [<" + id + "> <" + id + ">] >>\nstartxref\n" + at + "\n%%EOF\n");
        const out = new Uint8Array(at + tail.length); out.set(body); out.set(tail, at);
        return out;
      }
    };
    return api;
  }

  // recorder() and svg() are added by print.js.
  return {deflate, document, rgba, fontOf, advance, winAnsi, runs, paths: REC, NAMES, NARGS, radius, glyph: {scale: G, advance: GADV},
    registerTypeface,
    useFont, get embeddedFont() { return embedded; }, tiles, shift, counts};
})();
