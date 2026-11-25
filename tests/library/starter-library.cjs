"use strict";
// Starter library: generic parts with symbols and generated footprints that validate and stay small.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
for(const m of ["model","connectivity","parts","library-panel","footprint-wizard","starter-library","stackup","viastack","polygon-pour","rules"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumStarterLibrary,A=Atrium,Lib=AtriumLibrary;
const defs=S.defs();
assert.ok(defs.length>=40,"about forty parts ("+defs.length+")");
assert.equal(new Set(defs.map(d=>d.id)).size,defs.length,"ids are unique");
assert.ok(defs.every(d=>d.id.startsWith("starter-")),"stable starter ids");
assert.deepEqual(S.ids(),defs.map(d=>d.id));

// Every definition validates in a project, and each has a footprint.
const project=A.project("Starter",[]);
assert.equal(S.addTo(project),defs.length);
assert.equal(S.addTo(project),0,"adding twice adds nothing");
A.validate(JSON.parse(JSON.stringify(project)));
for(const d of defs){
  assert.ok(d.footprint?.pads?.length,d.id+" has pads");
  const v=Lib.validateDef(d);assert.ok(v.ok,d.id+": "+v.errors.join("; "));
  // Parameters: Value, Tolerance, Voltage, Power and a blank LCSC #.
  assert.deepEqual(Object.keys(d.parameters),["Value","Tolerance","Voltage","Power","LCSC #"],d.id);
  assert.equal(d.parameters["LCSC #"],"",d.id);
  // Symbol pins match footprint pad numbers.
  if(d.symbol){
    const pads=new Set(d.footprint.pads.map(p=>String(p.number)).filter(Boolean));
    for(const p of d.symbol.pins)assert.ok(pads.has(p.number),d.id+": pin "+p.number+" has a pad");
    for(const n of pads)assert.ok(d.symbol.pins.some(p=>p.number===n),d.id+": pad "+n+" has a pin");
    for(const p of d.symbol.pins)assert.ok(Number.isInteger(p.electrical)&&p.electrical>=0&&p.electrical<=7,d.id+" pin types");
  }
}
const by=id=>defs.find(d=>d.id===id);
// Wizard footprints carry their spec (the wizard can reopen them) and IPC names.
assert.equal(by("starter-r-0603").footprint.wizard.family,"chip");
assert.match(by("starter-r-0805").footprint.name,/^RESC2012/);
assert.match(by("starter-mcu-qfn32").footprint.name,/^QFN50P500X500/);
assert.equal(by("starter-mcu-qfn32").symbol.pins.length,33,"QFN-32 plus exposed pad");
assert.equal(by("starter-mcu-qfp48").symbol.pins.length,48);
assert.ok(by("starter-mcu-qfp48").symbol.pins.some(p=>p.name==="NRST"&&p.electrical===0),"typed MCU pins");
assert.ok(by("starter-mcu-qfp48").symbol.pins.filter(p=>p.electrical===7).length>=8,"power pins are Power");
// The dual op amp has two gates sharing its supply pins.
const op=by("starter-opamp-dual").symbol;
assert.equal(op.parts,2);
assert.deepEqual(op.pins.filter(p=>!(p.part>0)).map(p=>p.number).sort(),["4","8"]);
assert.deepEqual(op.pins.filter(p=>p.part===2).map(p=>p.number).sort(),["5","6","7"]);
// Pin types: an LDO's EN is an input, its supply pins Power.
const ldo=by("starter-ldo-sot235").symbol.pins;
assert.equal(ldo.find(p=>p.name==="EN").electrical,0);assert.equal(ldo.find(p=>p.name==="GND").electrical,7);
// Net tie: flagged footprint with a copper bridge, for net-ties.js.
const tie=by("starter-nettie-2").footprint;
assert.equal(tie.netTie,true);assert.deepEqual(tie.netTieGroups,[["1","2"]]);
assert.ok(tie.shapes.some(s=>s.layer==="Top"&&s.kind==="path"),"bridge copper");
// Mechanical parts: footprint only; holes are plated through.
assert.equal(by("starter-mh-m3").symbol,undefined);assert.equal(by("starter-mh-m3").footprint.pads[0].drill,3.2);
assert.equal(by("starter-fid-1mm").footprint.pads[0].maskExpansion,1);
// USB-C: twelve contacts, four shield legs.
const usb=by("starter-usbc-16").footprint.pads;
assert.equal(usb.filter(p=>!p.drill).length,12);assert.equal(usb.filter(p=>p.number==="S1").length,4);
// Generic names only: no manufacturer part numbers, LCSC left blank.
for(const d of defs)assert.doesNotMatch(d.name+" "+d.value,/\b(LM|AMS|STM|ATmega|NE5|TPS|MP\d|BC8|2N\d|AO\d|SS\d|1N\d)/,d.id);
// Every footprint passes DRC on its own with the default rules (silk clears mask openings, etc.),
// placed alone on an empty board at 0° and 90°.
{
  const R=AtriumRules,rules=R.create();
  for(const d of defs)for(const angle of [0,90]){
    const doc=A.sheet("pcb","B");doc.outline=[[-20,-20],[20,-20],[20,20],[-20,20]];
    doc.items.push({id:"p",kind:"part",ref:(d.prefix||"U")+"1",def:d.id,value:d.value||"",x:0,y:0,angle,pinNets:{}});
    const out=R.drc(doc,new Map([[d.id,d]]),rules);
    assert.equal(out.violations.length,0,d.id+" at "+angle+"°: "+out.violations.map(v=>v.type+" "+v.title+" "+v.actual).join("; "));
  }
}
// Defs are fresh copies.
const a=S.defs();a[0].name="changed";assert.notEqual(S.defs()[0].name,"changed");
const templates=S.templates();
assert.equal(templates,S.templates(),"lookup keeps the same definition objects");
assert.deepEqual(templates,S.defs());
assert.throws(()=>{templates.reverse();},TypeError);
assert.throws(()=>{templates[0].parameters.Tolerance="unapproved";},TypeError);
assert.throws(()=>{templates[0].footprint.pads[0].number="999";},TypeError);
const fromProject=project.library.find(d=>d.id===templates[0].id);
fromProject.footprint.pads[0].number="project edit";
assert.notEqual(templates[0].footprint.pads[0].number,"project edit");
assert.notEqual(S.defs()[0].footprint.pads[0].number,"project edit");
// The source stays small: footprints are generated, not stored.
const size=fs.readFileSync(path.join(__dirname,"../../app/library/starter-library.js")).length;
assert.ok(size<30000,"starter-library.js is "+size+" bytes");
console.log("SHIM-OK starter-library ("+defs.length+" parts, "+JSON.stringify(defs).length+" bytes generated)");
