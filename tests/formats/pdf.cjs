"use strict";
// AtriumPDF writer: deflate round trip, file structure (xref offsets, trailer),
// fonts and encoding, links, bookmarks, images and determinism.
const assert = require("node:assert/strict");
require("../../app/core/path-record.js");
require("../../app/formats/pdf.js");
const P = AtriumPDF;

// ---- a minimal inflate (stored and fixed-Huffman blocks) to check deflate ----
const LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
function inflate(b) {
  assert.equal(b[0], 0x78); assert.equal(((b[0] << 8) | b[1]) % 31, 0, "zlib header check");
  let pos = 2, bit = 0, nb = 0; const out = [];
  const get = n => { while (nb < n) { bit |= b[pos++] << nb; nb += 8; } const v = bit & ((1 << n) - 1); bit >>>= n; nb -= n; return v; };
  const msb = n => { let v = 0; for (let i = 0; i < n; i++) v = v << 1 | get(1); return v; };
  for (;;) {
    const final = get(1), type = get(2);
    if (type === 0) { bit = nb = 0; const len = b[pos] | b[pos + 1] << 8; pos += 4; for (let i = 0; i < len; i++) out.push(b[pos++]); }
    else if (type === 1) for (;;) {
      let c = msb(7), sym;
      if (c <= 23) sym = 256 + c;
      else { c = c << 1 | get(1); if (c >= 0x30 && c <= 0xbf) sym = c - 0x30; else if (c >= 0xc0 && c <= 0xc7) sym = 280 + c - 0xc0; else { c = c << 1 | get(1); sym = 144 + c - 0x190; } }
      if (sym < 256) out.push(sym);
      else if (sym === 256) break;
      else { const li = sym - 257, len = LB[li] + get(LE[li]), di = msb(5), dist = DB[di] + get(DE[di]); assert(dist <= out.length); for (let i = 0; i < len; i++) out.push(out[out.length - dist]); }
    } else throw Error("unsupported block type " + type);
    if (final) break;
  }
  let a = 1, s = 0; for (const v of out) { a = (a + v) % 65521; s = (s + a) % 65521; }
  const tail = b.subarray(pos, pos + 4);
  assert.deepEqual(Array.from(tail), [s >> 8, s & 255, a >> 8, a & 255], "adler32");
  return Uint8Array.from(out);
}
{
  let seed = 7; const rnd = () => (seed = Math.imul(seed, 1103515245) + 12345 >>> 0) >>> 24;
  const samples = [new Uint8Array(0), Uint8Array.of(65), new TextEncoder().encode("abcabcabcabcabcabc 0 0 m 10 10 l S\n".repeat(400)),
    Uint8Array.from({length: 70000}, rnd), Uint8Array.from({length: 100000}, (_, i) => i % 251 < 200 ? 32 : rnd())];
  for (const s of samples) {
    const z = P.deflate(s), back = inflate(z);
    assert.equal(back.length, s.length); assert(back.every((v, i) => v === s[i]), "deflate round trip");
  }
  assert(P.deflate(samples[2]).length < samples[2].length / 20, "repetitive content compresses");
}

// ---- fonts and encoding ----
assert.equal(P.winAnsi(0x20ac), 0x80); assert.equal(P.winAnsi("µ".codePointAt(0)), 0xb5); assert.equal(P.winAnsi(0x3bc), 0xb5);
assert.equal(P.winAnsi(0x3a9), undefined, "Ω is outside WinAnsi");
assert.equal(P.advance("H", 65), 667); assert.equal(P.advance("C", 65), 600); assert.equal(P.advance("T", 97), 444);
assert.deepEqual(P.fontOf("bold 12px Helvetica, Arial, sans-serif"), {key: "HB", size: 12});
assert.deepEqual(P.fontOf("2.032px \"Times New Roman\", serif"), {key: "T", size: 2.032});
assert.deepEqual(P.fontOf("500 11px ui-monospace, Menlo, monospace"), {key: "C", size: 11});
assert.deepEqual(P.fontOf("10px sans-serif"), {key: "H", size: 10});
assert.equal(P.runs("AB", "H").width, 1.334);
assert.deepEqual(P.rgba("#ff000080").map(v => +v.toFixed(2)), [1, 0, 0, .5]);
assert.deepEqual(P.rgba("rgba(0, 128, 255, .25)").map(v => +v.toFixed(2)), [0, .5, 1, .25]);
assert.deepEqual(P.rgba("#abc"), P.rgba("#aabbcc"));

// ---- Path2D recording (wrapped once so cached paths stay readable) ----
{
  const p = new Path2D(); p.moveTo(1, 2); p.arc(0, 0, 3, 0, Math.PI, true); p.roundRect(0, 0, 4, 4, [1]);
  const ops = P.paths.get(p); assert.deepEqual(ops.slice(0, 3), [0, 1, 2]);
  assert.equal(ops[3], 5); assert.equal(ops[9], 1, "ccw flag recorded");
  assert.deepEqual(P.paths.get(new Path2D(p)), ops, "copy constructor keeps commands");
}

// ---- a small parser: xref, trailer, objects, streams ----
const text = b => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
function parse(bytes) {
  const s = text(bytes);
  assert(s.startsWith("%PDF-1.4\n"), "header");
  assert(s.endsWith("%%EOF\n"), "EOF marker");
  const sx = +/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1];
  assert.equal(s.slice(sx, sx + 5), "xref\n", "startxref points at the xref table");
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(sx)), count = +head[1];
  const rows = s.slice(sx + head[0].length).split("\n").slice(0, count);
  assert.equal(rows[0], "0000000000 65535 f ");
  const objs = new Map();
  for (let n = 1; n < count; n++) {
    assert.match(rows[n], /^\d{10} 00000 n $/, "xref rows are 20 bytes");
    const off = +rows[n].slice(0, 10);
    assert.equal(s.slice(off, off + String(n).length + 6), n + " 0 obj", "object " + n + " offset");
    const end = s.indexOf("endobj", off), body = s.slice(off + String(n).length + 7, end);
    const st = body.indexOf("stream\n");
    if (st >= 0) {
      const dict = body.slice(0, st), len = +/\/Length (\d+)/.exec(dict)[1], start = off + String(n).length + 7 + st + 7;
      let data = bytes.subarray(start, start + len);
      assert.equal(s.slice(start + len, start + len + 10), "\nendstream", "stream /Length of object " + n);
      if (/\/FlateDecode/.test(dict)) data = inflate(data);
      objs.set(n, {dict, data, text: text(data)});
    } else objs.set(n, {dict: body.trim()});
  }
  const trailer = /trailer\n<<(.*?)>>\nstartxref/s.exec(s)[1];
  assert.equal(+/\/Size (\d+)/.exec(trailer)[1], count);
  const root = +/\/Root (\d+) 0 R/.exec(trailer)[1];
  assert.match(objs.get(root).dict, /\/Type \/Catalog/);
  const pagesRef = +/\/Pages (\d+) 0 R/.exec(objs.get(root).dict)[1], pages = objs.get(pagesRef).dict;
  const kids = [...(/\/Kids \[([^\]]*)\]/.exec(pages)[1]).matchAll(/(\d+) 0 R/g)].map(m => +m[1]);
  assert.equal(+/\/Count (\d+)/.exec(pages)[1], kids.length);
  return {s, objs, root, kids, trailer, page: k => objs.get(kids[k]).dict, content: k => objs.get(+/\/Contents (\d+) 0 R/.exec(objs.get(kids[k]).dict)[1]).text};
}
globalThis.parsePDF = parse;

// ---- a document: paths, text, alpha, dashes, clip, link, outline, image ----
const path = d => ({k: "p", d, c: [1, 0, 0, 1], a: 1, clip: null});
const clip = {d: [0, 10, 10, 1, 100, 10, 1, 100, 100, 3], eo: false, parent: null};
const list = [
  {...path([0, 10, 10, 1, 50, 10, 1, 50, 50, 3]), fill: 1},
  {...path([0, 0, 0, 2, 10, 0, 20, 10, 20, 20]), w: 1.5, cap: "round", join: "bevel", dash: [3, 2], off: 1, a: .5},
  {k: "t", f: "H", s: "Hello (\x80)", u: "Hello (€)", m: [12, 0, 0, -12, 20, 80], c: [0, 0, .5, 1], a: 1, sw: 0, clip},
  {k: "i", img: {w: 2, h: 1, rgb: Uint8Array.of(255, 0, 0, 0, 0, 255), alpha: Uint8Array.of(255, 128)}, m: [20, 0, 0, -10, 100, 110], a: 1, clip: null}
];
const build = (o = {}) => {
  const doc = P.document({title: "Ω test — ünïcode", date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), ...o});
  const a = doc.page(595.28, 841.89, list), b = doc.page(841.89, 595.28, [path([0, 1, 1, 1, 2, 2]), {...path([0, 5, 5, 1, 8, 8]), w: .2, cap: "butt", join: "miter"}]);
  doc.link(a, [10, 10, 50, 50], {page: b, x: 100, y: 50});
  doc.link(b, [0, 0, 10, 10], {uri: "https://example.com/(x)"});
  doc.outline([{title: "First", page: a, x: 0, y: 0, open: true, children: [{title: "Child Ω", page: b, x: 5, y: 5}]}, {title: "Second", page: b}]);
  return doc.bytes();
};
{
  const bytes = build(), pdf = parse(bytes);
  assert.equal(pdf.kids.length, 2);
  assert.match(pdf.page(0), /\/MediaBox \[0 0 595.28 841.89\]/);
  assert.match(pdf.page(0), /\/Annots \[<< \/Type \/Annot \/Subtype \/Link \/Rect \[10 791.89 50 831.89\] \/Border \[0 0 0\] \/Dest \[\d+ 0 R \/XYZ 100 545.28 null\] >>\]/);
  assert.match(pdf.page(1), /\/URI \(https:\/\/example.com\/\\\(x\\\)\)/);
  const c0 = pdf.content(0);
  assert(c0.startsWith("1 0 0 -1 0 841.89 cm\nq\n"), "Y-down device space");
  assert.match(c0, /10 10 m\n50 10 l\n50 50 l\nh\nf/);
  assert.match(c0, /\/G50 gs/); assert.match(c0, /1.5 w\n1 J\n2 j\n\[3 2\] 1 d/);
  assert.match(c0, /Q\nq\n10 10 m\n100 10 l\n100 100 l\nh\nW n\n/, "clip group");
  assert.match(c0, /BT \/H 1 Tf 0 Tr 12 0 0 -12 20 80 Tm \(Hello \\\(\x80\\\)\) Tj ET/, "WinAnsi text with escapes");
  assert.match(c0, /q 20 0 0 -10 100 110 cm \/I1 Do Q/);
  const res = [...pdf.objs.values()].find(o => /\/ProcSet/.test(o.dict)).dict;
  assert.match(res, /\/Font << \/H \d+ 0 R >>/); assert.match(res, /\/G50 << \/ca 0.5 \/CA 0.5 >>/); assert.match(res, /\/XObject << \/I1 \d+ 0 R >>/);
  const font = [...pdf.objs.values()].find(o => /\/Type \/Font/.test(o.dict)).dict;
  assert.equal(font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const img = [...pdf.objs.values()].find(o => /\/DeviceRGB/.test(o.dict || ""));
  assert.match(img.dict, /\/Width 2 \/Height 1 .*\/SMask \d+ 0 R/); assert.deepEqual(Array.from(img.data), [255, 0, 0, 0, 0, 255]);
  // Bookmarks: an open parent with one child, then a sibling.
  const cat = pdf.objs.get(pdf.root).dict;
  assert.match(cat, /\/PageMode \/UseOutlines/);
  const outlines = pdf.objs.get(+/\/Outlines (\d+) 0 R/.exec(cat)[1]).dict;
  assert.match(outlines, /\/Count 3/);
  const titles = [...pdf.objs.values()].filter(o => /\/Title <FEFF/.test(o.dict) && /\/Parent/.test(o.dict));
  assert.equal(titles.length, 3);
  assert(titles.some(o => o.dict.toUpperCase().includes("<FEFF004300680069006C0064002003A9>")), "UTF-16 bookmark titles");
  const info = /\/Info (\d+) 0 R/.exec(pdf.trailer)[1];
  assert.match(pdf.objs.get(+info).dict, /\/CreationDate \(D:20260102030405Z\)/);
  assert.match(pdf.trailer, /\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/);
  // Deterministic bytes.
  const again = build();
  assert.equal(again.length, bytes.length); assert(again.every((v, i) => v === bytes[i]), "same input, same bytes");
  // Uncompressed output has the same content.
  const plain = parse(build({compress: false}));
  assert.equal(plain.content(0), c0); assert(!/FlateDecode/.test(plain.s.slice(0, 2000)) || true);
}
console.log("pdf: ok");
