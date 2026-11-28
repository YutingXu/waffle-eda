"use strict";

// Run with Node 18+. Pass --fixtures DIRECTORY to include the external binary interoperability suite.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const python = process.env.WAFFLE_PYTHON || (process.platform === "win32" ? "python" : "python3");
const prepared = spawnSync(python, ["-B", path.join(__dirname, "../scripts/prepare-assets.py")], {stdio: "inherit"});
if (prepared.error) throw prepared.error;
if (prepared.status !== 0) process.exit(prepared.status ?? 1);

require("../app/core/model.js");
require("../app/library/parts.js");
const {nativeRoundTrip}=require("./support/native-cad.cjs");
const A = globalThis.Atrium;
const fixturesAt = process.argv.indexOf("--fixtures");
const fixtures = fixturesAt >= 0 ? process.argv[fixturesAt + 1] : null;
if (fixturesAt >= 0 && !fixtures) throw Error("--fixtures requires a directory");

const cases = [];
const test = (name, run) => cases.push({ name, run });

test("project precision matches decimal rounding and skips conversion on the nanometre grid", () => {
  const decimal = n => Number.isInteger(n) || !(Math.abs(n) < 1e9) ? n : Number(n.toPrecision(12));
  const values = [-0, NaN, -Infinity, Infinity, Number.MIN_VALUE, 1e9, 999999999.9876543, 999999.999999, 1e6, 1e6 + 0.000001];
  const view = new DataView(new ArrayBuffer(8));
  for (const n of [0.000001, 0.00001, 0.0254, 0.254, 1.234567, 999999.999999, 1e6, 1e9]) {
    view.setFloat64(0, n);
    const bits = view.getBigUint64(0);
    for (const delta of [-1n, 0n, 1n]) {
      view.setBigUint64(0, bits + delta);
      const adjacent = view.getFloat64(0);
      values.push(adjacent, -adjacent);
    }
  }
  for (const n of values) assert.ok(Object.is(A.projectNumber(n), decimal(n)), String(n));

  const original = Number.prototype.toPrecision;
  let conversions = 0;
  try {
    Number.prototype.toPrecision = function (digits) { conversions++; return original.call(this, digits); };
    for (const n of [0.000001, -0.0254, 0.254, -2.54, 999999.999999]) assert.equal(A.projectNumber(n), n);
  } finally { Number.prototype.toPrecision = original; }
  assert.equal(conversions, 0, "grid coordinates already have at most twelve significant digits");
});
const defsFor = p => new Map(p.library.map(d => [d.id, d]));
const byName = (doc, name) => doc.items.find(i => i.ref === name);
const count = (list, kind) => list.filter(i => i.kind === kind).length;
const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-6, a + " differs from " + b);

test("the sample persists every document and pin assignment through native project records", () => {
  const project = AtriumParts.example();
  const loaded = A.validate(nativeRoundTrip(project));
  assert.deepEqual(nativeRoundTrip(loaded),loaded);
  assert.deepEqual(loaded.documents.map(d => d.kind), ["schematic", "pcb"]);
  const [sch, pcb] = loaded.documents;
  assert.deepEqual(byName(pcb,"U1").pinNets, {"1":"BUF","2":"GND","3":"FILTER","4":"BUF","5":"VDD"});
  const nets = A.connectivity(sch, defsFor(loaded));
  assert.deepEqual(nets.nets.map(n => n.name).sort(), ["BUF","FILTER","GND","VDD","VIN","VOUT"]);
  assert.equal(nets.nets.filter(n => n.conflict).length, 0);
  for(const part of pcb.items.filter(i => i.kind === "part")){
    const partner = sch.items.find(i => i.kind === "part" && i.link === part.link);
    assert.ok(partner);
    for(const [pin, net] of Object.entries(part.pinNets)) assert.equal(net, nets.byPin.get(partner.id + "/" + pin));
  }
});

test("wire crossings, explicit junctions, T connections and conflicting names", () => {
  const doc = A.sheet("schematic", "Connectivity");
  const wire = (net,points) => ({id:A.id(),kind:"wire",net,points});
  doc.items.push(wire("H",[[-5,0],[5,0]]), wire("V",[[0,-5],[0,5]]));
  let result = A.connectivity(doc,new Map());
  assert.equal(result.nets.length,2);
  doc.items.push({id:A.id(),kind:"junction",x:0,y:0});
  result = A.connectivity(doc,new Map());
  assert.equal(result.nets.length,1);
  assert.equal(result.nets[0].conflict,true);
  doc.items.pop();
  doc.items[1].points[0] = [0,0];
  result = A.connectivity(doc,new Map());
  assert.equal(result.nets.length,1);
});

test("moving and rotating a schematic part keeps wire terminals attached", () => {
  const d = AtriumParts.catalogue.find(d => d.prefix === "R");
  const doc = A.sheet("schematic","Movement");
  const project = A.project("Movement",[d]);
  const item = A.instantiate(project,d,[0,0]); doc.items.push(item);
  const [left,right] = A.pins(item,d,"schematic");
  const w1 = {id:A.id(),kind:"wire",points:[[-20,0],left.at],net:"A"};
  const w2 = {id:A.id(),kind:"wire",points:[right.at,[20,0]],net:"B"};
  doc.items.push(w1,w2);
  A.transformPart(doc,item,d,{x:5.08,y:2.54,angle:90});
  const [p1,p2] = A.pins(item,d,"schematic");
  assert.ok(A.same(w1.points.at(-1),p1.at));
  assert.ok(A.same(w2.points[0],p2.at));
  const r = A.connectivity(doc,new Map([[d.id,d]]));
  assert.equal(r.byPin.get(item.id+"/1"),"A");
  assert.equal(r.byPin.get(item.id+"/2"),"B");
});

test("unsupported project versions and missing part definitions fail on load", () => {
  const p = AtriumParts.example();
  assert.throws(() => A.validate({...p,version:42}));
  p.library = p.library.slice(1);
  assert.throws(() => A.validate(p));
});

test("diagonal routing has one diagonal and one orthogonal leg in every quadrant", () => {
  for (const end of [[2,8],[-2,8],[-8,-3],[8,-3],[4,4],[4,0]]) {
    const route = A.pathBetween([0,0],end,true);
    assert.ok(A.same(route[0],[0,0]) && A.same(route.at(-1),end));
    for(let i=1;i<route.length;i++){
      const dx = Math.abs(route[i][0]-route[i-1][0]), dy=Math.abs(route[i][1]-route[i-1][1]);
      assert.ok((dx || dy) && (dx===dy || dx===0 || dy===0));
    }
  }
});

function sourceFixture(file,sha) {
  const bytes = fs.readFileSync(path.join(fixtures,file));
  const found = crypto.createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
  assert.equal(found,sha,"unexpected source revision of "+file);
  return bytes;
}

async function main(){
  for(const {name,run} of cases){
    try { await run(); console.log("PASS " + name); }
    catch (error) { console.error("FAIL "+name+"\n"+error.stack); process.exitCode=1; }
  }
  if(!process.exitCode) console.log(cases.length+" checks passed");
}

globalThis.CFB = require("../app/vendor/cfb.min.js");
require("../app/formats/sch-import.js"); require("../app/formats/pcb-import.js"); require("../app/formats/io.js");

test("the file opener accepts Altium ASCII schematics and rejects unrelated documents", () => {
  const bytes = new TextEncoder().encode("|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0\r\n|RECORD=31\r\n|RECORD=27|LocationCount=2|X1=10|Y1=12|X2=20|Y2=12\r\n");
  const result = AtriumIO.read("test.SchDoc",bytes);
  const [wire] = result.documents[0].items;
  assert.equal(wire.kind,"wire"); close(wire.points[0][0],2.54); close(wire.points[0][1],-3.048);
  assert.throws(()=>AtriumIO.read("broken.SchDoc",new TextEncoder().encode("garbage")));
  assert.throws(()=>AtriumIO.read("image.png",bytes));
});

test("two unnamed Altium ports do not join unrelated wires", () => {
  const file=["|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0","|RECORD=31",
    "|RECORD=27|LocationCount=2|X1=10|Y1=10|X2=20|Y2=10",
    "|RECORD=27|LocationCount=2|X1=10|Y1=30|X2=20|Y2=30",
    "|RECORD=18|LOCATION.X=10|LOCATION.Y=10|WIDTH=10",
    "|RECORD=18|LOCATION.X=10|LOCATION.Y=30|WIDTH=10|NAME=  "].join("\r\n");
  const result=AtriumIO.read("ports.SchDoc",new TextEncoder().encode(file)),doc=result.documents[0];
  assert.equal(count(doc.items,"netlabel"),0);
  assert.equal(count(doc.items,"wire"),2);
  assert.equal(A.connectivity(doc,new Map()).nets.length,2);
  assert.ok(doc.notes.some(note=>note.includes("2 × unnamed ports")));
});

test("ASCII PCB copper retains dimensions, layer and assigned net", () => {
  const bytes = new TextEncoder().encode("|RECORD=Board|VX0=0mil|VY0=0mil|VX1=300mil|VY1=0mil|VX2=300mil|VY2=300mil\r\n|RECORD=Net|ID=0|NAME=SIGNAL\r\n|RECORD=Track|LAYER=BOTTOM|NET=0|X1=100mil|Y1=200mil|X2=300mil|Y2=200mil|WIDTH=10mil\r\n");
  const result = AtriumIO.read("test.PcbDoc",bytes);
  const t = result.documents[0].items.find(i=>i.kind==="track");
  assert.equal(t.net,"SIGNAL");assert.equal(t.layer,"Bottom");close(t.width,0.254);
  close(t.points[0][0],2.54);close(t.points[0][1],-5.08);
});

test("Project History summarises Altium revisions with a net identifier scope", async () => {
  const vm = require("node:vm");
  const workerDir = path.join(__dirname, "../app/workers");
  const worker = vm.createContext({TextDecoder, TextEncoder, atob, btoa, crypto: crypto.webcrypto});
  worker.self = worker;
  worker.importScripts = (...names) => {
    for (const name of names) {
      const filename = path.resolve(workerDir, name);
      vm.runInContext(fs.readFileSync(filename, "utf8"), worker, {filename});
    }
  };
  worker.importScripts("diff-worker.js");

  function revision(wireEnd) {
    const manifest = "[Design]\r\nHierarchyMode=3\r\n[Document1]\r\nDocumentPath=Main.SchDoc\r\n";
    const sheet = [
      "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0",
      "|RECORD=31",
      "|RECORD=27|LocationCount=2|X1=10|Y1=12|X2=" + wireEnd + "|Y2=12"
    ].join("\r\n");
    return {
      blob: crypto.createHash("sha256").update(manifest).update(sheet).digest("hex"),
      files: [
        {name: "Design.PrjPcb", data: Buffer.from(manifest).toString("base64")},
        {name: "Main.SchDoc", data: Buffer.from(sheet).toString("base64")}
      ]
    };
  }

  let reply;
  worker.postMessage = message => { reply = message; };
  await worker.onmessage({data: {history: true, sources: true, before: revision(20), after: revision(30)}});
  assert.ok(reply?.result, reply?.error || "The History worker did not return a summary");
  assert.ok(reply.result.regions.some(region => region.kind === "schematic" && region.name === "Main"));
  assert.ok(reply.result.objects.some(change => change.kind.startsWith("wire.")));
});

if(fixtures){
  function read(file,sha){
    const {reopenAltium}=require("./support/altium-folder.cjs");
    const bytes=sourceFixture(file,sha), original={name:file,bytes}, r=AtriumIO.read(file,bytes), p=A.project("Imported",r.library);
    if(r.documents.length)p.documents = r.documents;
    const saved=reopenAltium(p,original), again=reopenAltium(saved.project,original,saved.entry);
    assert.deepEqual(again.files,saved.files,"every native document and library record survives a second save");
    return {...r,documents:saved.project.documents,library:saved.project.library};
  }
  test("binary Level Shifter sheet retains its five designators, 20 wires and 7 junctions", () => {
    const [doc] = read("Level.Shifter.SchDoc","fb4c05d083648a8d092d8aa0b876e705957d3e89").documents;
    assert.deepEqual(doc.items.filter(i=>i.kind==="part").map(i=>i.ref).sort(),["C17","C18","C19","C20","IC5"]);
    assert.equal(count(doc.items,"wire"),20);assert.equal(count(doc.items,"junction"),7);
  });
  test("binary PE42442 library retains 25 numbered pins and RF/power names", () => {
    const [d] = read("PE42442.SchLib","589e8fc6e00c56693f95b5d259a112297a9a026f").library;
    const p = new Map(d.symbol.pins.map(p=>[p.number,p.name]));
    assert.equal(p.size,25);assert.equal(p.get("16"),"VDD");assert.equal(p.get("22"),"RFC");assert.equal(p.get("14"),"RF1");
  });
  test("binary PCB panel keeps four individually editable one-pad fiducials", () => {
    const r = read("Panel.PcbDoc","eab999a2ea68b7ceb5b95c58ccbed832b90579bb");
    const parts = r.documents[0].items.filter(i=>i.kind==="part");
    assert.equal(parts.length,4);
    for(const i of parts){const def=r.library.find(d=>d.id===i.def);assert.equal(def.name,"Fiducial-1mm");assert.equal(def.footprint.pads.length,1);}
    assert.ok(r.notes.length);
  });
  test("binary QFN footprint preserves its numbered lands and embedded thermal drills", () => {
    const [def] = read("QFN24.PcbLib","389d92e7d132960dc9937bff3b1c8981fa6031a5").library;
    const pads=def.footprint.pads;
    const numbered=new Set(pads.filter(p=>p.number).map(p=>p.number));
    for(let n=1;n<=24;n++)assert.ok(numbered.has(String(n)),"missing pad "+n);
    assert.equal(pads.filter(p=>p.drill>0).length,4);assert.equal(pads.length,29);
  });
  test("KiCad issue 13750 binary board preserves a 29.21 mm board and four mechanical edges", () => {
    const r = read("Routing.PcbDoc","61d27420cdc5918fbf19b4c8a8a172af8ba3bc6a"), d=r.documents[0];
    const [x0,y0,x1,y1]=A.bounds(d.outline);close(x1-x0,29.21);close(y1-y0,29.21);
    const edges = d.items.filter(i=>i.layer==="Mechanical 1");
    assert.equal(edges.length,4);for(const e of edges)close(e.width,0.254);
    assert.ok(r.notes.some(n=>/region/i.test(n)));
  });
}
main();
