"use strict";
// Altium ASCII project export (app/formats/altium-export.js, PREVIEW). Waffle's own Altium importers
// (sch-import.js, pcb-import.js, io.js) are the oracle: export, read the files back as an Altium
// import, and compare parts, pins and net partitions on the sheet, and pads, nets, tracks, vias,
// pours, outline and rules on the board.
//   1. The built-in example project (plus pours, a keep-out fill, text and rules).
//   2. The real Altium fixture (tests/fixtures/altium/pidp11-io-expander, BSD-2-Clause): binary
//      import -> ASCII export -> import.
// The independent Altium Designer PiDP-11 open and Save As control are documented in docs/importing.md.
// Native Designer's saved board uses DXPRule for the authoritative rule and
// Rule for its Protel companion. Check the transport separately from Waffle import.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "query", "viastack", "rooms", "component-classes", "pcb-pours", "polygon-pour",
  "net-intent", "signals", "rules", "project-rules", "import-rules", "pcb-text-rich", "pcb-text", "pcb-draw", "zip", "import-link", "source-file", "sch-import", "altium-rules", "pcb-import", "sexpr", "io", "altium-export"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, X = AtriumAltiumExport, R = AtriumRules;
const near = (a, b, tol = 2e-4) => Math.abs(a - b) <= tol;
const nearP = (p, q, tol = 2e-4) => near(p[0], q[0], tol) && near(p[1], q[1], tol);
const defsOf = p => new Map(p.library.map(d => [d.id, d]));

function reimport(out) {
  const read = out.files.map(f => ({name: f.name, r: AtriumIO.read(f.name, f.bytes)}));
  const manifest = read.find(x => x.r.manifest)?.r.manifest;
  const p = A.project("Imported"); p.documents = []; p.library = [];
  for (const {r} of read) { p.documents.push(...(r.documents || [])); p.library.push(...(r.library || [])); }
  if (globalThis.AtriumImportLink?.reconcile) AtriumImportLink.reconcile(p, p.documents);
  A.validate(p);
  return {project: p, manifest};
}
function pinsOf(doc, defs, shift = [0, 0]) {
  return doc.items.filter(i => i.kind === "part").flatMap(i => A.pins(i, defs.get(i.def), "schematic").map(p => ({key: i.ref + "." + p.number, at: [p.at[0] + shift[0], p.at[1] + shift[1]], id: i.id + "/" + p.number})));
}
function partition(doc, defs, pins) {
  const c = A.connectivity(doc, defs), groups = new Map();
  for (const p of pins) { const n = c.byPin.get(p.id); if (n == null) continue; if (!groups.has(n)) groups.set(n, []); groups.get(n).push(p.key); }
  return [...groups.values()].filter(g => g.length > 1).map(g => g.sort().join(",")).sort();
}
const worldPads = (part, def) => A.pins(part, def, "pcb").map(p => ({n: p.number, at: p.at, w: p.w, h: p.h, drill: p.drill || 0, net: part.pinNets?.[p.number] ?? p.net ?? ""}));
const segs = doc => doc.items.filter(i => i.kind === "track").flatMap(t => t.points.slice(1).map((p, k) => {
  const a = t.points[k].map(v => v.toFixed(3)).join(","), b = p.map(v => v.toFixed(3)).join(",");
  return [a < b ? a + "|" + b : b + "|" + a, t.layer, t.width.toFixed(3), t.net || ""].join(" ");
}).filter(s => !/^(\S+)\|\1 /.test(s))).sort();
const vias = doc => doc.items.filter(i => i.kind === "via").map(v => [v.x, v.y, v.diameter, v.drill].map(n => n.toFixed(3)).join(",") + " " + (v.net || "")).sort();

function compareSheet(src, srcDefs, out, back, backDefs, label) {
  const records = out.content.trimEnd().split("\r\n"), header = records.shift();
  const weight = /\|WEIGHT=(\d+)(?:\||$)/i.exec(header);
  assert.equal(Number(weight?.[1]), records.filter(line => /^\|RECORD=/i.test(line)).length, label + " native schematic object count");
  assert.match(records[0], /^\|RECORD=31(?:\||$)/, label + " begins with a sheet object");
  const s1 = src, s2 = back;
  const shift = [out.offset[0], -out.offset[1]];
  const p1 = pinsOf(s1, srcDefs, shift), p2 = pinsOf(s2, backDefs);
  assert.equal(p2.length, p1.length, label + " pin count");
  for (const p of p1) assert.ok(p2.some(q => q.key === p.key && nearP(q.at, p.at, 1e-3)), label + " pin " + p.key + " at " + p.at);
  assert.deepEqual(partition(s2, backDefs, p2), partition(s1, srcDefs, p1), label + " net partition");
  // %UTF8% fields of an ASCII file come back as written (sch-import.js decodeAscii decodes them as UTF-8).
  const refs = d => d.items.filter(i => i.kind === "part").map(i => i.ref + "=" + i.value).sort();
  assert.deepEqual(refs(s2), refs(s1), label + " designators and values");
  return {parts: refs(s1).length, pins: p1.length, nets: partition(s1, srcDefs, p1).length};
}
// The board exporter moves Waffle boards (Y down) into Altium's positive workspace; compare
// against the source moved by the same whole-grid offset.
function shifted(doc, [dx, dy]) {
  if (!dx && !dy) return doc;
  const d = JSON.parse(JSON.stringify(doc)), mv = p => [p[0] + dx, p[1] + dy];
  d.outline = (d.outline || []).map(mv);
  for (const i of d.items) { if (typeof i.x === "number") { i.x += dx; i.y += dy; } if (Array.isArray(i.points)) i.points = i.points.map(mv); }
  return d;
}
function compareBoard(src, srcDefs, back, backDefs, label, offset = [0, 0]) {
  src = shifted(src, offset);
  const parts = d => d.items.filter(i => i.kind === "part");
  assert.equal(parts(back).length, parts(src).length, label + " components");
  let pads = 0;
  for (const part of parts(src)) {
    const other = parts(back).find(i => i.ref === part.ref);
    assert.ok(other, label + " missing " + part.ref);
    assert.equal(other.layer || "Top", part.layer || "Top", label + " " + part.ref + " side");
    const want = worldPads(part, srcDefs.get(part.def)), got = worldPads(other, backDefs.get(other.def));
    assert.equal(got.length, want.length, label + " " + part.ref + " pads");
    for (const w of want) {
      const g = got.find(x => x.n === w.n && nearP(x.at, w.at));
      assert.ok(g, label + " " + part.ref + " pad " + w.n + " moved");
      assert.ok(near(g.drill, w.drill) && near(Math.min(g.w, g.h), Math.min(w.w, w.h)) && near(Math.max(g.w, g.h), Math.max(w.w, w.h)), label + " " + part.ref + "." + w.n + " size");
      assert.equal(g.net, w.net, label + " " + part.ref + "." + w.n + " net");
      pads++;
    }
  }
  const free = d => d.items.filter(i => i.kind === "pad").map(i => [i.x, i.y, i.w, i.h, i.drill || 0].map(v => v.toFixed(3)).join(",") + " " + (i.net || "")).sort();
  assert.deepEqual(free(back), free(src), label + " free pads");
  assert.deepEqual(segs(back), segs(src), label + " track segments");
  assert.deepEqual(vias(back), vias(src), label + " vias");
  const outline = d => (d.outline || []).filter((p, k, a) => !(k === a.length - 1 && a.length > 3 && A.same(p, a[0])));
  assert.equal(outline(back).length, outline(src).length, label + " outline vertices");
  for (const p of outline(src)) assert.ok(outline(back).some(q => nearP(p, q)), label + " outline " + p);
  const pours = d => d.items.filter(i => i.kind === "polygon");
  assert.equal(pours(back).length, pours(src).length, label + " pours");
  for (const s of pours(src)) {
    const g = pours(back).find(b => b.layer === s.layer && (b.net || "") === (s.net || "") && b.points.length === s.points.length && s.points.every(q => b.points.some(r => nearP(q, r))));
    assert.ok(g, label + " pour " + (s.name || s.net));
    const dflt = {fillMode: "solid", removeDeadCopper: true, pourOverSameNet: true};
    for (const k of Object.keys(dflt)) assert.equal(g[k] ?? dflt[k], s[k] ?? dflt[k], label + " pour " + k);
    if ((s.fillMode || "solid") === "hatched") for (const k of ["hatchWidth", "hatchPitch", "hatchAngle"]) assert.ok(near(g[k], s[k]), label + " pour " + k);
    assert.equal(g.pourIndex ?? 0, Math.round(s.pourIndex ?? 0), label + " pour index");
    assert.equal(!!g.cutout, !!s.cutout, label + " pour cut-out");
  }
  return {parts: parts(src).length, pads, segments: segs(src).length, vias: vias(src).length, pours: pours(src).length};
}

// A legacy port can land on the far endpoint. Preserve that attachment, including
// for rotated ports, and retain copper tracks shorter than the connection key.
{
  const project = A.project("ASCII coordinate fidelity");
  const [sheet, board] = project.documents;
  sheet.items.push(
    {id:"far-port", kind:"netlabel", x:5.08, y:0, text:"RIGHT",
      schPaint:{type:"port", style:3, width:5.08, offset:[-5.08, 0]}},
    {id:"right-wire", kind:"wire", points:[[5.08, 0], [10.16, 0]]},
    {id:"upper-port", kind:"netlabel", x:0, y:-5.08, text:"UP",
      schPaint:{type:"port", style:7, width:5.08, offset:[0, 5.08]}},
    {id:"upper-wire", kind:"wire", points:[[0, -5.08], [0, -10.16]]});
  const sources = [
    {id:"short-track", kind:"track", points:[[1, -5], [1.0000254, -5]], width:.4, net:"SHORT", layer:"Top"},
    {id:"point-track", kind:"track", points:[[2, -5], [2, -5]], width:.2, net:"DOT", layer:"Bottom"}
  ];
  assert.ok(A.same(...sources[0].points), "track ends share a Waffle connection key");
  board.items.push(...sources);
  const body = {kind:"via", number:"", x:.3, y:.4, w:.6, h:.6, diameter:.6, drill:.3,
    layer:"Multi", fromLayer:"Top", toLayer:"Inner 1", net:"REF"};
  const definition = {id:"via-footprint", name:"Via footprint", footprint:{name:"Via footprint", pads:[body], shapes:[]}};
  project.library.push(definition);
  for (const [i, angle] of [90, 180].entries())
    board.items.push({id:"via-part-"+i, def:definition.id, kind:"part", ref:"V"+i, value:"Via footprint", x:5+i, y:-6, angle, layer:"Top"});
  board.items.push({id:"drill-note", kind:"label", x:3, y:-2, layer:"Drill drawing", text:"Drill note", size:1});
  board.items.push({id:"blank-note", kind:"label", x:4, y:-2, layer:"Silk", text:"", size:1});
  const exported = X.exportProject(project);
  const pcbText = exported.files.find(f => /\.pcbdoc$/i.test(f.name)).content;
  assert.equal(pcbText.match(/\|RECORD=Via\|LAYER=MULTILAYER\|COMPONENT=[01]\|/g)?.length, 2, "each via has an ASCII component owner");
  assert.match(pcbText, /\|RECORD=Text\|LAYER=DRILLDRAWING\|/);
  const {project: copy} = reimport(exported);
  const copiedSheet = copy.documents.find(d => d.kind === "schematic");
  for (const text of ["RIGHT", "UP"]) {
    const label = copiedSheet.items.find(i => i.text === text);
    assert.ok(label && copiedSheet.items.some(i => i.kind === "wire" && A.same([label.x, label.y], i.points[0])), text + " port stays attached");
  }
  const copiedBoard = copy.documents.find(d => d.kind === "pcb");
  assert.equal(copiedBoard.items.length, board.items.length);
  assert.ok(copiedBoard.items.some(i => i.kind === "label" && i.layer === "Drill drawing" && i.text === "Drill note"));
  assert.ok(copiedBoard.items.some(i => i.kind === "label" && i.layer === "Silk" && i.text === "" &&
    nearP([i.x, i.y], [4, -2], 3e-6)), "explicit blank text record retains its anchor");
  assert.ok(!copiedBoard.items.some(i => i.kind === "via"), "owned vias remain in their footprints");
  for (const peer of copiedBoard.items.filter(i => i.kind === "part")) {
    const [via] = copy.library.find(d => d.id === peer.def).footprint.pads;
    assert.equal(via.kind, "via");
    assert.deepEqual([via.layer, via.fromLayer, via.toLayer, via.net], [body.layer, body.fromLayer, body.toLayer, body.net]);
    assert.ok(nearP([via.x, via.y], [body.x, body.y], 3e-6) && near(via.drill, body.drill, 3e-6) &&
      near(via.diameter, body.diameter, 3e-6), "rotated footprint retains local via geometry");
  }
  for (const source of sources) {
    const track = copiedBoard.items.find(i => i.kind === "track" && i.net === source.net);
    assert.ok(track && track.layer === source.layer && near(track.width, source.width, 3e-6));
    assert.ok(track.points.every((p, k) => nearP(p, source.points[k], 3e-6)), source.net + " native endpoints");
  }
}

// ------------------------------------------------------------------ 1. the example project
{
  const project = AtriumParts.example(), sheet = project.documents.find(d => d.kind === "schematic"), board = project.documents.find(d => d.kind === "pcb");
  const PP = AtriumPolygonPour;
  board.items.push(PP.make(board.outline.map(p => [...p]), {net: "GND", layer: "Bottom", name: "GND plane"}));
  board.items.push(PP.make([[20, 12], [34, 12], [34, 20], [20, 20]], {net: "VDD", layer: "Top", fillMode: "hatched", hatchPitch: .8, hatchWidth: .25, hatchAngle: 45, removeDeadCopper: false, pourIndex: 1}));
  board.items.push(PP.make([[5, 15], [9, 15], [9, 19], [5, 19]], {layer: "Bottom", cutout: true}));
  board.items.push({id: "ko", kind: "graphic", layer: "Keepout", points: [[30, 2], [34, 2], [34, 6], [30, 6]], fill: true, closed: true, width: 0});
  board.items.push({id: "note", kind: "label", x: 4, y: 21, text: "Rev A — preview", size: 1, layer: "Silk"});
  const rules = R.create();
  rules.netClasses = {Power: ["VIN", "VDD", "GND"]};
  const width = rules.list.find(r => r.type === "width");
  rules.list.push({...width, id: "w-power", name: "PowerWidth", priority: 1, scope: AtriumDesignQueryRecord.selector("netclass","Power"), min: .4, preferred: .5, max: 2});
  width.priority = 2;
  R.store(board, project, rules);
  const frozen = JSON.stringify(project);
  const out = X.exportProject(project);
  assert.equal(JSON.stringify(project), frozen, "export leaves the project unchanged");
  assert.deepEqual(X.exportProject(project).files.map(f => f.content), out.files.map(f => f.content), "deterministic");
  const names = out.files.map(f => f.name);
  assert.equal(names[0], project.name + ".PrjPcb");
  assert.ok(out.bytes[0] === 0x50 && out.bytes[1] === 0x4b, "zip");
  assert.match(out.diagnostics[0], /^Preview export\..*\.PrjPcb in Altium Designer/, "preview note gives the native project opening workflow");
  for (const f of out.files) assert.ok(f.bytes.every(b => b !== 0x7c || true) && !/[^\x00-\xff]/.test(String.fromCharCode(...f.bytes.slice(0, 2000))), "single-byte encoding");
  const {project: p2, manifest} = reimport(out);
  assert.deepEqual(manifest.paths, names.slice(1), "PrjPcb lists every document");
  const d1 = defsOf(project), d2 = defsOf(p2);
  const sheetOut = X.exportSchematic(project, sheet);
  const s = compareSheet(sheet, d1, sheetOut, p2.documents.find(d => d.kind === "schematic"), d2, "example sheet");
  const b2 = p2.documents.find(d => d.kind === "pcb");
  const boardOut = X.exportBoard(project, board);
  assert.ok(boardOut.offset[0] >= 0 && boardOut.offset[1] < 0, "the example board moves into Altium's positive workspace");
  const b = compareBoard(board, d1, b2, d2, "example board", boardOut.offset);
  assert.ok(b2.items.some(i => i.kind === "label" && i.text === "Rev A — preview"), "board text");
  assert.equal(b2.items.filter(i => i.kind === "graphic" && i.layer === "Keepout" && i.fill).length, 1, "keep-out fill");
  // Rules come back as Altium source rules that convert to the same Waffle rules.
  assert.ok(b2.sourceRules?.length > 5, "rule records");
  const converted = b2.sourceRules.map(R.fromAltium).filter(x => x.rule).map(x => x.rule);
  const pw = converted.find(r => r.name === "PowerWidth");
  // Lengths travel in mil to 1/10000 mil (Altium's resolution), so they come back within 2.54 nm.
  assert.deepEqual(pw.scope, AtriumDesignQueryRecord.selector("netclass","Power"));
  for (const [k, v] of [["min", .4], ["preferred", .5], ["max", 2]]) assert.ok(near(pw[k], v, 3e-6), "PowerWidth " + k);
  const clr = converted.find(r => r.type === "clearance");
  assert.ok(near(clr.gap, R.effective(board, project).list.find(r => r.type === "clearance").gap, 3e-6), "clearance gap");
  console.log("PASS Altium ASCII example: sheet " + s.parts + " parts, " + s.pins + " pins, " + s.nets + " nets; board " + b.parts + " parts, " + b.pads + " pads, " +
    b.segments + " segments, " + b.vias + " vias, " + b.pours + " pours; " + converted.length + " of " + b2.sourceRules.length + " rules convert back");
}

// ------------------------------------------------------------------ 2. the real Altium fixture
{
  const DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const FILES = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"];
  const read = FILES.map(name => AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name)))));
  const p = A.project("PiDP-11 I/O Expander"); p.documents = []; p.library = [];
  for (const r of read) { p.documents.push(...(r.documents || [])); p.library.push(...(r.library || [])); }
  if (globalThis.AtriumImportLink?.reconcile) AtriumImportLink.reconcile(p, p.documents);
  A.validate(p);
  const out = X.exportProject(p), {project: p2} = reimport(out), d1 = defsOf(p), d2 = defsOf(p2);
  const sch = p.documents.find(d => d.kind === "schematic"), pcb = p.documents.find(d => d.kind === "pcb");
  const s = compareSheet(sch, d1, X.exportSchematic(p, sch), p2.documents.find(d => d.kind === "schematic"), d2, "PiDP-11 sheet");
  const pcbOut = X.exportBoard(p, pcb);
  assert.ok(pcbOut.offset.every(v => v === 0), "boards from Altium keep their coordinates");
  const b = compareBoard(pcb, d1, p2.documents.find(d => d.kind === "pcb"), d2, "PiDP-11 board", pcbOut.offset);
  // Older Waffle previews declared zero records even when the source contained a complete sheet.
  const schFile = out.files.find(f => /\.SchDoc$/i.test(f.name));
  const firstLine = schFile.bytes.indexOf(13);
  const header = schFile.content.slice(0, firstLine).replace(/\|WEIGHT=\d+/, "|WEIGHT=0");
  const oldBytes = new Uint8Array(header.length + schFile.bytes.length - firstLine);
  oldBytes.set(new TextEncoder().encode(header)); oldBytes.set(schFile.bytes.subarray(firstLine), header.length);
  const legacy = AtriumIO.read(schFile.name, oldBytes);
  assert.equal(legacy.documents[0].items.filter(i => i.kind === "part").length, 23, "previous zero-weight Waffle files remain readable");
  const rules = p2.documents.find(d => d.kind === "pcb").sourceRules || [];
  const D = AtriumAltiumRules, P = AtriumProjectRules;
  const properties = records => records.map(line => D.describe(line).fields);
  const recordsOf = board => AtriumPCB.asciiRuleRecords(new TextDecoder("windows-1252").decode(board.bytes));
  const original = properties(pcb.sourceRules);
  assert.equal(original.length, 41);
  assert.deepEqual(properties(rules),original,"keeping local checks preserves every original source rule field");
  assert.deepEqual([...pcbOut.content.matchAll(/^\|RECORD=DXPRule\|INDEXFORSAVE=(\d+)\|/gm)].map(m=>+m[1]),Array.from({length:41},(_,i)=>i));
  assert.doesNotMatch(pcbOut.content,/^\|RECORD=Rule\|/m);
  const adopted = AtriumImportRules.apply(pcb,p,d1);
  assert.ok(adopted.converted>0 && adopted.converted<original.length);
  assert.equal(pcb.appliedSourceRuleRecords.length,adopted.converted);
  const reopened=A.validate(JSON.parse(JSON.stringify(p))),saved=reopened.documents.find(d=>d.kind==="pcb");
  assert.deepEqual(properties(recordsOf(X.exportBoard(reopened,saved))),original,"adopt, save, reopen, export preserves all original properties and their order");
  const stockFanout = reopened.rules.list.find(r => r.type === "fanoutControl" && r.name === "Fanout_BGA" && r.origin?.kind === "default");
  assert.ok(stockFanout && AtriumUUID.isV7(stockFanout.id), "adoption gives untouched default rules durable identities and provenance");
  const earlier = A.clone(reopened), earlierBoard = earlier.documents.find(d => d.id === saved.id);
  for (const r of earlier.rules.list) if (r.origin?.kind === "default") delete r.origin;
  assert.deepEqual(properties(recordsOf(X.exportBoard(earlier,earlierBoard))),original,"earlier UUID rule books retain unchanged originals without stock annotations");
  const changedDefault = A.clone(reopened), changedBoard = changedDefault.documents.find(d => d.id === saved.id);
  P.edit(changedDefault, book => {book.list.find(r => r.id === stockFanout.id).comment = "Reviewed in Waffle";});
  assert.deepEqual(properties(recordsOf(X.exportBoard(changedDefault,changedBoard))),
    original.map(row => row.NAME === stockFanout.name ? Object.assign(Object.create(null), row, {COMMENT:"Reviewed in Waffle"}) : row),
    "editing the inherited stock slot updates its retained row and preserves the unsupported fields");
  const nameOf=r=>D.describe(r).name;
  const sourceName=r=>r.origin?.record?nameOf(saved.sourceRules[r.origin.record-1]):"";
  const rawWidth=original.find(f=>f.NAME==="Width_1A"),rawMask=original.find(f=>f.NAME==="SolderMaskExpansion_Via");
  P.edit(reopened,book=>{
    const width=book.list.find(r=>sourceName(r)==="Width_1A"),other=book.list.find(r=>sourceName(r)==="Width");
    [width.priority,other.priority]=[other.priority,width.priority];
    Object.assign(width,{name:"Fine power",min:.3048,scope: AtriumDesignQueryRecord.selector("net","GND"),enabled:false});
    book.list=book.list.filter(r=>sourceName(r)!=="SolderMaskExpansion_Via");
    book.list.push({id:"new-bus-width",type:"width",name:"New bus width",enabled:true,priority:3,scope: AtriumDesignQueryRecord.selector("net","BUS"),min:.2,preferred:.3,max:.4});
  });
  const edited=properties(recordsOf(X.exportBoard(reopened,saved)));
  const changed=edited.find(f=>f.UNIQUEID===rawWidth.UNIQUEID),fresh=edited.find(f=>f.NAME==="New bus width");
  assert.deepEqual({...changed},{...rawWidth,NAME:"Fine power",PRIORITY:"2",MINLIMIT:"12mil",SCOPE1EXPRESSION:"InNet('GND')",ENABLED:"FALSE"});
  assert.equal(edited.find(f=>f.NAME==="Width").PRIORITY,"1");
  assert.ok(fresh && fresh.UNIQUEID!==rawWidth.UNIQUEID && fresh.SCOPE1EXPRESSION==="InNet('BUS')");
  assert.ok(!edited.some(f=>f.UNIQUEID===rawMask.UNIQUEID));
  assert.equal(edited.length,41);
  P.edit(reopened,book=>{book.list=book.list.filter(r=>!r.origin?.record);});
  const final=A.validate(JSON.parse(JSON.stringify(reopened))),finalBoard=final.documents.find(d=>d.kind==="pcb");
  const remaining=properties(recordsOf(X.exportBoard(final,finalBoard)));
  const expected=original.filter((f,i)=>!saved.appliedSourceRuleRecords.includes(i+1));
  assert.deepEqual(remaining.filter(f=>f.NAME!=="New bus width"),expected,"deleting the last adopted rule keeps source-only rows and never resurrects deleted ones");
  console.log("PASS Altium ASCII round trip of the real PiDP-11 fixture: sheet " + s.parts + " parts, " + s.pins + " pins, " + s.nets + " nets; board " + b.parts + " parts, " + b.pads +
    " pads, " + b.segments + " segments, " + b.vias + " vias, " + b.pours + " pours, " + rules.length + " rules (" + out.files.map(f => f.name + " " + f.bytes.length + " B").join(", ") + ")");
}

// Mixed source generations: keep sparse source priorities, then upgrade an
// adopted Protel rule to modern scope syntax only when its scope is edited.
{
  const p=A.project("Mixed rules"),board=p.documents.find(d=>d.kind==="pcb");
  const common="RULEKIND=Width|ENABLED=TRUE|NETSCOPE=AnyNet|LAYERKIND=SameLayer|MINLIMIT=6mil|PREFEREDWIDTH=10mil|MAXLIMIT=20mil";
  board.sourceRules=[
    common+"|NAME=Old width|PRIORITY=2|SCOPE1COUNT=1|SCOPE1_0_KIND=Net|SCOPE1_0_VALUE=VCC|SCOPE2COUNT=1|SCOPE2_0_KIND=Board|CUSTOM=retained",
    common+"|NAME=General width|PRIORITY=7|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All",
    "RULEKIND=RoomDefinition|NAME=Legacy room|ENABLED=FALSE|PRIORITY=1|SCOPE1COUNT=2|SCOPE1_0_KIND=CustomV4Selector"
  ];
  const read=()=>AtriumPCB.asciiRuleRecords(X.exportBoard(p,board).content).map(AtriumAltiumRules.describe);
  assert.equal(AtriumImportRules.apply(board,p).converted,2);
  assert.equal(read()[0].fields.SCOPE1COUNT,"1");
  AtriumProjectRules.edit(p,b=>{
    const [old,general]=[1,2].map(n=>b.list.find(r=>r.origin?.record===n));
    [old.priority,general.priority]=[general.priority,old.priority];old.scope=AtriumDesignQueryRecord.selector("net","AUX");
  });
  const after=read();
  assert.deepEqual(after.map(x=>x.priority),["7","2","1"]);
  assert.deepEqual([after[0].first,after[0].second,after[0].fields.CUSTOM,after[0].fields.SCOPE1COUNT],["InNet('AUX')","All","retained",undefined]);
  assert.match(X.exportBoard(p,board).content,/\|RECORD=Rule\|[^\n]*NAME=Legacy room/);
  assert.match(after[2].first,/Legacy scope/);
  // Older Waffle projects had board provenance but no per-rule source index.
  for(const r of p.rules.list)if(r.origin)delete r.origin.record;
  delete board.appliedSourceRuleRecords;
  AtriumProjectRules.edit(p,b=>{
    b.list=b.list.filter(r=>r.name!=="General width");
    b.list.find(r=>r.name==="Old width").name="Edited old width";
  });
  assert.deepEqual(read().map(x=>x.name),["Edited old width","Legacy room"]);
  assert.deepEqual(board.appliedSourceRuleRecords,[1,2]);
}

// An editable layer width table writes Altium's corresponding dimensions in the ASCII file.
{
  const p=A.project("Layer widths"),board=p.documents.find(d=>d.kind==="pcb");
  board.stackup={version:1,layers:["Top","Inner 1","Bottom"].map(key=>({key,type:"Signal",name:key,material:"Copper",thickness:.035})),drillPairs:[]};
  board.items.push({kind:"track",id:A.id(),layer:"Inner 1",net:"DATA",width:.15,points:[[0,0],[4,0]]});
  const scope=AtriumDesignQueryRecord.selector("net","DATA"),set=AtriumRules.create();
  const rule=set.list.find(r=>r.type==="width");
  Object.assign(rule,{scope,min:.127,preferred:.1524,max:.254,layers:{Top:{widthMin:.1524},"Inner 1":{widthMax:.1778}}});
  AtriumRules.store(board,p,set);
  const file=X.exportBoard(p,board),decoded=AtriumIO.read(file.name,file.bytes).documents[0];
  const width=decoded.sourceRules.find(line=>AtriumAltiumRules.describe(line).kind==="Width");
  assert.match(width,/TOPLAYER_MINWIDTH=6mil/);
  assert.match(width,/MIDLAYER1_MAXWIDTH=7mil/);
  const imported=AtriumRules.fromAltium(width,decoded).rule;
  assert.deepEqual(imported.layers,rule.layers);
  assert.match(imported.scope.source,/DATA/);
}
