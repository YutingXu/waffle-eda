"use strict";
// AtriumPDFFonts: embedded Unicode fonts for AtriumPDF. Loads after pdf.js (lazy module
// AtriumPDFFonts) and registers the vendored DejaVu Sans subset (vendor/dejavu-sans.js) with
// AtriumPDF.useFont, so every PDF the app writes keeps its text as real, selectable, searchable
// Unicode text in one embedded TrueType font, instead of the standard 14 fonts (WinAnsi only)
// with stroke-drawn fallbacks.
//
// The writer (pdf.js) embeds it as a Type 0 font: CIDFontType2, Identity-H encoding (CID =
// glyph ID), a /W width array and a ToUnicode CMap. Each PDF carries a subset holding only
// the glyphs it uses (plus composite glyph components); unused glyphs are emptied, so glyph
// IDs, and therefore the content streams, stay the same as in the full font.
//
//   AtriumPDFFonts.parse(bytes)          -> font {name, unitsPerEm, gid(cp), advance(gid), subset(gids), ...}
//   AtriumPDFFonts.decode(base64)        -> Uint8Array
//   AtriumPDFFonts.font()                -> the DejaVu Sans font (parsed once), or null
//   AtriumPDFFonts.install()             -> registers it with AtriumPDF (done on load)
globalThis.AtriumPDFFonts = (() => {
  const fail = m => { throw Error(m); };

  // ------------------------------------------------------------ base64 (no atob in every runner)
  const B64 = new Int16Array(256).fill(-1);
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => { B64[c.charCodeAt(0)] = i; });
  function decode(s) {
    s = String(s || "");
    const out = new Uint8Array(Math.floor(s.length * 3 / 4) + 3);
    let o = 0, acc = 0, n = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B64[s.charCodeAt(i) & 255];
      if (v < 0) continue;
      acc = acc << 6 | v; n += 6;
      if (n >= 8) { n -= 8; out[o++] = acc >> n & 255; }
    }
    return out.slice(0, o);
  }

  // ------------------------------------------------------------ reading
  const u16 = (b, p) => b[p] << 8 | b[p + 1];
  const i16 = (b, p) => { const v = u16(b, p); return v & 0x8000 ? v - 0x10000 : v; };
  const u32 = (b, p) => (b[p] << 24 >>> 0) + (b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]);
  function tables(b) {
    const ver = u32(b, 0);
    if (ver !== 0x00010000 && ver !== 0x74727565) fail("Only TrueType outlines can be embedded.");
    const n = u16(b, 4), t = new Map();
    for (let i = 0; i < n; i++) {
      const p = 12 + i * 16, tag = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      const off=u32(b,p+8),len=u32(b,p+12);
      if(p+16>b.length || off+len>b.length)fail("Invalid TrueType table bounds.");
      t.set(tag,{off,len});
    }
    for (const k of ["head", "hhea", "hmtx", "maxp", "cmap", "loca", "glyf"]) if (!t.has(k)) fail("The font has no " + k + " table.");
    return t;
  }
  function cmapOf(b, t) {
    const base = t.get("cmap").off, n = u16(b, base + 2), map = new Map();
    let best = null, score = -1, symbol=false;
    for (let i = 0; i < n; i++) {
      const p = base + 4 + i * 8, plat = u16(b, p), enc = u16(b, p + 2), off = base + u32(b, p + 4), fmt = u16(b, off);
      const s = plat === 3 && enc === 10 && fmt === 12 ? 3 : plat === 0 && fmt === 12 ? 2 : plat === 3 && enc === 1 && fmt === 4 ? 1 : (plat === 0 || plat === 3 && enc === 0) && fmt === 4 ? 0 : -1;
      if (s > score) { score = s; best = off; symbol=plat===3 && enc===0; }
    }
    if (best == null) fail("The font has no Unicode character map.");
    const fmt = u16(b, best);
    let remaining=0x110000;
    if (fmt === 4) {
      const segs = u16(b, best + 6) >> 1, ends = best + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = u16(b, ends + s * 2), start = u16(b, starts + s * 2), delta = i16(b, deltas + s * 2), ro = u16(b, ranges + s * 2);
        if((remaining-=Math.max(0,end-start+1))<0)fail("Invalid character map span.");
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (!ro) g = c + delta & 0xffff;
          else { const p = ranges + s * 2 + ro + (c - start) * 2; g = u16(b, p); if (g) g = g + delta & 0xffff; }
          if (g){map.set(c,g);if(symbol && c>=0xf000 && c<=0xf0ff)map.set(c-0xf000,g);}
        }
      }
    } else {
      const groups = u32(b, best + 12);
      if(groups>(b.length-best-16)/12)fail("Truncated character map.");
      for (let i = 0; i < groups; i++) {
        const p = best + 16 + i * 12, start = u32(b, p), end = u32(b, p + 4), g0 = u32(b, p + 8);
        if(end>0x10ffff || (remaining-=Math.max(0,end-start+1))<0)fail("Invalid character map span.");
        for (let c = start; c <= end; c++) map.set(c,g0+c-start);
      }
    }
    return map;
  }
  function nameOf(b, t) {
    const n = t.get("name");
    if (!n) return "Embedded";
    const base = n.off, count = u16(b, base + 2), strings = base + u16(b, base + 4);
    let found = null;
    for (let i = 0; i < count; i++) {
      const p = base + 6 + i * 12, plat = u16(b, p), id = u16(b, p + 6), len = u16(b, p + 8), off = strings + u16(b, p + 10);
      if (id !== 6) continue;
      let s = "";
      if (plat === 3 || plat === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(u16(b, off + k));
      else for (let k = 0; k < len; k++) s += String.fromCharCode(b[off + k]);
      if (s && (!found || plat === 3)) found = s;
    }
    return (found || "Embedded").replace(/[^A-Za-z0-9-]/g, "") || "Embedded";
  }
  // Read TrueType contours only for glyphs the board actually draws. Subsets
  // used for PDF text keep the original quadratics; PCB films need polylines.
  // https://learn.microsoft.com/en-us/typography/opentype/spec/glyf
  function glyphContours(bytes,offsets,glyf,glyph){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),seen=new Set();
    let pointsLeft=32000,componentsLeft=512;
    function draw(g,depth){
      if(--componentsLeft<0||g<0||g+1>=offsets.length||depth>12||seen.has(g))throw Error("Invalid composite glyph.");
      let p=glyf+offsets[g],end=glyf+offsets[g+1];
      if(p===end)return [];
      if(end-p<10||end>bytes.length)throw Error("Invalid glyph bounds.");
      const need=n=>{if(p+n>end)throw Error("Truncated glyph.");};
      const byte=()=>{need(1);return bytes[p++];};
      const word=()=>{need(2);const n=view.getUint16(p);p+=2;return n;};
      const signed=()=>{need(2);const n=view.getInt16(p);p+=2;return n;};
      const n=signed();p+=8;
      if(n<0){
        seen.add(g);let flags,rings=[];
        do{
          flags=word();const child=word(),wide=!!(flags&1);
          if(!(flags&2))throw Error("Point-matched composite glyph.");
          const dx=wide?signed():byte()<<24>>24,dy=wide?signed():byte()<<24>>24;
          let a=1,b=0,c=0,d=1;
          if(flags&8)a=d=signed()/16384;
          else if(flags&64){a=signed()/16384;d=signed()/16384;}
          else if(flags&128){a=signed()/16384;b=signed()/16384;c=signed()/16384;d=signed()/16384;}
          const contours=draw(child,depth+1);
          for(const ring of contours)rings.push(ring.map(([x,y])=>[a*x+c*y+dx,b*x+d*y+dy]));
        }while(flags&32);
        seen.delete(g);return rings;
      }
      if(!n)return [];
      need(n*2+2);
      const ends=Array.from({length:n},word),size=ends[n-1]+1;
      if(size>pointsLeft||ends.some((e,i)=>i>0&&e<=ends[i-1]))throw Error("Invalid glyph contours.");
      pointsLeft-=size;
      const instructions=word();need(instructions);p+=instructions;
      const flags=[];
      while(flags.length<size){
        const flag=byte(),repeat=flag&8?byte()+1:1;
        if(repeat>size-flags.length)throw Error("Invalid glyph flag repeat.");
        for(let k=0;k<repeat;k++)flags.push(flag);
      }
      const axis=(short,same)=>{let v=0;return flags.map(f=>{
        v+=f&short?(f&same?1:-1)*byte():f&same?0:signed();return v;
      });};
      const xs=axis(2,16),ys=axis(4,32),rings=[];
      let first=0;
      for(const last of ends){
        const pts=[];
        for(let i=first;i<=last;i++)pts.push({x:xs[i],y:ys[i],on:!!(flags[i]&1)});
        first=last+1;
        const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2,on:true});
        const close=pts.at(-1),start=pts[0].on?pts.shift():close.on?pts.pop():midpoint(close,pts[0]);
        pts.push(start);
        const ring=[[start.x,start.y]];let prev=start;
        for(let i=0;i<pts.length;i++){
          const q=pts[i];
          if(q.on){ring.push([q.x,q.y]);prev=q;continue;}
          const next=pts[i+1],dest=next.on?pts[++i]:midpoint(q,next);
          const deviation=Math.hypot(prev.x-2*q.x+dest.x,prev.y-2*q.y+dest.y);
          const steps=Math.min(32,Math.max(1,Math.ceil(Math.sqrt(deviation/4))));
          for(let j=1;j<=steps;j++){const t=j/steps,u=1-t;ring.push([u*u*prev.x+2*u*t*q.x+t*t*dest.x,u*u*prev.y+2*u*t*q.y+t*t*dest.y]);}
          prev=dest;
        }
        ring.pop();if(ring.length>=3)rings.push(ring);
      }
      return rings;
    }
    return draw(glyph,0);
  }
  function parse(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), t = tables(b);
    const head = t.get("head").off, hhea = t.get("hhea").off, maxp = t.get("maxp").off, hmtx = t.get("hmtx").off;
    const unitsPerEm = u16(b, head + 18), longLoca = i16(b, head + 50) === 1, numGlyphs = u16(b, maxp + 4), hMetrics = u16(b, hhea + 34);
    const bbox = [i16(b, head + 36), i16(b, head + 38), i16(b, head + 40), i16(b, head + 42)];
    const loca = t.get("loca").off, glyf = t.get("glyf").off;
    const offsets = new Uint32Array(numGlyphs + 1);
    for (let g = 0; g <= numGlyphs; g++) offsets[g] = longLoca ? u32(b, loca + g * 4) : u16(b, loca + g * 2) * 2;
    const widths = new Uint16Array(numGlyphs);
    for (let g = 0; g < numGlyphs; g++) widths[g] = u16(b, hmtx + Math.min(g, hMetrics - 1) * 4);
    const os2 = t.get("OS/2")?.off;
    const ascent = os2 != null ? i16(b, os2 + 68) : i16(b, hhea + 4), descent = os2 != null ? i16(b, os2 + 70) : i16(b, hhea + 6);
    const capHeight = os2 != null && u16(b, os2) >= 2 ? i16(b, os2 + 88) : Math.round(ascent * .7);
    const cmap = cmapOf(b, t), name = nameOf(b, t);
    // Composite glyphs reference their components by glyph ID; a subset keeps them.
    function components(g) {
      const s = glyf + offsets[g], e = glyf + offsets[g + 1], out = [];
      if (e - s < 10 || i16(b, s) >= 0) return out;
      let p = s + 10;
      for (;;) {
        const flags = u16(b, p); out.push(u16(b, p + 2)); p += 4;
        p += flags & 1 ? 4 : 2;
        if (flags & 8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
        if (!(flags & 0x20) || p >= e) break;
      }
      return out;
    }
    // The font with every glyph outside `gids` (and .notdef) emptied; tables are rebuilt with
    // checksums. Keep global hinting programs referenced by instructions in surviving glyphs.
    function subset(gids) {
      const keep = new Set([0]), todo = [...gids].filter(g => g >= 0 && g < numGlyphs);
      while (todo.length) { const g = todo.pop(); if (keep.has(g)) continue; keep.add(g); todo.push(...components(g)); }
      let size = 0;
      for (const g of keep) size += (offsets[g + 1] - offsets[g] + 3) & ~3;
      const nglyf = new Uint8Array(size), nloca = new Uint8Array((numGlyphs + 1) * 4);
      let at = 0;
      for (let g = 0; g < numGlyphs; g++) {
        nloca.set([at >>> 24, at >> 16 & 255, at >> 8 & 255, at & 255], g * 4);
        if (keep.has(g)) { const s = glyf + offsets[g], e = glyf + offsets[g + 1]; nglyf.set(b.subarray(s, e), at); at += (e - s + 3) & ~3; }
      }
      nloca.set([at >>> 24, at >> 16 & 255, at >> 8 & 255, at & 255], numGlyphs * 4);
      const pick = tag => { const x = t.get(tag); return x ? b.slice(x.off, x.off + x.len) : null; };
      const nhead = pick("head"); nhead[50] = 0; nhead[51] = 1; nhead.fill(0, 8, 12);
      const out = [["OS/2", pick("OS/2")], ["cmap", pick("cmap")], ["glyf", nglyf], ["head", nhead], ["hhea", pick("hhea")], ["hmtx", pick("hmtx")],
        ["loca", nloca], ["maxp", pick("maxp")], ["name", pick("name")], ["post", pick("post")],
        ...["cvt ", "fpgm", "prep", "gasp"].map(tag => [tag, pick(tag)])].filter(x => x[1]);
      return write(out, nhead);
    }
    return {name, unitsPerEm, numGlyphs, bbox, ascent, descent, capHeight, italicAngle: 0, flags: 32, bytes: b, cmap,
      gid: cp => cmap.get(cp) || 0, advance: g => widths[g] || 0, subset,
      cellHeight:os2!=null ? u16(b,os2+74)+u16(b,os2+76) : i16(b,hhea+4)-i16(b,hhea+6),
      contours:g=>glyphContours(b,offsets,glyf,g)};
  }
  function checksum(d) {
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s = s + ((d[i] << 24 >>> 0) + ((d[i + 1] || 0) << 16) + ((d[i + 2] || 0) << 8) + (d[i + 3] || 0)) >>> 0;
    return s;
  }
  function write(list, head) {
    const n = list.length, dir = 12 + n * 16;
    let size = dir;
    for (const [, d] of list) size += (d.length + 3) & ~3;
    const out = new Uint8Array(size), put32 = (p, v) => { out[p] = v >>> 24; out[p + 1] = v >> 16 & 255; out[p + 2] = v >> 8 & 255; out[p + 3] = v & 255; };
    const put16 = (p, v) => { out[p] = v >> 8 & 255; out[p + 1] = v & 255; };
    let pow = 1, log = 0; while (pow * 2 <= n) { pow *= 2; log++; }
    put32(0, 0x00010000); put16(4, n); put16(6, pow * 16); put16(8, log); put16(10, n * 16 - pow * 16);
    let at = dir, headAt = 0;
    list.forEach(([tag, d], i) => {
      const p = 12 + i * 16;
      for (let k = 0; k < 4; k++) out[p + k] = tag.charCodeAt(k);
      put32(p + 4, checksum(d)); put32(p + 8, at); put32(p + 12, d.length);
      if (d === head) headAt = at;
      out.set(d, at); at += (d.length + 3) & ~3;
    });
    put32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
    return out;
  }

  // ------------------------------------------------------------ the vendored font
  let cached;
  function font() {
    if (typeof globalThis.AtriumFontDejaVuSans !== "string") return null;
    if (cached !== undefined) return cached;
    try { cached = parse(decode(globalThis.AtriumFontDejaVuSans)); }
    catch (e) { cached = null; globalThis.console?.error?.(e); }
    return cached;
  }
  // Notebook fonts are registered as sources. A plain sheet never decodes their bytes.
  const typefaces = new Map(), families = new Map();
  const familyName = name => String(name).trim().replace(/^["']|["']$/g,"").toLowerCase();
  const fontWeight = value => value === "bold" ? 700 : Math.max(100,Math.min(900,Number(value) || 400));
  function registerTypeface(family, getBytes, {weight=400,style="normal"}={}) {
    const name=familyName(family);
    if (!name || name.length>120 || typeof getBytes!=="function") fail("A typeface needs a family and a TrueType source.");
    weight=fontWeight(weight); style=style==="italic" || style==="oblique" ? "italic" : "normal";
    const key="face/"+name+"/"+weight+"/"+style;
    if (typefaces.has(key)) return key;
    let parsed;
    const face={key,weight,style,font:()=>parsed ||= parse(getBytes())};
    typefaces.set(key,face);
    if (!families.has(name)) families.set(name,[]);
    families.get(name).push(face);
    return key;
  }
  function matchTypeface(family, weight, style) {
    const faces=families.get(familyName(family));
    if (!faces) return null;
    const score=f=>Math.abs(weight-f.weight)+(style===f.style ? 0 : 1000);
    return faces.reduce((best,f)=>score(f)<score(best) ? f : best);
  }
  function svgTypeface(face, gids, alias) {
    const bytes=face.font().subset([...gids].sort((a,b)=>a-b));
    const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const data=[];
    for (let i=0;i<bytes.length;i+=3) {
      const a=bytes[i], b=bytes[i+1], c=bytes[i+2];
      data.push(alphabet[a>>2]+alphabet[(a&3)<<4 | b>>4]+(b==null ? "=" : alphabet[(b&15)<<2 | c>>6])+(c==null ? "=" : alphabet[c&63]));
    }
    return '@font-face{font-family:'+alias+';src:url(data:font/ttf;base64,'+data.join("")+') format("truetype")}';
  }

  function install() {
    const f = font();
    if (f && globalThis.AtriumPDF?.useFont) AtriumPDF.useFont(f);
    return !!f;
  }
  install();
  return Object.freeze({decode, parse, font, install, registerTypeface, matchTypeface, typeface:key=>typefaces.get(key), svgTypeface});
})();
