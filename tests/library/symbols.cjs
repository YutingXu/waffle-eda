"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/formats/sch-import.js");
require("../../app/library/symbols.js");
const A=globalThis.Atrium, S=globalThis.AtriumSymbols;
const project=AtriumParts.example();
const original=structuredClone(project);
function terminals(p){
  const defs=new Map(p.library.map(d=>[d.id,d]));
  return p.documents.map(doc=>doc.items.filter(i=>i.kind==="part").map(item=>[
    item.ref,...A.pins(item,defs.get(item.def),doc.kind).map(pin=>[pin.number,pin.at])
  ]));
}
const before=terminals(project);
const settings={...S.preferences(project),resistor:"iec",capacitor:"parallel"};
const result=S.applyPreferences(project,settings);
assert.equal(result.changed,2);assert.deepEqual(result.skipped,[]);
assert.ok(project.library.find(d=>d.id==="std-r").symbol.shapes.some(s=>s.closed));
// Generated leads are pins, drawn black like Altium pins; the artwork stays a body drawing.
assert.deepEqual(project.library.find(d=>d.id==="std-c").symbol.shapes.map(s=>s.style),["pin","pin","body","body"]);
assert.deepEqual(project.documents,original.documents);
assert.deepEqual(project.library.map(d=>d.footprint),original.library.map(d=>d.footprint));
assert.deepEqual(terminals(project),before);
assert.equal(S.applyPreferences(project).changed,0);
assert.equal(S.applyPreferences(project,{...settings,resistor:"ansi"}).changed,1);
assert.ok(project.library.find(d=>d.id==="std-r").symbol.shapes.some(s=>s.points.length===8));
const restored=A.validate(JSON.parse(JSON.stringify(project)));
S.applyPreferences(restored,{...settings,resistor:"source",capacitor:"source"});
assert.deepEqual(restored.library,original.library);
const ascii=[
  "|HEADER=Protel", "|RECORD=31", "|RECORD=1|LibReference=Vendor_R|Location.X=90|Location.Y=100|Orientation=3",
  "|RECORD=2|OwnerIndex=1|Location.X=91|Location.Y=107|PinLength=3|PinConglomerate=1|Designator=A|Electrical=4",
  "|RECORD=2|OwnerIndex=1|Location.X=92|Location.Y=93|PinLength=3|PinConglomerate=3|Designator=B|Electrical=4",
  "|RECORD=13|OwnerIndex=1|Location.X=91|Location.Y=107|Corner.X=92|Corner.Y=93",
  "|RECORD=34|OwnerIndex=1|Text=R17","|RECORD=41|OwnerIndex=1|Name=Value|Text=4.7k",
  "|RECORD=27|LocationCount=2|X1=91|Y1=110|X2=100|Y2=110"
].join("\n");
const actual=AtriumSCH.read("test.SchDoc",null,ascii);
const doc=actual.documents[0],part=doc.items.find(i=>i.kind==="part"),def=actual.library[0];
project.documents.push(doc);project.library.push(def);
const oldPins=A.pins(part,def,"schematic"),oldWire=structuredClone(doc.items.find(i=>i.kind==="wire"));
const importedSettings={...settings,mappings:[...settings.mappings,[S.keyFor(def),"resistor"]]};
S.applyPreferences(project,importedSettings);
assert.deepEqual(A.pins(part,def,"schematic"),oldPins);
assert.deepEqual(doc.items.find(i=>i.kind==="wire"),oldWire);
assert.deepEqual(def.symbol.shapes[0].points[0],[def.symbol.pins[0].x,def.symbol.pins[0].y]);
assert.deepEqual(def.symbol.shapes[1].points.at(-1),[def.symbol.pins[1].x,def.symbol.pins[1].y]);
assert.equal(part.value,"4.7k");assert.equal(part.ref,"R17");
const future=AtriumSCH.read("other.SchDoc",null,ascii).library[0];
project.library.push(future);
assert.equal(S.applyPreferences(project).changed,1);
assert.deepEqual(future.symbol.shapes,def.symbol.shapes);
const incompatible=A.clone(future);incompatible.id=A.id();delete incompatible.sourceSymbolShapes;
incompatible.symbol.pins.pop();project.library.push(incompatible);
const originalBad=structuredClone(incompatible);
const skipped=S.applyPreferences(project);
assert.match(skipped.skipped.join(" "),/two pins/);assert.deepEqual(incompatible,originalBad);
assert.doesNotThrow(()=>A.validate(JSON.parse(JSON.stringify(project))));
console.log("PASS passive styles, source restoration, imported pin connectivity, future library mappings and incompatible parts");
