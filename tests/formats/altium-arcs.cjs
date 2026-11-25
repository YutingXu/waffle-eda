"use strict";
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "parts", "spatial", "connectivity", "pcb-pours", "pcb-appearance", "board-shape", "pcb-draw", "pcb-edit",
  "source-file", "altium-ids", "eco", "pcb-import", "io", "altium-export", "pcb-patch", "source-copy", "dxf", "stackup", "zip", "polygon-pour",
  "fab-outputs", "ipc2581", "canvas", "path-record", "pdf", "print"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const A = Atrium, S = AtriumBoardShape, F = AtriumFabOutputs, unit = .00000254;
const clone = x => JSON.parse(JSON.stringify(x));
const near = (a, b, epsilon = 4e-6) => assert.ok(Math.abs(a - b) <= epsilon, a + " differs from " + b);
const point = (p, q, epsilon) => { near(p[0], q[0], epsilon); near(p[1], q[1], epsilon); };
const at = (g, a) => [g.c[0] + Math.cos(a * Math.PI / 180) * g.r, g.c[1] - Math.sin(a * Math.PI / 180) * g.r];
function sameArc(a, b, shift = [0, 0], dir = true) {
  assert.ok(a && b, "missing native arc");
  const move = p => [p[0] + shift[0], p[1] + shift[1]];
  point(move(a.c), b.c); near(a.r, b.r);
  if (dir) { assert.equal(a.ccw, b.ccw); near(A.arcSweep(a), A.arcSweep(b)); }
  for (const f of [0, .37, 1]) point(move(at(a, a.start + f * A.arcSweep(a))), at(b, b.start + f * A.arcSweep(b)));
}
function record(radius, start, end) {
  const data = Buffer.alloc(65);
  data[0] = 1; data.writeUInt32LE(60, 1);
  const offset = 5; data[offset] = 1; data[offset + 1] = 12;
  for (const pos of [3, 5, 7]) data.writeUInt16LE(0xffff, offset + pos);
  for (const [pos, n] of [[13, 5000000], [17, 4000000], [21, radius], [41, 100000]]) data.writeInt32LE(n, offset + pos);
  data.writeDoubleLE(start, offset + 25); data.writeDoubleLE(end, offset + 33);
  data[offset + 53] = 0x71; // opaque record tail
  return data;
}
const boardText = Buffer.from("|VX0=0mm|VY0=0mm|VX1=40mm|VY1=0mm|VX2=40mm|VY2=30mm|VX3=0mm|VY3=30mm\0");
const header = Buffer.alloc(4); header.writeUInt32LE(boardText.length);
const stream = Buffer.concat([record(1500000, 12.5, 284.75), record(-1250000, 30, 60), record(1000000, 45, 405)]);
const native = new Map([["board6/data", Buffer.concat([header, boardText])], ["arcs6/data", stream]]);
const readNative = (s, options) => AtriumPCB.read("Arcs.PcbDoc", s, null, options).documents[0];
const original = readNative(native);
assert.equal(original.sourceArcVersion, 1);
const originals = original.items.filter(i => i.arc);
assert.equal(originals.length, 3);
for (const [i, signedRadius, start, end] of [[0, 1500000, 12.5, 284.75], [1, -1250000, 30, 60], [2, 1000000, 45, 405]]) {
  const shift = signedRadius < 0 ? 180 : 0;
  sameArc({kind:"arc", c:[5000000 * unit, -4000000 * unit], r:Math.abs(signedRadius) * unit, start:start + shift, end:end + shift, ccw:true}, A.pathArc(originals[i]));
}
const dot = readNative(new Map([...native,["arcs6/data",record(0,0,360)]]));
assert.equal(dot.sourceArcVersion,1); assert.equal(dot.items[0].arc,undefined);
assert.deepEqual(dot.items[0].points,[dot.items[0].points[0],dot.items[0].points[0]]);
const legacy = readNative(native, {legacyArcPaths:true});
assert.ok(!legacy.sourceArcVersion && legacy.items.every(i => !i.arc));
assert.equal(legacy.items[0].id, originals[0].id, "adding true geometry preserves the source identity");
{
  const {pointSeg} = require("../support/segment-distance.cjs");
  const props = {VX0:"6mm", VY0:"0mm", VX1:"-6mm", VY1:"0mm", VX2:"-6mm", VY2:"-4mm", VX3:"6mm", VY3:"-4mm",
    KIND0:"1", CX0:"0mm", CY0:"0mm", SA0:"0", EA0:"180", LAYER:"Top"};
  const source = Buffer.from(Object.entries(props).map(([k,v]) => "|" + k + "=" + v).join("") + "\0");
  const size = Buffer.alloc(4); size.writeUInt32LE(source.length);
  const board = readNative(new Map([["board6/data", Buffer.concat([size, source])]]));
  const polygon = AtriumPCB.polygon(props);
  assert.equal(board.boardShape.contour[0].kind, "arc");
  assert.equal(polygon.regionShape.contour[0].kind, "arc");
  for (const [label, points] of [["Board6", board.outline], ["Polygons6", polygon.points]]) {
    point(points[0], [6, 0]);
    assert.ok(points.some(p => p[0] === -6 && p[1] === 0), label + " preserves the authored end");
    for (let i = 0; i <= 512; i++) {
      const t = i * Math.PI / 512, at = [6 * Math.cos(t), -6 * Math.sin(t)];
      const miss = Math.min(...points.slice(1).map((b, j) => pointSeg(at, points[j], b)));
      assert.ok(miss <= .005, label + " chord error " + miss);
    }
  }
}
const p = A.project("Arcs", []), board = p.documents.find(d => d.kind === "pcb");
function add(g, opts = {}) {
  const i = {id:A.id(), kind:"track", net:"SIGNAL", layer:"Top", width:.27, arc:g, points:A.arcProjection(g), ...opts};
  board.items.push(i); return i;
}
const major = add({kind:"arc", c:[12,-12], r:3, start:0, end:90, ccw:false});
major.maskExpansion=0;
const minor = add({kind:"arc", c:[23,-13], r:4, start:90, end:180, ccw:true});
const circle = add({kind:"arc", c:[31,-11], r:3, start:0, end:0, ccw:true});
const nearCircle = add({kind:"arc", c:[33,-22], r:2, start:0, end:-.000001, ccw:true}, {layer:"Bottom"});
S.apply(board, S.rect({x:0, y:0, width:42, height:32, corners:{bl:{style:"radius",size:2.5}}}));
near(A.arcSweep(major.arc), -270); near(A.arcSweep(minor.arc), 90); near(A.arcSweep(circle.arc), 360);
near(A.pathLength(major),4.5*Math.PI); near(A.pathLength(circle),6*Math.PI);
near(A.arcSweep(nearCircle.arc), 359.999999, 1e-9);
const mirror = AtriumPCBEdit.mirrorShape({...minor, kind:"path"}), mir = A.pathArc(mirror);
point(mir.c, [-23,-13]); assert.equal(mir.ccw,false);
point(at(mir, mir.start), [-23, -17]); point(at(mir, mir.end), [-19,-13]);
const placed = A.transformArc(mir, q => A.world(q, {x:20,y:12,angle:90}), 90);
point(placed.c,[33,-11]); point(at(placed,placed.start),[37,-11]); point(at(placed,placed.end),[33,-7]);
const moved = clone(major); A.moveItem(moved, 6, -1); sameArc(major.arc, A.pathArc(moved), [6,-1]);
moved.points[1][0] += .1; assert.equal(A.pathArc(moved), null, "a polygon-only edit supersedes the old curve");
const bad = clone(p); bad.documents[1].items[0].arc.ccw = 0;
assert.throws(() => A.validate(bad)); A.validate(clone(p));

const ascii = AtriumAltiumExport.exportBoard(p, board);
assert.equal((ascii.content.match(/\|RECORD=Arc\|/gi) || []).length, 4, "one Altium record per curve");
assert.match(ascii.content, /KIND\d+=1/);
const reopened = AtriumIO.read("Arcs.PcbDoc", ascii.bytes).documents[0];
const curves = reopened.items.filter(i => i.arc);
assert.equal(curves.length, 4);
for (const [i,g] of board.items.entries()) sameArc(g.arc, A.pathArc(curves[i]), ascii.offset);
assert.equal(curves[0].maskExpansion,0,"the exposed arc keeps its manual mask opening");
const oldProfile = board.boardShape.contour.filter(g => g.kind === "arc"), newProfile = reopened.boardShape.contour.filter(g => g.kind === "arc");
assert.equal(oldProfile.length, 1); assert.equal(newProfile.length, 1); sameArc(oldProfile[0], newProfile[0], ascii.offset);

const copy = clone(originals[1]); copy.arc.c[0] += 37 * unit; copy.arc.start += 13.25; copy.arc.end -= 6.25;
copy.arc.r += 125 * unit; copy.points = A.arcProjection(copy.arc, 5); copy.width += 23 * unit;
const plan = AtriumPCBPatch.plan(native, [{before:originals[1], after:copy}]);
assert.deepEqual(plan.records, ["arcs6/data#1"]);
const result = Buffer.from(plan.replacements.get("arcs6/data")), changed = readNative(new Map([...native, ...plan.replacements])).items[1];
sameArc(copy.arc, changed.arc); near(copy.width, changed.width);
assert.equal(result.length, stream.length);
for (let i = 0; i < result.length; i++) if (i < 70 + 13 || i >= 70 + 45) assert.equal(result[i], stream[i], "unrelated byte " + i);
assert.equal(result.readInt32LE(70 + 21), -1250125, "source signed radius survives an edit");
assert.deepEqual(AtriumPCBPatch.plan(native, [{before:originals[1], after:clone(originals[1])}]).records, []);
assert.throws(() => AtriumPCBPatch.plan(native, [{before:originals[1], after:{...copy, points:originals[1].points}}]), /circular path/);

// Saving and reopening through the real project serializer preserves the source link.
// Its native writer verifies an edited copy by importing the resulting OLE file.
const compound = CFB.utils.cfb_new();
for (const [name,bytes] of native) CFB.utils.cfb_add(compound, name, bytes);
CFB.utils.cfb_add(compound, "Unknown/Data", Buffer.from([0, 254, 71]));
const bytes = Buffer.from(CFB.write(compound, {type:"buffer"}));
const imported = AtriumIO.read("Arcs.PcbDoc", bytes), saved = A.project("Arcs",imported.library);
saved.documents = imported.documents;
const {reopenAltium} = require("../support/altium-folder.cjs");
const firstStore = reopenAltium(saved,{name:"Arcs.PcbDoc",bytes});
const restored = firstStore.project, restoredDoc = restored.documents[0];
const bound = {provenance:firstStore.retained};
assert.deepEqual(Buffer.from(AtriumSourceCopy.prepare(restoredDoc,restored.library,bytes,bound).bytes),bytes);
for (const [i,g] of originals.entries()) sameArc(g.arc, A.pathArc(restoredDoc.items[i]));
const old = clone(restoredDoc); delete old.sourceArcVersion;
for (let i=0;i<old.items.length;i++) { delete old.items[i].arc; old.items[i].points=legacy.items[i].points; }
assert.deepEqual(Buffer.from(AtriumSourceCopy.prepare(old,restored.library,bytes).bytes),bytes);
Object.assign(restoredDoc.items[1], {arc:copy.arc, points:copy.points, width:copy.width});
const updated = reopenAltium(restored,{name:"Arcs.PcbDoc",bytes},firstStore.entry).project;
const edited = AtriumSourceCopy.prepare(updated.documents[0],updated.library,bytes,bound);
assert.deepEqual(edited.records,["arcs6/data#1"]);
sameArc(copy.arc, AtriumIO.read(edited.name,edited.bytes).documents[0].items[1].arc);
assert.deepEqual(AtriumIO.streams(edited.bytes).get("unknown/data"),AtriumIO.streams(bytes).get("unknown/data"));

const out = F.build(p, board, {origin:"absolute", format:"4:6"}), file = ext => out.files.find(f => f.name.endsWith("." + ext)).content;
const top = file("GTL"), bottom = file("GBL");
assert.match(file("GTS"), /G02X12000000Y15000000I-3000000J0D01\*/, "the exposed mask follows the same major arc");
for (const cmd of ["G02X12000000Y15000000I-3000000J0D01*", "G03X19000000Y13000000I0J-4000000D01*", "G03X34000000Y11000000I-3000000J0D01*"]) assert.ok(top.includes(cmd), cmd);
assert.equal((top.match(/G0[23]X/g) || []).length, 3); assert.match(top, /G75\*/);
assert.equal((bottom.match(/G03X/g) || []).length, 2, "nearly closed endpoints use two arcs on the output grid");
assert.match(file("GM1"), /G0[23]X/);

// Earlier native projects used a boolean to label sampled arcs. A three-vertex
// half-turn is an observable case: its two copper chords deviate 0.293 mm from a circle.
const oldProject = A.project("Saved arc", []), oldBoard = oldProject.documents[1];
oldBoard.outline = [[0,0],[10,0],[10,10],[0,10]];
const oldStroke = {id:"legacy", kind:"graphic", layer:"Top", width:.2, arc:true, points:[[2,4],[3,3],[4,4]]};
oldBoard.items.push(oldStroke);
assert.equal(A.pathArc(oldStroke), null); near(A.pathLength(oldStroke),2*Math.SQRT2);
function legacyOutputs() {
  return [
    F.build(oldProject, oldBoard, {origin:"absolute", date:new Date(0)}).files.find(f=>f.name.endsWith(".GTL")).content,
    AtriumPrint.build(oldProject, {documents:[oldBoard.id], layerSets:["top"], scale:1}).pages[0].list
  ];
}
const flagged = legacyOutputs();
assert.ok(!/G0[23]X/.test(flagged[0]), "legacy copper stays two linear moves");
delete oldStroke.arc;
assert.deepEqual(flagged, legacyOutputs(), "the flag preserves the previous plotted and printed vertices");
const ipc = AtriumIPC2581.build(p, board, {origin:"absolute"}).content;
assert.deepEqual(AtriumIPC2581.check(ipc).errors, []);
const tree = AtriumIPC2581.parse(ipc);
function all(n, type) { return [...(n.name === type ? [n] : []), ...n.children.flatMap(child => all(child,type))]; }
const copper = all(tree, "LayerFeature").find(n => n.attrs.layerRef === "TOP"), nodes = all(copper,"Arc").map(n => n.attrs);
assert.equal(nodes.length,4, "IPC circle consists of two unambiguous half-arcs");
for (const [index,g] of [[0,major.arc],[1,minor.arc]]) {
  const x = nodes[index]; point([+x.centerX,-x.centerY],g.c); point([+x.startX,-x.startY],at(g,g.start)); point([+x.endX,-x.endY],at(g,g.end)); assert.equal(x.clockwise,String(!g.ccw));
}
assert.ok(all(tree,"PolyStepCurve").length >= 1);
for (const mode of ["primitives", "polyline"]) {
  const dxf = AtriumDXF.exportBoard(board, new Map(), {mode,layers:["Top"],outline:false}), parsed = AtriumDXF.read(dxf.text);
  if (mode === "primitives") assert.deepEqual(parsed.entities.map(e => e.type), ["ARC","ARC","CIRCLE"]);
  const again = AtriumDXF.polylines(parsed, {exactArcs:true});
  assert.equal(again.length,3); for (const [i,it] of [major,minor,circle].entries()) sameArc(it.arc, A.pathArc(again[i]));
}

// Standard CIRCLE has no named start point. Retain its seam for editing across a DXF reopen.
for (const ccw of [false,true]) {
  const g = {kind:"arc", c:[17,-8], r:2.5, start:39.5, end:39.5, ccw};
  const written = AtriumDXF.write([{layer:"Silk",segs:[g],closed:true}],{mode:"primitives"});
  const parsed = AtriumDXF.read(written); assert.deepEqual(parsed.entities.map(e=>e.type),["CIRCLE"]);
  sameArc(g, AtriumDXF.polylines(parsed,{exactArcs:true})[0].arc);
}

// Bottom footprints are reflected in their local definition before board placement.
const drawing = A.project("Bottom artwork", []), doc = drawing.documents[1];
const silk = AtriumPCBEdit.mirrorShape({...minor, kind:"path", layer:"Silk"});
drawing.library.push({id:"fp", name:"Arc", footprint:{shapes:[silk], pads:[]}});
doc.items.push({id:"u",kind:"part",def:"fp",ref:"U1",value:"Arc",x:20,y:12,angle:90,layer:"Bottom",pinNets:{}});
S.apply(doc, S.rect({x:0,y:0,width:45,height:30,corners:{tr:{style:"radius",size:3}}}));
const mapped = F.build(drawing, doc, {origin:"absolute"}), overlay = mapped.files.find(f=>f.name.endsWith(".GBO")).content;
assert.match(overlay,/G02X33000000Y7000000I-4000000J0D01\*/);
const assembly = F.assembly(mapped.model,"Bottom",F.settle({})).content;
assert.match(assembly,/<path d="[^"]*A/);
const arcOps = row => {
  let n=0; for(let i=0;i<row.d.length;) { const k=row.d[i++]; if(k===2)n++; i+=k===2?6:k===3?0:2; } return n;
};
const pages = AtriumPrint.build(drawing,{documents:[doc.id],layerSets:["bottom","assembly-bottom","drill"],scale:1}).pages;
assert.equal(pages.length,3);
for(const page of pages) assert.ok(page.list.some(op=>op.k==="p" && arcOps(op)>0),page.title+" prints curved paths");
const composite = AtriumPrint.build(p,{documents:[board.id],layerSets:["top"],scale:1}).pages[0];
assert.ok(composite.list.some(op=>op.k==="p" && Math.abs(op.w-.27*composite.scale)<1e-6 && arcOps(op)>0), "copper itself prints as cubic curves");

// Evaluate the cubic control points independently after serializing a 1:1 PDF.
for (const radius of [1, 25, 200, 5000]) {
  const rec = AtriumPDF.recorder(100,100), c = rec.ctx;
  const mm = 72/25.4;
  c.scale(mm,mm); c.beginPath(); c.arc(11,17,radius,0,Math.PI*2); c.stroke();
  const pdf = AtriumPDF.document(); pdf.page(100,100,rec.list);
  const text = new TextDecoder("latin1").decode(pdf.bytes({compress:false})), d = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/), op = fields.pop();
    if (op === "c" || op === "m") d.push(op === "m" ? 0 : 2, ...fields.map(x=>+x/mm));
  }
  assert.equal(d[0],0);
  let from = d.slice(1,3), max = 0;
  for (let i = 3; i < d.length; i += 7) {
    assert.equal(d[i],2); const b = d.slice(i+1,i+3), e = d.slice(i+3,i+5), end = d.slice(i+5,i+7);
    for (let j=1;j<=100;j++) {
      const t = j/100, u = 1-t;
      const q = from.map((x,k) => u*u*u*x + 3*u*u*t*b[k] + 3*u*t*t*e[k] + t*t*t*end[k]);
      max = Math.max(max, Math.abs(Math.hypot(q[0]-11,q[1]-17)-radius));
    }
    from=end;
  }
  point(from,[11+radius,17]); assert.ok(max <= .005, "maximum radial error in mm: " + max);
}
require("../../app/checks/altium-rules.js");
require("../../app/formats/sch-import.js");
require("../../app/formats/sch-patch.js");
{
  const R = AtriumAltiumRecords, messages = ["bad head", "bad payload"];
  const fields = text => Object.assign({}, R.properties(text, ...fields.mode));
  const odd = "=SKIP| NAME = Keep \0";
  fields.mode = [true, true];
  assert.deepEqual(fields(odd), {NAME:"Keep"});
  fields.mode = [true, false];
  assert.deepEqual(fields(odd), {NAME:" Keep "});
  fields.mode = [false, true];
  assert.deepEqual(fields(odd), {NAME:"Keep \0"});
  assert.equal(AtriumAltiumRules.describe("RULEKIND=Width|NAME=Keep \0").name, "Keep \0");
  assert.equal(R.frame(Uint8Array.of(0, 0, 0, 0), 0, 4, messages).size, 0);
  assert.throws(() => R.frame(Uint8Array.of(1, 2), 0, 4, messages), /bad head/);
  assert.throws(() => R.frame(Uint8Array.of(2, 0, 0, 0, 1), 0, 4, messages), /bad payload/);
  assert.throws(() => R.frame(Uint8Array.of(1, 0, 0, 0, 0, 0), 0, 6, ["Rules6 head", "Rules6 payload"]), /Rules6 payload/);
  assert.throws(() => AtriumPCB.netNames(new Map([["nets6/data", Uint8Array.of(1, 2)]])), /Truncated PCB record header/);
  assert.deepEqual(AtriumPCB.netNames(new Map([["nets6/data", Uint8Array.of(0, 0, 0, 0)]])), []);
  function pack(head, body, flag = 0) {
    const out = Buffer.alloc(head + body.length);
    const word = ((body.length & 0xffffff) | ((flag & 0xff) << 24)) >>> 0;
    if (head === 6) { out.writeUInt16LE(4, 0); out.writeUInt32LE(word, 2); }
    else out.writeUInt32LE(word, 0);
    body.copy(out, head);
    return out;
  }
  const net = pack(4, Buffer.from("NAME= Keep \0"));
  const netShift = Buffer.concat([Buffer.from([7]), net]).subarray(1);
  assert.equal(netShift.byteOffset > 0, true);
  assert.deepEqual(AtriumPCB.netNames(new Map([["nets6/data", net]])), ["Keep"]);
  assert.deepEqual(AtriumPCB.netNames(new Map([["nets6/data", netShift]])), ["Keep"]);
  const euro = Buffer.from([0x80]), utf8 = Buffer.from([0xc3, 0xa9]);
  const named = Buffer.concat([Buffer.from("RULEKIND=Width|NAME="), euro, Buffer.from("|%UTF8%NAME="), utf8]);
  const rule = pack(6, named, 0xab);
  const ruleShift = Buffer.concat([Buffer.from([0x99, 0x99]), rule]).subarray(2);
  const kinds = [];
  const decoded = AtriumAltiumRules.binary(ruleShift, kinds);
  assert.deepEqual(kinds, [4]);
  assert.deepEqual(decoded, AtriumAltiumRules.binary(Buffer.from(rule)));
  assert.equal(AtriumAltiumRules.describe(decoded[0]).name, "\u00e9");
  const prefixed = AtriumAltiumRules.binary(pack(6, Buffer.from("||RULEKIND=Width|NAME=A")))[0];
  assert.equal(prefixed, "|RULEKIND=Width|NAME=A");
  const spaced = Buffer.concat([Buffer.from("|RULEKIND=Width|NAME="), euro, Buffer.from("| %UTF8%NAME="), utf8]);
  const spacedLine = AtriumAltiumRules.binary(pack(6, spaced))[0];
  assert.equal(spacedLine.includes("\u00e9"), false);
  assert.ok(spacedLine.includes("\u00c3\u00a9"));
  const marked = pack(4, Buffer.from("RECORD=4|TEXT=Hi"), 0x20);
  const markedShift = Buffer.concat([Buffer.from([1, 2, 3, 4]), marked]).subarray(4);
  assert.equal(R.frame(markedShift, 0, 4, messages).flag, 0x20);
  assert.deepEqual([...R.frame(markedShift, 0, 4, messages).payload], [...R.frame(Buffer.from(marked), 0, 4, messages).payload]);
  const sheet = Buffer.concat([pack(4, Buffer.from("HEADER=X")), marked]);
  const id = {record: 0, role: "wire"};
  assert.throws(() => AtriumSchPatch.plan(new Map([["fileheader", sheet]]), [{before:{kind:"wire", schSource:id}, after:{kind:"wire", schSource:id}}]), /original schematic record is unavailable/);
  assert.throws(() => AtriumSchPatch.plan(new Map([["fileheader", Uint8Array.of(1, 2, 3)]]), []), /Truncated SchDoc record header/);
  assert.throws(() => AtriumSCH.read("T.SchDoc", new Map([["fileheader", Uint8Array.of(1, 2)]])), /Incomplete schematic record header/);
  const move = {kind:"part", sourceRecord:"components6/data#0", x:0, y:0};
  const compShift = Buffer.concat([Buffer.from([9, 9, 9]), pack(4, Buffer.from("|X=0mil|Y=0mil"), 0x7f)]).subarray(3);
  assert.deepEqual(AtriumPCBPatch.plan(new Map([["components6/data", compShift]]), [{before:move, after:{...move, x:1}}]).records, ["components6/data#0"]);
  assert.throws(() => AtriumPCBPatch.plan(new Map([["components6/data", Uint8Array.of(0, 0, 0, 0)]]), [{before:move, after:{...move, x:1}}]), /empty property record/);
  const classBody = Buffer.concat([Buffer.from("NAME="), euro, Buffer.from("|KIND=0| %UTF8%NAME="), utf8]);
  const classRecord = pack(4, classBody);
  const board = pack(4, Buffer.from("|VX0=0mm|VY0=0mm|VX1=40mm|VY1=0mm|VX2=40mm|VY2=30mm|VX3=0mm|VY3=30mm\0"));
  const readClasses = bytes => AtriumPCB.read("C.PcbDoc", new Map([["board6/data", board], ["classes6/data", bytes]]), null).documents[0].sourceClasses;
  const classes = readClasses(classRecord);
  assert.deepEqual(classes, readClasses(Buffer.concat([Buffer.alloc(5, 1), classRecord]).subarray(5)));
  assert.ok(classes.some(line => line.includes("\u00e9")));
}
console.log("PASS native Altium, directed and mirrored PCB arcs, project validation, source-preserving edits, exact CAM/DXF and bounded PDF curves.");
