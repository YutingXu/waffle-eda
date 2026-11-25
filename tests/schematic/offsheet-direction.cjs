"use strict";
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "sch-object-inspector", "undo-store", "hierarchy", "erc",
  "sch-import", "kicad-export", "kicad-schematic", "sexpr", "import-kicad", "zip", "altium-export"]) require(require("../support/app-source-paths.cjs").appFile(m));
const A = Atrium, S = AtriumSchObjects, E = AtriumERC;
const p = A.project("Connector directions"), [a] = p.documents, b = A.sheet("schematic", "Child");
p.documents = [a, b];
const off = (doc, io, name = "DATA", at = [12.3456, -2.54]) => {
  const i = S.make("offsheet", at, {text:name, io}); doc.items.push(i); return i;
};
const a1 = off(a, "output"), b1 = off(b, "output"), quiet = off(a, undefined, "OLD");
const matrix = result => result.messages.filter(m => m.check === "matrix");
let findings = matrix(E.run(p));
assert.equal(findings.length, 1);
assert.equal(findings[0].class, "Error");
assert.match(findings[0].text, /Output off-sheet connector DATA on Child/);
assert.deepEqual(findings[0].point, [a1.x, a1.y]);
assert.equal(findings[0].objectId, a1.id);
const render = i => {
  const paths = []; let path;
  const ctx = new Proxy({beginPath() {path = [];}, moveTo(x, y) {path.push([x,y]);}, lineTo(x, y) {path.push([x,y]);},
    closePath() {path.push("close");}, stroke() {paths.push(path);}}, {get:(o,k) => o[k] ?? (() => {})});
  S.draw(ctx, i, {scale:10}); return paths;
};
const seen = new Set();
for (const io of S.IO) {
  const item = S.make("offsheet", [0, 0], {text:"DATA", io});
  const paths = render(item);
  seen.add(JSON.stringify(paths));
  if (io === "unspecified") {
    assert.ok(!Object.hasOwn(item, "io"));
    assert.deepEqual(paths, [[[0,-1.1],[1.1,0],[0,1.1]],[[1.1,-1.1],[2.2,0],[1.1,1.1]]]);
  } else {
    assert.equal(paths[0].at(-1), "close");
    const centerline = paths[0].filter(q => Array.isArray(q) && q[1] === 0);
    assert.equal(centerline.some(q => q[0] === 0), io !== "output");
    assert.equal(centerline.some(q => q[0] > 0), io !== "input");
    for (const angle of [0,90,180,270]) {
      item.angle = angle;
      const box = S.box(item), tips = paths[0].filter(Array.isArray).map(q => A.world(q, item));
      assert.ok(tips.every(([x,y]) => x >= box[0]-1e-9 && x <= box[2]+1e-9 && y >= box[1]-1e-9 && y <= box[3]+1e-9));
      assert.deepEqual(S.hotspots(item), [[0,0]]);
    }
  }
}
assert.equal(seen.size, 4);
assert.deepEqual(render(quiet), render({...quiet, io:"unspecified"}));
assert.deepEqual(["bidi","I/O","in","out"].map(A.offsheetIO), ["bidirectional","bidirectional","input","output"]);
const u = AtriumUndoStore, cache = new WeakMap();
u.reset(); u.touch(p); u.sync(p);
const cached = () => matrix(E.run(p,{cache})).map(m => [m.text,m.class,m.sig]);
assert.deepEqual(cached(), cached());
for (const io of ["input", "bidirectional", "unspecified", "output"]) {
  b1.io = io;
  u.touch(p,{doc:b,items:[b1]}); u.sync(p);
  assert.deepEqual(cached(), matrix(E.run(p)).map(m => [m.text,m.class,m.sig]));
  assert.equal(cached().length, Number(io === "output"));
}
b.items.push(S.make("noerc", [b1.x, b1.y]));
assert.equal(matrix(E.run(p)).length, 0);
b.items.pop();
b1.io = "input";
p.erc = {version:1, matrix:{"0,2":"Fatal"}};
assert.equal(matrix(E.run(p))[0].class, "Fatal");
delete p.erc;
// A typed connector and a real pin share the same matrix. It never becomes
// an electrical pin in the netlist or the single-pin count.
p.library = [{id:"D",name:"Driver",symbol:{shapes:[],pins:[{number:"1",x:0,y:0,electrical:2}]}}];
b.items.push({id:"u1",kind:"part",def:"D",ref:"U1",value:"Driver",x:b1.x,y:b1.y,angle:0,pinNets:{}});
findings = matrix(E.run(p)); assert.equal(findings.length, 1);
assert.match(findings[0].text, /Output pin U1-1/);
assert.equal(AtriumHierarchy.compile(p).nets.find(n => n.name === "DATA").pins.length, 1);
// The imported IsCrossSheetConnector flag distinguishes this terminal from a
// floating power port. The imported and native untyped forms act identically.
const raw = "|RECORD=31\n|RECORD=17|ISCROSSSHEETCONNECTOR=T|TEXT=SDA|SHOWNETNAME=T|LOCATION.X=100|LOCATION.Y=50\n|RECORD=17|TEXT=VOUT|LOCATION.X=20|LOCATION.Y=90";
const old = AtriumSCH.read("Crossing.SchDoc", null, raw).documents[0];
const [sda] = old.items; assert.equal(sda.kind, "netlabel"); assert.ok(A.isOffsheet(sda));
const legacy = A.project("Crossing"); legacy.documents = [old];
const frozen = JSON.stringify(legacy);
const power = E.run(legacy).messages.filter(m => m.check === "floatingPower");
assert.deepEqual(power.map(m => m.text), ["Floating power object VOUT"]);
E.run(legacy); assert.equal(JSON.stringify(legacy), frozen);
const panel = {append() {}}, fields = new Map(), tools = {el:() => ({}), field:(s,label,v,change) => fields.set(label,{v, change})};
const host = {project:() => legacy, doc:() => old, unit:() => "mm", edit:fn => fn()};
AtriumSchObjectInspector.directives(panel,sda,host,tools);
assert.equal(fields.get("I/O type").v, "unspecified");
fields.get("I/O type").change("output"); assert.equal(sda.kind, "offsheet"); assert.equal(sda.io, "output");
assert.equal(sda.schPaint.offSheet, true);
AtriumSchObjectInspector.inspector(panel,sda,host,tools);
fields.get("I/O type").change("unspecified"); assert.ok(!Object.hasOwn(sda,"io"));
// Distinguish every KiCad shape on import; explicitly report lossy mappings.
const shapes = ["input","output","bidirectional","tri_state","passive","future",null];
const label = (shape, n) => '(global_label "S' + n + '" ' + (shape ? "(shape " + shape + ")" : "") + ' (at '+(10+n)+' 20 90))';
const drawing = AtriumKiCadImport.readSheet("Shapes.kicad_sch","(kicad_sch (version 20250114) "+shapes.map(label).join(" ")+")");
const imported = drawing.documents[0];
assert.deepEqual(imported.items.map(i=>i.io), ["input","output","bidirectional","bidirectional",undefined,undefined,undefined]);
assert.ok(imported.items.slice(4).every(i=>!Object.hasOwn(i,"io")));
assert.match(drawing.notes.join(" "), /[Tt]ri-state/); assert.match(drawing.notes.join(" "), /unknown global-label shape/i);
const exchange = A.project("Shapes"); exchange.documents = [imported];
const before = JSON.stringify(exchange);
const ki = AtriumKiCadSchematic.exportSheet(exchange,imported);
const kiAgain = AtriumKiCadImport.readSheet(ki.name,ki.content).documents[0];
assert.deepEqual(kiAgain.items.map(i => i.io), imported.items.map(i => i.io));
assert.ok(kiAgain.items.every(i => i.angle === -90), "all anchors retain their orientation");
const al = AtriumAltiumExport.exportSchematic(exchange,imported);
const records = al.content.split(/\r?\n/).filter(x => x.includes("ISCROSSSHEETCONNECTOR=T"));
assert.equal(records.length, shapes.length);
assert.ok(records.every(x => x.includes("RECORD=17") && !x.includes("IOTYPE")));
assert.deepEqual(AtriumSCH.read(al.name,null,al.content).documents[0].items.filter(A.isOffsheet).map(i=>i.text), imported.items.map(i=>i.text));
assert.match(al.diagnostics.join(" "),/direction output was dropped/);
assert.equal(JSON.stringify(exchange), before);
console.log("offsheet-direction: four outlines, direction matrix, No ERC, cached edits, legacy projection and translator round-trips passed");
