"use strict";

const assert = require("node:assert/strict");
for (const name of ["uuid-v7","model","parts","spatial","connectivity","pcb-pours","pcb-appearance","zip",
  "stackup","rigid-flex","rules","viastack","board-shape","polygon-pour","bom","variants",
  "fab-outputs","vendor/zipjs-deflate","odb-eda","odb"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const G = globalThis, A = G.Atrium, V = G.AtriumVariants;
const project = A.project("CADNET and assembly", G.AtriumParts.catalogue);
const board = project.documents.find(doc => doc.kind === "pcb");
board.outline = [[0,0],[22,0],[22,17],[0,17]];
board.stackup = {version:1,layers:G.AtriumStackup.preset("4").layers};
const small = project.library.find(def => def.id === "std-r");
project.library.push({...small,id:"test-r0805",footprint:{...small.footprint,name:"R_0805",
  pads:small.footprint.pads.map(pad => ({...pad,x:pad.x*1.4,w:pad.w*1.3,h:pad.h*1.3}))}});

function part(ref,def,x,extra) {
  const item = {id:ref,ref,kind:"part",def,value:"1k",x,y:12,layer:"Top",showRef:false,...extra};
  board.items.push(item);
  return item;
}
const r1 = part("R1","std-r",3,{pinNets:{1:"/RESET"}});
const r2 = part("R2","test-r0805",8,{layer:"Bottom"});
part("R3","std-r",13,{excludeFromBOM:true});
part("R4","std-r",18);
function pad(id,x,layer,extra={}) {
  board.items.push({id,kind:"pad",layer,x,y:4,w:1.2,h:.8,shape:"rect",...extra});
}
function via(id,x,extra={}) {
  board.items.push({id,kind:"via",layer:"Multi",x,y:7,diameter:.65,drill:.3,...extra});
}
pad("bare-pad",2,"Top");
pad("plated-slot",5,"Multi",{drill:.6,slotLength:1.5,slotAngle:28,plated:true,net:"/RESET"});
pad("inner-pad",8,"Inner 1",{net:"/RESET/A"});
pad("literal-percent",12,"Top",{net:"/RESET%3BA"});
pad("illegal-semicolon",15,"Top",{net:"/RESET;A"});
via("unassigned-through-via",2);
via("open-through-via",5,{net:"/RESET",tent:{top:false,bottom:false}});
via("tent-top",8,{net:"/RESET",tent:{top:true,bottom:false}});
via("tent-bottom",11,{net:"/RESET",tent:{top:false,bottom:true}});
via("buried",14,{net:"/RESET",fromLayer:"Inner 1",toLayer:"Inner 2"});
via("backdrill",17,{net:"/RESET",tent:{top:false,bottom:false},backdrill:{from:"bottom",toLayer:"Inner 1",stubMax:.1,diameter:.5}});
via("bottom-blind",20,{net:"/RESET",tent:{bottom:false},fromLayer:"Inner 2",toLayer:"Bottom"});
const production = V.create(project,{name:"Production"});
const diagnostic = V.create(project,{name:"Diagnostic"});
V.setParts(project,diagnostic.id,[V.keyOf(r2)],{fitted:false});
V.setParts(project,diagnostic.id,[V.keyOf(r1)],{alternate:{value:"2k",params:{
  "Manufacturer Part Number":"RC0603-2K","Manufacturer":"Example Components"}}});
V.setActive(project,diagnostic.id);

// Capture the actual file contents just before packaging so the same checks can
// run under JavaScriptCore and the host's Node-based archive validator.
const data = G.AtriumODBData;
let files;
G.AtriumODBData = {...data,electrical(...args) {
  const writer = data.electrical(...args);
  return {...writer, write(out,root) {
    const stats = writer.write(out,root);
    files = out;
    return stats;
  }};
}};
G.AtriumODB.build(project,board.id,{origin:"absolute"});
const step = "steps/pcb/", records = path => files.get(step + path).trimEnd().split("\n");
const cad = records("netlists/cadnet/netlist"), eda = records("eda/data");
assert.deepEqual(cad.slice(0,2),["UNITS=MM","H optimize n"]);
const pointsHeader = cad.indexOf("# Netlist points");
assert.ok(pointsHeader > 2 && cad.slice(2,pointsHeader).every(row => row.startsWith("$")));
assert.ok(cad.slice(pointsHeader+1).length && cad.slice(pointsHeader+1).every(row => /^\d+ /.test(row)));
const netTable = new Map(cad.filter(row => row.startsWith("$")).map(row => row.slice(1).split(" ")));
assert.equal(netTable.get("0"),"$NONE$");
assert.deepEqual(eda.filter(row => row.startsWith("NET ")).map(row => row.slice(4)),[...netTable.values()]);
const points = cad.slice(pointsHeader+1).map(row => {
  const [net,r,x,y,side,end,exposure,...flags] = row.split(" ");
  return {net:netTable.get(net),r:Number(r),x:Number(x),y:Number(y),side,end,exposure,flags};
});
function at(x,y,expected) {
  const near = points.filter(p => Math.abs(p.x-x)<1e-5 && Math.abs(p.y+y)<1e-5);
  assert.equal(near.length,1,"One electrical contact at " + x + ", " + y);
  const {net,r,side,end,exposure,flags} = near[0];
  assert.deepEqual([net,r,side,end,exposure,flags.includes("v")],expected);
  return flags;
}
function layerFor(flags) {
  const id = flags.find(flag => flag.startsWith("ld="))?.slice(3);
  assert.ok(id,"Layer reference is required for this contact");
  const targets = [...files].filter(([path,text]) => path.startsWith(step+"layers/") && path.endsWith("/features") &&
    text.split("\n").includes("ID="+id));
  assert.equal(targets.length,1,"Layer reference resolves to one feature file in the current step");
  return targets[0][0];
}
at(2,4,["$NONE$",.002,"T","e","e",false]);
assert.ok(points.some(p => p.net==="$NONE$" && p.y===-12 && p.side==="D"),"Unassigned bottom component toes need CADNET points");
at(2.2,12,["/RESET",.002,"T","e","e",false]);
assert.match(layerFor(at(5,4,["/RESET",.3,"B","e","e",false])),/\/rout[^/]*\/features$/);
assert.match(layerFor(at(8,4,["/RESET/A",.002,"I","e","e",false])),/\/inner_1\/features$/);
at(12,4,["/RESET%3BA",.002,"T","e","e",false]);
at(15,4,["/RESET%3BA_2",.002,"T","e","e",false]);
assert.match(layerFor(at(2,7,["$NONE$",.15,"B","m","c",true])),/\/drill[^/]*\/features$/);
at(5,7,["/RESET",.15,"B","m","e",true]);
at(8,7,["/RESET",.15,"B","m","p",true]);
at(11,7,["/RESET",.15,"B","m","s",true]);
assert.ok(!points.some(p => p.x===14 && p.y===-7),"A buried via has no CADNET probe contact");
const drilledVias = eda.join("\n").match(/^SNT VIA\n(?:FID C .*\n)*FID H /gm);
assert.equal(drilledVias?.length,7,
  "Buried and unassigned vias both remain in EDA connectivity");
at(17,7,["/RESET",.15,"T","m","e",true]);
at(20,7,["/RESET",.15,"D","m","e",true]);

function bomFor(index,variant) {
  const rows = records("boms/v"+index+"_"+variant.toLowerCase()+"/bom");
  const section = (first,last) => rows.slice(rows.indexOf(first)+1,rows.indexOf(last));
  const refRows = section("RD_CPN","RD_CPN_END"), refs = new Map();
  for (let i=0;i<refRows.length;i+=2) refs.set(refRows[i].slice(4),refRows[i+1].slice(4));
  const parts = new Map();
  for (const row of section("CP","CP_END")) {
    const [key,value] = [row.slice(0,3),row.slice(4)];
    if (key==="CPN") parts.set(value,{});
    if (key==="PKG" || key==="QNT") [...parts.values()].at(-1)[key]=value;
  }
  return {refs, parts, manufacturer:section("CPN_MPN","CPN_MN_END")};
}
const prod = bomFor(1,production.name);
assert.deepEqual([...prod.refs.keys()],["R1","R4","R2"]);
assert.equal(prod.refs.get("R1"),prod.refs.get("R4"));
assert.deepEqual(prod.parts.get(prod.refs.get("R1")),{PKG:"R_0603",QNT:"2"});
assert.deepEqual(prod.parts.get(prod.refs.get("R2")),{PKG:"R_0805",QNT:"1"});
const diag = bomFor(2,diagnostic.name);
assert.deepEqual([...diag.refs.keys()],["R1","R4"]);
assert.deepEqual(diag.manufacturer,["CPN "+diag.refs.get("R1"),"MPN RC0603-2K","VND Example Components","QLF 0","CHS 1"]);
assert.deepEqual(diag.parts.get(diag.refs.get("R1")),{PKG:"R_0603",QNT:"1"});
assert.ok(records("layers/comp_+_top/components").some(row => /^CMP .* R1 RC0603-2K /.test(row)),"The active variant writes the selected manufacturer part number");
assert.ok(records("layers/comp_+_top/components").some(row => /^CMP .* R3 /.test(row)),"Excluded parts retain CAD placement");
assert.ok(records("layers/comp_+_bot/components").some(row => /^CMP .* R2 .* ;0(?:,|$)/.test(row)),"The active variant marks an unfitted component");
assert.ok(records("attrlist").includes(".current_variant=v2_diagnostic"));
console.log("ODB++ CAD netlist and variant BOM conformance checks passed.");
