"use strict";
// Gerber X2 attributes in fab-outputs.js: object attributes (.N/.P/.C) read back
// by an independent mini-parser, aperture and file attributes, FileFunction from
// AtriumStackup.layerInfo (stored, derived and rigid-flex stacks), escaping,
// determinism, panels (TF.Part,Array) and every output through gerber-check
// with X2 validation. Also the Unicode stroke glyphs on silk and allowed layers.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const mem = new Map(); globalThis.localStorage ??= {getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k)};
for (const m of ["model", "parts", "altium-rules", "rules", "connectivity", "drc", "messages", "erc", "spatial", "stackup", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text",
  "viastack", "board-shape", "rigid-flex", "polygon-pour", "bom", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "step-export", "kicad-export", "kicad-schematic", "ipc2581", "panel", "output-jobs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const {check} = require("./gerber-check.cjs");
const A = Atrium, F = AtriumFabOutputs, S = AtriumStackup, date = new Date(2026, 10, 18, 10, 30, 0);
const file = (out, suffix) => out.files.find(f => f.name.endsWith(suffix))?.content;
const plotted = out => out.files.filter(f => f.kind === "gerber" || f.kind === "drillmap");
const allPass = (out, label) => { for (const f of plotted(out)) assert.deepEqual(check(f.content, {x2: true}).issues, [], label + " " + f.name); };

// ---- Independent mini-parser ---------------------------------------------------
// Reads FS, AD, D-code selection, TO/TD and D01/D03 words; returns every flash
// and draw with the object attribute dictionary current when it was made.
function unescape(s) { return s.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (_, a, b) => String.fromCodePoint(parseInt(a || b, 16))); }
function readObjects(text) {
  const out = {flashes: [], draws: [], file: {}}, dict = {}, apertures = new Map();
  let dec = 6, cur = null, pos = [0, 0], i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || c === " ") { i++; continue; }
    if (c === "%") {
      const end = text.indexOf("%", i + 1), body = text.slice(i + 1, end).replace(/\n/g, ""); i = end + 1;
      let m;
      if ((m = /^FSLAX\d(\d)Y\d\d\*$/.exec(body))) dec = +m[1];
      else if ((m = /^ADD(\d+)([^,*]+)/.exec(body))) apertures.set(+m[1], m[2]);
      else if ((m = /^TO(\.\w+),(.*)\*$/.exec(body))) dict[m[1]] = m[2].split(",").map(unescape);
      else if ((m = /^TD(\.\w+)?\*$/.exec(body))) { if (m[1]) delete dict[m[1]]; else for (const k of Object.keys(dict)) delete dict[k]; }
      else if ((m = /^TF(\.\w+),(.*)\*$/.exec(body))) out.file[m[1]] = m[2];
      continue;
    }
    const end = text.indexOf("*", i), w = text.slice(i, end); i = end + 1;
    let m = /^D(\d+)$/.exec(w);
    if (m && +m[1] >= 10) { cur = +m[1]; continue; }
    m = /^(?:G0[123])?X(-?\d+)Y(-?\d+)(?:I-?\d+J-?\d+)?D0([123])$/.exec(w);
    if (!m) continue;
    const p = [+m[1] / 10 ** dec, +m[2] / 10 ** dec], o = {at: p, from: pos, aperture: apertures.get(cur), attrs: JSON.parse(JSON.stringify(dict))};
    if (m[3] === "3") out.flashes.push(o); else if (m[3] === "1") out.draws.push(o);
    pos = p;
  }
  return out;
}

// ---- Sample board: a known pad's net from %TO.N --------------------------------
{
  const project = AtriumParts.example(), doc = project.documents[1], defs = new Map(project.library.map(d => [d.id, d]));
  const out = F.build(project, doc, {date});
  allPass(out, "sample");
  assert.equal(F.build(project, doc.id, {date}).files.map(f => f.content).join("\u0000"), out.files.map(f => f.content).join("\u0000"), "deterministic for a fixed job date");
  const o = F.settle({date}), [ox, oy] = F.originFor(out.model, o);
  const gtl = readObjects(file(out, ".GTL"));
  assert.equal(gtl.file[".FileFunction"], "Copper,L1,Top");
  assert.equal(gtl.file[".CreationDate"], F.isoDate(date), "creation date is the job date");
  assert.equal(gtl.file[".Part"], "Single");
  // Every component pad on the top: its flash carries .N (the board's pin net), .P and .C.
  let checked = 0;
  for (const part of doc.items.filter(i => i.kind === "part")) {
    for (const pad of defs.get(part.def).footprint.pads) {
      const at = A.world([pad.x, pad.y], part), x = at[0] - ox, y = oy - at[1];
      const hit = gtl.flashes.find(f => Math.abs(f.at[0] - x) < 1e-6 && Math.abs(f.at[1] - y) < 1e-6 && f.attrs[".P"]?.[0] === part.ref);
      assert.ok(hit, part.ref + "-" + pad.number + " flashed");
      const net = part.pinNets?.[pad.number] ?? pad.net ?? "";
      assert.deepEqual(hit.attrs[".N"], [net || "N/C"], part.ref + "-" + pad.number + " net");
      assert.equal(hit.attrs[".P"][1], String(pad.number));
      assert.deepEqual(hit.attrs[".C"], [part.ref]);
      checked++;
    }
  }
  assert.ok(checked >= 15, "pads checked: " + checked);
  // The pin function is the schematic pin name: U1 pin 2 is "V−" (escaped −).
  const u1 = doc.items.find(i => i.ref === "U1");
  if (u1) assert.match(file(out, ".GTL"), /^%TO\.P,U1,2,V\\u2212\*%$/m);
  // Vias carry their net only; tracks are drawn with their net.
  for (const v of doc.items.filter(i => i.kind === "via")) {
    const hit = gtl.flashes.find(f => Math.abs(f.at[0] - (v.x - ox)) < 1e-6 && Math.abs(f.at[1] - (oy - v.y)) < 1e-6);
    assert.ok(hit && hit.attrs[".P"] === undefined && hit.attrs[".C"] === undefined, "via " + v.id);
    assert.deepEqual(hit.attrs[".N"], [v.net || ""]);
  }
  const track = doc.items.find(i => i.kind === "track" && i.layer === "Top" && i.net);
  assert.ok(gtl.draws.some(d => d.attrs[".N"]?.[0] === track.net), "tracks carry .N");
  // Non-copper layers have no object attributes; the attribute dictionary is empty at M02.
  for (const ext of [".GTO", ".GTS", ".GTP", ".GM1", ".GD1"]) assert.doesNotMatch(file(out, ext), /%TO\./, ext);
  assert.match(file(out, ".GTL"), /%TD\.N\*%\n(%TD\.[PC]\*%\n)*%TD\.AperFunction\*%|%TD\.[NPC]\*%\nM02/);
  // Aperture functions.
  for (const fn of ["SMDPad,CuDef", "ComponentPad", "ViaPad", "Conductor"]) assert.match(file(out, ".GTL"), new RegExp("^%TA\\.AperFunction," + fn + "\\*%$", "m"));
  assert.match(file(out, ".GM1"), /^%TA\.AperFunction,Profile\*%$/m);
  assert.equal(readObjects(file(out, ".GTS")).file[".FilePolarity"], "Negative");
  assert.deepEqual(["GTO", "GTS", "GBS", "GTP", "GD1"].map(e => readObjects(file(out, "." + e)).file[".FileFunction"]), ["Legend,Top", "Soldermask,Top", "Soldermask,Bot", "Paste,Top", "Drillmap"]);
}

// ---- Escaping: nets and designators with reserved and non-ASCII characters --------
{
  assert.equal(F.x2Field("A,B*C%D\\E"), "A\\u002CB\\u002AC\\u0025D\\u005CE");
  assert.equal(F.x2Field("µ±Ω😀\u0001"), "\\u00B5\\u00B1\\u03A9\\U0001F600");
  const p = A.project("Esc", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.name = "Esc"; pcb.outline = [[0, 0], [20, 0], [20, 10], [0, 10]];
  pcb.items.push({id: "t", kind: "track", layer: "Top", net: "V+,5V*µ", width: .25, points: [[2, 2], [10, 2]]},
    {id: "p", kind: "pad", number: "1", x: 12, y: 5, w: 1, h: 1, drill: 0, shape: "rect", layer: "Top", net: ""});
  const out = F.build(p, pcb, {date});
  allPass(out, "escaped");
  const g = readObjects(file(out, ".GTL"));
  assert.ok(g.draws.some(d => d.attrs[".N"]?.[0] === "V+,5V*µ"), "escaped net round-trips");
  const free = g.flashes.find(f => Math.abs(f.at[0] - 12) < 1e-6);
  assert.deepEqual(free.attrs[".N"], ["N/C"], "a free pad without a net is N/C");
  assert.equal(free.attrs[".P"], undefined, "a free pad has no designator");
}

// ---- FileFunction from the layer stack: stored 6-layer, derived, rigid-flex -------
{
  const p = A.project("Six", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.name = "Six"; pcb.outline = [[0, 0], [30, 0], [30, 20], [0, 20]];
  pcb.stackup = {version: 1, layers: S.preset("6").layers};
  pcb.items.push({id: "v", kind: "via", x: 5, y: 5, diameter: .6, drill: .3, layer: "Multi", net: "GND"});
  const out = F.build(p, pcb, {date}), defs = new Map(p.library.map(d => [d.id, d]));
  allPass(out, "6-layer");
  const keys = S.copperLayers(pcb, defs), exts = {Top: "GTL", Bottom: "GBL"};
  keys.forEach((k, i) => {
    const ext = exts[k] || "G" + AtriumPCBAppearance.index(k), info = S.layerInfo(pcb, k, defs);
    assert.equal(readObjects(file(out, "." + ext)).file[".FileFunction"], info.fileFunction, k);
    assert.equal(info.number, i + 1);
  });
  // The via flashes on every copper layer with its net.
  for (const k of keys) assert.ok(readObjects(file(out, "." + (exts[k] || "G" + AtriumPCBAppearance.index(k)))).flashes.some(f => f.attrs[".N"]?.[0] === "GND"), k);
}
{
  const RF = AtriumRigidFlex, p = A.project("Flex", []), doc = p.documents.find(d => d.kind === "pcb");
  doc.name = "Flex"; doc.outline = [[0, 0], [60, 0], [60, 20], [0, 20]];
  const st = S.preset(4); delete st.derived;
  const cu = st.layers.filter(S.isCopper);
  st.substacks = [{id: "flex", name: "Flex 2L", flex: true, layers: S.flexLayers(["Top", "Bottom"], cu)}];
  doc.stackup = JSON.parse(JSON.stringify(st));
  S.splitRegion(doc, {a: [30, 0], b: [30, 20]});
  S.assignStack(doc, RF.regions(doc).find(g => RF.geometry.inside([45, 10], g.points)).id, "flex");
  doc.items.push({id: "t", kind: "track", layer: "Bottom", net: "S", width: .2, points: [[35, 5], [55, 5]]},
    {id: "v", kind: "via", x: 10, y: 10, diameter: .6, drill: .3, layer: "Multi", net: "S"});
  const out = F.build(p, doc, {date});
  allPass(out, "rigid-flex");
  // The flex substack shares master copper: Bottom stays L4 of the four-layer master stack.
  assert.equal(readObjects(file(out, ".GBL")).file[".FileFunction"], "Copper,L4,Bot,Signal");
  assert.equal(readObjects(file(out, ".G1")).file[".FileFunction"], "Copper,L2,Inr,Plane");
  assert.equal(readObjects(file(out, ".GCT")).file[".FileFunction"], "Other,CoverlayTop");
}

// ---- Panels: TF.Part,Array, no object attributes, every Gerber passes ------------
{
  const P = AtriumPanel, p = AtriumParts.example(), b = p.documents.find(d => d.kind === "pcb"), d = P.create(p, {board: b.id, rows: 2, cols: 2});
  p.documents.push(d);
  const out = P.build(p, d, {date});
  allPass(out, "panel");
  for (const f of plotted(out)) {
    assert.match(f.content, /^%TF\.Part,Array\*%$/m, f.name);
    assert.doesNotMatch(f.content, /%TO\./, f.name);
  }
  assert.ok(out.files.some(f => f.kind === "drillmap") && out.files.some(f => f.kind === "drillreport"));
}

// ---- Unicode stroke glyphs on silk -----------------------------------------------
{
  const T = AtriumPCBText, text = "10kΩ ±1% 25°C 4µ7 m² m³ Ñandú Łódź Straße Œuvre ȘȚșț Ærø ő ű ā ğ ż İı ĳ Þð";
  for (const ch of text) assert.ok(ch === " " || T.supported(ch), "stroke glyph " + ch + " U+" + ch.codePointAt(0).toString(16));
  for (let c = 0xc0; c <= 0x17f; c++) if (c !== 0xd7 && c !== 0xf7) assert.ok(T.supported(String.fromCharCode(c)), "Latin U+" + c.toString(16));
  // Glyphs stay inside the cell (x -1..5, y -2..7.5) and composed marks sit above caps.
  for (const ch of "ŁĦŊŒßÆÐĂŐȘ") for (const line of T.glyph(ch)) for (const [x, y] of line) assert.ok(x >= -1 && x <= 5 && y >= -2 && y <= 7.5, ch);
  assert.ok(Math.max(...T.glyph("Ā").flat().map(q => q[1])) > 6.5, "macron above the cap height");
  assert.ok(Math.min(...T.glyph("ș").flat().map(q => q[1])) < -.5, "comma below the baseline");
  const p = A.project("Uni", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.name = "Uni"; pcb.outline = [[0, 0], [120, 0], [120, 20], [0, 20]];
  pcb.items.push({id: "l", kind: "label", text, x: 2, y: 10, size: 2, layer: "Silk"});
  const out = F.build(p, pcb, {date});
  allPass(out, "unicode");
  assert.ok(!out.warnings.some(w => /stroke font|printable ASCII/.test(w)), out.warnings.join("; "));
  assert.ok(readObjects(file(out, ".GTO")).draws.length > 150);
  // The PDF writer draws characters outside WinAnsi with the same glyphs.
  assert.ok(globalThis.AtriumPCBText.glyph("Ω").length > 0);
}

// ---- Allowed layers: objects on copper the stack lacks are flagged or refused -----
{
  const p = A.project("Lost", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.name = "Lost"; pcb.outline = [[0, 0], [20, 0], [20, 10], [0, 10]];
  pcb.stackup = {version: 1, layers: S.preset("4").layers};
  pcb.items.push({id: "t", kind: "track", layer: "Inner 5", net: "X", width: .2, points: [[1, 1], [5, 1]]});
  const issues = F.layerCheck(p, pcb);
  assert.deepEqual(issues, [{kind: "layer", layer: "Inner 5", count: 1, action: "omitted"}]);
  const out = F.build(p, pcb, {date});
  assert.ok(out.warnings.some(w => /missing from the layer stack \(Inner 5\)/.test(w)));
  assert.ok(!out.files.some(f => /\.G5$/.test(f.name)), "no file for a layer the stack lacks");
  assert.throws(() => F.build(p, pcb, {date, strictLayers: true}), /layer stack does not allow 1 object on/);
  pcb.items.pop();
  assert.deepEqual(F.layerCheck(p, pcb), []);
}
console.log("fab-x2: ok");
