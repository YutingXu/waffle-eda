"use strict";
// Structural RS-274X / X2 checker (Gerber spec 2026.05), used by the fab
// output tests. When run directly it checks every Gerber of the sample board
// and of a 4-layer board with knockout text, pours and via stacks.
//
// check(text, {legacy}) -> {issues, fs, mo, regions, cutIns}
//  - format: FS present before coordinates, 6 decimal digits (unless
//    legacy), MO, every D code and macro defined before use, G75 before arcs
//  - regions: no D03, LP or other non-attribute commands inside G36/G37,
//    every contour closed with at least three edges
//  - contours (§4.10.3): no proper self-crossings, no vertex on another
//    segment's interior, no partially overlapping segments; cut-ins (two
//    fully coincident segments) are horizontal or vertical, all in the same
//    direction within a contour, and no point ends more than one cut-in
// X2 attribute syntax (Ucamco Gerber Layer Format Specification revision
// 2024.05, §5): names, field counts, escapes, standard values and placement.
// Standard (dotted) names must be known; user names are free. File
// attributes must precede the first object. With {x2: true} the file must
// also carry .FileFunction, .FilePolarity, .GenerationSoftware and
// .CreationDate.
const X2_FILE_FUNCTION = new RegExp("^(?:" + [
  "Copper,L\\d+,(?:Top|Inr|Bot)(?:,(?:Plane|Signal|Mixed|Hatched))?",
  "Plated,\\d+,\\d+,(?:PTH|Blind|Buried)(?:,(?:Drill|Rout|Mixed))?",
  "NonPlated,\\d+,\\d+,(?:NPTH|Blind|Buried)(?:,(?:Drill|Rout|Mixed))?",
  "Profile,(?:P|NP)", "(?:Soldermask|Legend)(?:,(?:Top|Bot))(?:,\\d+)?", "(?:Paste|Glue|Pads|Keep-out|Depthrout),(?:Top|Bot)",
  "(?:Carbonmask|Goldmask|Heatsinkmask|Peelablemask|Silvermask|Tinmask),(?:Top|Bot)(?:,\\d+)?",
  "Component,L\\d+,(?:Top|Bot)", "Viafill", "Vcut(?:,(?:Top|Bot))?", "Drillmap", "FabricationDrawing", "Vcutmap",
  "AssemblyDrawing,(?:Top|Bot)", "ArrayDrawing", "OtherDrawing,[^,]+", "Other,[^,]+"].join("|") + ")$");
const X2_APER_FUNCTION = new RegExp("^(?:" + [
  "ViaDrill(?:,(?:Ia|Ib|IIa|IIb|IIIa|IIIb|IVa|IVb|V|VI|VII|None))?", "BackDrill", "ComponentDrill(?:,PressFit)?",
  "MechanicalDrill(?:,(?:Tooling|BreakOut|Other))?", "CastellatedDrill", "OtherDrill,[^,]+",
  "ComponentPad", "(?:SMDPad|BGAPad),(?:CuDef|SMDef)", "ConnectorPad", "HeatsinkPad", "ViaPad", "TestPad", "CastellatedPad",
  "FiducialPad,(?:Local|Global|Panel)", "ThermalReliefPad", "WasherPad", "AntiPad", "OtherPad,[^,]+",
  "Conductor", "EtchedComponent", "NonConductor", "CopperBalancing", "Border", "OtherCopper,[^,]+",
  "ComponentMain", "ComponentOutline,(?:Body|Lead2Lead|Footprint|Courtyard)", "ComponentPin",
  "Profile", "NonMaterial", "Material", "Other,[^,]+"].join("|") + ")$");
const X2_NAMES = {
  F: {".Part": [1, 2], ".FileFunction": [1, 6], ".FilePolarity": [1, 1], ".SameCoordinates": [0, 1], ".CreationDate": [1, 1],
    ".GenerationSoftware": [2, 3], ".ProjectId": [3, 3], ".MD5": [1, 1]},
  A: {".AperFunction": [1, 3], ".DrillTolerance": [2, 2], ".FlashText": [2, 5]},
  O: {".N": [1, Infinity], ".P": [2, 3], ".C": [1, 1], ".CRot": [1, 1], ".CMfr": [1, 1], ".CMPN": [1, 1], ".CVal": [1, 1], ".CMnt": [1, 1],
    ".CFtp": [1, 1], ".CPgN": [1, 1], ".CPgD": [1, 1], ".CHgt": [1, 1], ".CLbN": [1, 1], ".CLbD": [1, 1], ".CSup": [2, Infinity]}};
function x2Command(body, warn, st) {
  if (!/^T[FAOD]/.test(body)) return false;
  if (!body.endsWith("*") || body.indexOf("*") !== body.length - 1) { warn("X2 attribute not closed by a single *: " + body.slice(0, 30)); return true; }
  const kind = body[1], text = body.slice(2, -1);
  if (!/^[\x20-\x7e]*$/.test(text)) warn("X2 attribute with characters outside printable ASCII: " + text.slice(0, 30));
  if (/\\(?!u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/.test(text)) warn("X2 attribute with a bad escape: " + text.slice(0, 30));
  if (kind === "D") {
    if (text && !/^\.?[A-Za-z_$][\w.$]*$/.test(text)) warn("bad TD " + body);
    if (text.startsWith(".") && !Object.values(X2_NAMES).some(n => n[text])) warn("TD of an unknown standard attribute " + text);
    if (!text) st.object = {}; else delete st.object[text];
    return true;
  }
  const comma = text.indexOf(","), name = comma < 0 ? text : text.slice(0, comma), fields = comma < 0 ? [] : text.slice(comma + 1).split(",");
  if (!/^\.?[A-Za-z_$][\w.$]*$/.test(name)) { warn("bad X2 attribute name " + name); return true; }
  if (name.startsWith(".")) {
    const range = X2_NAMES[kind][name];
    if (!range) { warn("unknown standard T" + kind + " attribute " + name); return true; }
    if (fields.length < range[0] || fields.length > range[1]) warn("T" + kind + name + " has " + fields.length + " fields");
    const v = fields.join(",");
    if (name === ".FileFunction" && !X2_FILE_FUNCTION.test(v)) warn("bad .FileFunction " + v);
    if (name === ".FilePolarity" && !/^(Positive|Negative)$/.test(v)) warn("bad .FilePolarity " + v);
    if (name === ".Part" && !/^(Single|Array|FabricationPanel|Coupon|Other,[^,]+)$/.test(v)) warn("bad .Part " + v);
    if (name === ".CreationDate" && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?$/.test(v)) warn("bad .CreationDate " + v);
    if (name === ".MD5" && !/^[0-9a-f]{32}$/.test(v)) warn("bad .MD5 " + v);
    if (name === ".AperFunction" && !X2_APER_FUNCTION.test(v)) warn("bad .AperFunction " + v);
    if (name === ".P" && (!fields[0] || !fields[1])) warn("TO.P without a designator and pin");
    if (name === ".C" && !fields[0]) warn("TO.C without a designator");
  }
  if (kind === "F") { if (st.coords) warn("file attribute " + name + " after the first object"); st.file.set(name, fields.join(",")); }
  if (kind === "O") { st.object[name] = fields.join(","); st.objects.push(name); }
  return true;
}
function x2Required(st, warn) {
  for (const n of [".FileFunction", ".FilePolarity", ".GenerationSoftware", ".CreationDate"]) if (!st.file.has(n)) warn("missing TF" + n);
}
function check(text, options = {}) {
  const issues = [], warn = m => { if (issues.length < 50) issues.push(m); };
  if (/NaN|undefined|Infinity/.test(text)) warn("contains NaN, undefined or Infinity");
  if (!/M02\*\n?$/.test(text)) warn("does not end with M02");
  let fs = null, mo = null, g75 = false, interp = "G01", pos = [0, 0], region = false, contour = null, cur = null;
  const apertures = new Set(), macros = new Set(), contours = [], x2 = {file: new Map(), object: {}, objects: [], coords: 0};
  const closeContour = () => {
    if (!contour) return;
    const a = contour[0], b = contour.at(-1);
    if (a[0] !== b[0] || a[1] !== b[1]) warn("unclosed contour at " + a);
    if (contour.length < 4) warn("contour with fewer than three edges at " + a);
    contours.push(contour); contour = null;
  };
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === "%") {
      const end = text.indexOf("%", i + 1);
      if (end < 0) { warn("unterminated extended command"); break; }
      const body = text.slice(i + 1, end).replace(/\n/g, ""); i = end + 1;
      if (region && !/^T[AOD]/.test(body)) warn("extended command inside a region: " + body.slice(0, 20));
      if (body.startsWith("FS")) {
        const m = /^FSLAX([1-6])(\d)Y\1\2\*$/.exec(body);
        if (!m) warn("bad FS " + body); else { fs = [+m[1], +m[2]]; if (fs[1] !== 6 && !options.legacy) warn("FS has " + fs[1] + " decimals; the spec requires 6"); }
      } else if (body.startsWith("MO")) { mo = body.slice(2, 4); if (!["MM", "IN"].includes(mo)) warn("bad MO " + body); }
      else if (body.startsWith("AM")) macros.add(body.slice(2, body.indexOf("*")));
      else if (body.startsWith("AD")) {
        const m = /^ADD(\d+)([A-Za-z_.$][\w.$]*)(?:,([^*]*))?\*$/.exec(body);
        if (!m) warn("bad AD " + body);
        else {
          if (+m[1] < 10) warn("D code below 10");
          if (!["C", "R", "O", "P"].includes(m[2]) && !macros.has(m[2])) warn("macro " + m[2] + " used before definition");
          apertures.add(+m[1]);
        }
      } else if (!x2Command(body, warn, x2) && !/^LP[DC]/.test(body)) warn("unknown extended command " + body.slice(0, 20));
      continue;
    }
    const end = text.indexOf("*", i);
    if (end < 0) { warn("unterminated word"); break; }
    const w = text.slice(i, end); i = end + 1;
    if (/^G04/.test(w)) continue;
    if (w === "G75") { g75 = true; continue; }
    if (/^G0[123]$/.test(w)) { interp = w; continue; }
    if (w === "G36") { if (region) warn("nested G36"); region = true; continue; }
    if (w === "G37") { if (!region) warn("G37 without G36"); closeContour(); region = false; continue; }
    if (w === "M02") break;
    let m = /^D(\d+)$/.exec(w);
    if (m) { if (region) warn("aperture selected inside a region"); if (!apertures.has(+m[1])) warn("D" + m[1] + " used before definition"); cur = +m[1]; continue; }
    m = /^(G0[123])?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0([123])$/.exec(w);
    if (!m) { warn("bad word " + w); continue; }
    if (!fs || !mo) warn("coordinates before FS and MO");
    if (m[6] !== "2") x2.coords++;
    if (m[1]) interp = m[1];
    const p = [m[2] != null ? +m[2] : pos[0], m[3] != null ? +m[3] : pos[1]];
    if (m[6] === "1" && interp !== "G01") {
      if (!g75) warn("arc without G75");
      const c = [pos[0] + (+m[4] || 0), pos[1] + (+m[5] || 0)];
      if (Math.abs(Math.hypot(pos[0] - c[0], pos[1] - c[1]) - Math.hypot(p[0] - c[0], p[1] - c[1])) > 2) warn("arc radius mismatch at " + w);
    }
    if (region) {
      if (m[6] === "3") warn("D03 inside a region");
      else if (m[6] === "2") { closeContour(); contour = [p]; }
      else {
        if (!contour) contour = [pos];
        // Arcs (G75) are flattened onto their circle, so the contour checks below see them.
        if (interp !== "G01") {
          const c = [pos[0] + (+m[4] || 0), pos[1] + (+m[5] || 0)], r = Math.hypot(pos[0] - c[0], pos[1] - c[1]);
          const a0 = Math.atan2(pos[1] - c[1], pos[0] - c[0]);
          let sweep = Math.atan2(p[1] - c[1], p[0] - c[0]) - a0;
          if (interp === "G03") { while (sweep <= 0) sweep += 2 * Math.PI; } else { while (sweep >= 0) sweep -= 2 * Math.PI; }
          const k = Math.min(720, Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 90))));
          for (let s = 1; s < k; s++) { const q = [Math.round(c[0] + r * Math.cos(a0 + sweep * s / k)), Math.round(c[1] + r * Math.sin(a0 + sweep * s / k))]; const z = contour.at(-1); if (q[0] !== z[0] || q[1] !== z[1]) contour.push(q); }
        }
        contour.push(p);
      }
    } else if (cur == null && m[6] !== "2") warn("object without an aperture");
    pos = p;
  }
  if (region) warn("unterminated region");
  if (!fs || !mo) warn("missing FS or MO");
  let cutIns = 0;
  for (const c of contours) cutIns += contourIssues(c, warn);
  if (options.x2) x2Required(x2, warn);
  return {issues, fs, mo, regions: contours.length, cutIns, x2};
}

const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const between = (a, b, p) => Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
function contourIssues(pts, warn) {
  const segs = [];
  for (let k = 0; k + 1 < pts.length; k++) if (!same(pts[k], pts[k + 1])) segs.push([pts[k], pts[k + 1]]);
  const n = segs.length, key = p => p[0] + "," + p[1];
  // Cut-ins: segment pairs a->b, b->a.
  const byKey = new Map(), cut = new Set(), cutEnds = new Map(), dirs = new Set();
  segs.forEach((s, k) => byKey.set(key(s[0]) + ">" + key(s[1]), k));
  let count = 0;
  segs.forEach((s, k) => {
    const r = byKey.get(key(s[1]) + ">" + key(s[0]));
    if (r == null) return;
    cut.add(k);
    if (r < k) return;
    count++;
    const dir = s[0][1] === s[1][1] ? "h" : s[0][0] === s[1][0] ? "v" : "d";
    if (dir === "d") warn("diagonal cut-in " + JSON.stringify(s));
    dirs.add(dir);
    for (const p of s) cutEnds.set(key(p), (cutEnds.get(key(p)) || 0) + 1);
  });
  if (dirs.size > 1) warn("cut-ins in one contour run in different directions");
  for (const [p, c] of cutEnds) if (c > 1) warn("point " + p + " ends " + c + " cut-ins");
  // Points visited more than once must be cut-in ends.
  const visits = new Map();
  for (const s of segs) visits.set(key(s[0]), (visits.get(key(s[0])) || 0) + 1);
  for (const [p, c] of visits) if (c > 1 && !cutEnds.has(p)) warn("contour touches itself at " + p);
  // Crossings, touching and overlaps.
  let bad = 0;
  for (let a = 0; a < n; a++) {
    const [p1, p2] = segs[a];
    const xmin = Math.min(p1[0], p2[0]), xmax = Math.max(p1[0], p2[0]), ymin = Math.min(p1[1], p2[1]), ymax = Math.max(p1[1], p2[1]);
    for (let b = a + 1; b < n; b++) {
      const [p3, p4] = segs[b];
      if (Math.max(p3[0], p4[0]) < xmin || Math.min(p3[0], p4[0]) > xmax || Math.max(p3[1], p4[1]) < ymin || Math.min(p3[1], p4[1]) > ymax) continue;
      if (cut.has(a) && cut.has(b) && same(p1, p4) && same(p2, p3)) continue;
      const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2), d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
      let what = null;
      if (d1 * d2 < 0 && d3 * d4 < 0) what = "self-crossing";
      else if (d1 === 0 && d2 === 0) {
        // Collinear: anything more than a shared endpoint is an overlap.
        const inner = (s, p) => between(s[0], s[1], p) && !same(p, s[0]) && !same(p, s[1]);
        if (inner(segs[a], p3) || inner(segs[a], p4) || inner(segs[b], p1) || inner(segs[b], p2) || (same(p1, p3) && same(p2, p4)) || (same(p1, p4) && same(p2, p3))) what = "overlapping segments";
      } else {
        for (const [p, s, d] of [[p1, segs[b], d1], [p2, segs[b], d2], [p3, segs[a], d3], [p4, segs[a], d4]])
          if (d === 0 && between(s[0], s[1], p) && !same(p, s[0]) && !same(p, s[1])) what = "vertex on another segment";
      }
      if (what && ++bad <= 3) warn(what + ": " + JSON.stringify(segs[a]) + " / " + JSON.stringify(segs[b]));
    }
  }
  if (bad > 3) warn(bad + " contour defects in total");
  return count;
}
module.exports = {check};

if (require.main === module) {
  const assert = require("node:assert/strict");
  if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
  for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "rules", "viastack", "board-shape", "polygon-pour", "bom", "fab-outputs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const A = Atrium, F = AtriumFabOutputs, date = new Date(2026, 10, 18, 10, 30, 0);
  const all = (result, label) => {
    let n = 0;
    for (const f of result.files.filter(f => f.kind === "gerber" || f.kind === "drillmap")) {
      const r = check(f.content, {x2: true});
      assert.deepEqual(r.issues, [], label + " " + f.name);
      n += r.cutIns;
    }
    return n;
  };
  // Self-test: the checker catches the defects it is meant to catch.
  const head = "%FSLAX46Y46*%\n%MOMM*%\nG75*\nG01*\n";
  const region = pts => head + "G36*\n" + pts.map((p, i) => "X" + p[0] + "Y" + p[1] + (i ? "D01*" : "D02*")).join("\n") + "\nG37*\nM02*\n";
  assert.deepEqual(check(region([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]])).issues, []);
  assert.ok(check(region([[0, 0], [10, 0], [0, 10], [10, 10], [0, 0]])).issues.some(m => /self-crossing/.test(m)));
  // Square with a square hole joined by a horizontal cut-in, then a diagonal one.
  const ok = [[0, 0], [10, 0], [10, 5], [7, 5], [7, 3], [3, 3], [3, 7], [7, 7], [7, 5], [10, 5], [10, 10], [0, 10], [0, 0]];
  const r = check(region(ok)); assert.deepEqual(r.issues, []); assert.equal(r.cutIns, 1);
  const diag = [[0, 0], [10, 0], [10, 10], [7, 7], [7, 3], [3, 3], [3, 7], [7, 7], [10, 10], [0, 10], [0, 0]];
  assert.ok(check(region(diag)).issues.some(m => /diagonal cut-in/.test(m)));
  assert.ok(check(head.replace("46Y46", "44Y44") + "M02*\n").issues.some(m => /6/.test(m)));
  // X2 attribute syntax.
  const tf = "%TF.GenerationSoftware,Waffle,Waffle,1.0*%\n%TF.CreationDate,2026-11-18T10:30:00+01:00*%\n%TF.FileFunction,Copper,L1,Top*%\n%TF.FilePolarity,Positive*%\n";
  const x2ok = tf + head + "%TA.AperFunction,SMDPad,CuDef*%\n%ADD10C,0.5*%\n%TD.AperFunction*%\n%TO.N,V\\u2212*%\n%TO.P,U1,2,V\\u2212*%\n%TO.C,U1*%\nD10*\nX0Y0D03*\n%TD*%\nM02*\n";
  assert.deepEqual(check(x2ok, {x2: true}).issues, []);
  for (const [bad, why] of [["%TF.FileFunction,Copper,Top*%", /FileFunction/], ["%TA.AperFunction,SMDPad*%", /AperFunction/], ["%TO.P,U1*%", /fields/],
    ["%TO.N,a\\x*%", /escape/], ["%TF.Bogus,1*%", /unknown standard/], ["%TF.FilePolarity,Dark*%", /FilePolarity/], ["%TF.CreationDate,yesterday*%", /CreationDate/]])
    assert.ok(check(head + bad + "\nM02*\n").issues.some(m => why.test(m)), bad);
  assert.ok(check(head + "%ADD10C,0.5*%\nD10*\nX0Y0D03*\n%TF.Part,Single*%\nM02*\n").issues.some(m => /after the first object/.test(m)));
  assert.ok(check(head + "M02*\n", {x2: true}).issues.some(m => /missing TF.FileFunction/.test(m)));

  // Sample board.
  const project = AtriumParts.example(), doc = project.documents[1];
  all(F.build(project, doc, {date}), "sample");
  // 4-layer board: stored stack, knockout and TrueType-style text with holes,
  // a pour, a via stack with an oversized top land.
  const p = A.project("Four", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.name = "Four"; pcb.outline = [[0, 0], [50, 0], [50, 40], [0, 40]];
  pcb.stackup = {version: 1, layers: AtriumStackup.preset("4").layers};
  pcb.rules = {format: "atrium-rules", version: 1, units: "mm", defaults: {clearance: .2, trackWidth: .15, viaDrill: .3}, nets: {}};
  pcb.items.push(
    {id: "k1", kind: "label", text: "OAB8 PCB 08", x: 5, y: 8, size: 2, inverted: true, margin: .4, layer: "Silk"},
    {id: "k2", kind: "label", text: "PCB 08", x: 5, y: 18, size: 2, inverted: true, margin: .4, angle: 30, layer: "Top"},
    {id: "k3", kind: "label", text: "QR 0", x: 30, y: 8, size: 2, inverted: true, margin: .3, angle: 90, layer: "Bottom silk"},
    {id: "t", kind: "track", layer: "Inner 1", net: "SIG", width: .25, points: [[20, 30], [40, 30]]},
    {id: "v1", kind: "via", x: 40, y: 30, diameter: .6, drill: .3, layer: "Multi", net: "SIG", stackMode: "tmb", padStack: {Top: {diameter: 1.2}, Mid: {diameter: .6}, Bottom: {diameter: .6}}},
    {id: "v2", kind: "via", x: 45, y: 35, diameter: .6, drill: .3, layer: "Multi", net: "GND"},
    AtriumPolygonPour.make([[30, 25], [50, 25], [50, 40], [30, 40]], {net: "GND", layer: "Top"}));
  AtriumPolygonPour.apply(pcb, new Map(p.library.map(d => [d.id, d])));
  const four = F.build(p, pcb, {date});
  assert.ok(four.files.some(f => f.name === "Four.G1") && four.files.some(f => f.name === "Four.G2"));
  assert.ok(all(four, "4-layer") >= 10, "knockout text uses cut-ins");
  console.log("gerber-check: ok");
}
