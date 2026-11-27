"use strict";
// AtriumAPI v1 and headless scripting. Runs in Node (node tests/core/atrium-api.cjs)
// and under JavaScriptCore with a CommonJS shim.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/core/spatial.js");require("../../app/checks/altium-rules.js");
require("../../app/checks/rules.js");require("../../app/checks/connectivity.js");require("../../app/core/zip.js");require("../../app/formats/bom.js");require("../../app/pcb/length-tuning.js");
require("../../app/automation/proposal.js");require("../../app/core/atrium-api.js");require("../../app/automation/scripting.js");
const A=Atrium,API=AtriumAPI,S=AtriumScripting;
const base=AtriumParts.example(),board=base.documents.find(d=>d.kind==="pcb"),sheet=base.documents.find(d=>d.kind==="schematic");
const ref=(p,doc,r)=>p.documents.find(d=>d.id===doc.id).items.find(i=>i.ref===r);
const frozen=JSON.stringify(base);

// ------------------------------------------------------------------ reads
let h=API.headless(A.clone(base),{extension:{id:"script",permissions:{...API.SCRIPT_PERMISSIONS,"ui:command":true}}}),api=h.api;
assert.equal(api.version,1);
const info=api.project.info();
assert.equal(info.documents.length,2);assert.equal(info.activeDocument,board.id,"a PCB is active by default");assert.equal(info.apiVersion,1);
const parts=api.items.list({kind:"part",fields:["ref"]});
assert.equal(parts.length,7);assert.deepEqual(Object.keys(parts[0]),["ref"],"fields project the copy");
assert.equal(api.items.list({doc:sheet.id,kind:"wire"}).length,7);
assert.equal(api.items.count({kinds:["track","via"]}),21);
assert.equal(api.items.list({kind:"part",limit:2,offset:1}).length,2);
const track=board.items.find(i=>i.kind==="track");
assert.equal(api.items.get(track.id).document,board.id);
assert.equal(api.items.list({where:{net:"VIN"},kind:"track"}).length,board.items.filter(i=>i.kind==="track"&&i.net==="VIN").length);
// Reads are copies: mutating them never reaches the project.
const copy=api.items.get(track.id);copy.points[0][0]=999;copy.net="HACK";
assert.equal(h.project.documents[1].items.find(i=>i.id===track.id).net,track.net);
assert.notEqual(api.items.get(track.id).points[0][0],999);
const nets=api.nets.list();
assert.ok(nets.some(n=>n.name==="GND"&&n.objects>3));
assert.ok(api.nets.list({doc:sheet.id}).some(n=>n.name==="FILTER"));
assert.ok(api.nets.items("VIN",{fields:["id","kind"]}).some(i=>i.kind==="track"));
const u1=ref(base,board,"U1"),pins=api.parts.pins(u1.id);
assert.equal(pins.length,5);assert.ok(pins.every(p=>Number.isFinite(p.x)&&typeof p.net==="string"));
assert.equal(pins.find(p=>p.number==="2").net,"GND");
const near=api.query.spatial([3.5,10.7,4.1,11.3],{fields:["id","kind","ref"]});
assert.ok(near.some(i=>i.ref==="J1"));assert.ok(near.some(i=>i.kind==="track"));
assert.ok(!near.some(i=>i.ref==="J2"),"far objects are excluded");
assert.deepEqual(api.query.spatial([500,500,501,501]),[]);
assert.throws(()=>api.query.spatial([0,0,1]),/expects/);
assert.ok(api.layers.list().copper.includes("Top"));
api.selection.set([u1.id]);assert.deepEqual(api.selection.get(),[u1.id]);
assert.equal(api.selection.items({fields:["ref"]})[0].ref,"U1");
assert.equal(api.units.get(),"mm");
assert.ok(Math.abs(api.units.parse("10mil")-0.254)<1e-9);assert.equal(api.units.format(0.254,"mil"),"10 mil");
assert.equal(api.units.format(0.254,"th"),"10 mil");
assert.equal(api.units.parse(api.units.format(0.254,"mil")),0.254);
assert.equal(Atrium.units.format(20.7,"mm",2,{fixed:true}),"20.70 mm");
assert.equal(Atrium.units.format(22,"mm"),"22 mm");
assert.equal(Atrium.units.parse("22mm"),22);
assert.equal(Atrium.units.parse("22 mm"),22);
assert.ok(api.geometry.pointInPolygon([5,5],board.outline));assert.ok(!api.geometry.pointInPolygon([50,5],board.outline));
assert.equal(api.geometry.length([[0,0],[3,4],[3,10]]),11);
assert.equal(api.defs.list().length,base.library.length);assert.equal(api.defs.get(u1.def).id,u1.def);
assert.equal(api.documents.active().id,board.id);api.documents.activate(sheet.id);assert.equal(api.documents.active().kind,"schematic");api.documents.activate(board.id);
assert.throws(()=>api.documents.get("missing"),/Unknown document/);

// ---------------------------------------------------------------- netlist
const nl=api.project.netlist();
assert.equal(nl.components.length,7);assert.ok(nl.components.every(c=>c.pins.every(p=>p.net)));
assert.ok(nl.nets.find(n=>n.name==="FILTER").pins.includes("R1.2"));
const spice=api.project.netlist({format:"spice"}).text;
assert.match(spice,/^\* /);assert.match(spice,/\n\.end\n$/);assert.match(spice,/^R1 VIN FILTER \S+$/m);
assert.ok(!/GND/.test(spice.split("\n").filter(l=>/^C\d/.test(l)).join(" ")),"ground nets become node 0");
assert.throws(()=>api.project.netlist({format:"edif"}),/json and spice/);
assert.match(spice,/^C1 FILTER 0 10n$/m,"unit letters are dropped: SPICE reads F as femto");

// A small, repeated board move produces the full-diff oracle in document/item order.
{
  const p=A.clone(base), d=p.documents.find(d=>d.kind==="pcb"), tracks=d.items.filter(i=>i.kind==="track").slice(0,2);
  const scratch=A.clone(p), ops=[tracks[1],tracks[0],tracks[1]].map(i=>({op:"move",id:i.id,dx:2,dy:1}));
  API.applyOps(scratch,ops,d.id);
  const oracle=AtriumProposal.build(p,scratch,{allowV1:false}).proposal.ops;
  let reviewed;
  const host=API.headless(p,{approve:({proposal})=>{reviewed=proposal.ops;return true;}});
  const draft=host.api.proposals.draft("transaction",{ops});
  assert.equal(host.steps.length,0);assert.equal(host.api.proposals.review(draft.handle).applied,oracle.length);
  assert.deepEqual(reviewed,oracle);assert.deepEqual(host.project,scratch);assert.equal(host.steps.length,1);
}
// ------------------------------------------------------------ transactions
let r=api.transaction("Add via",tx=>{tx.add({kind:"via",x:5,y:5,diameter:.6,drill:.3,layer:"Multi",net:"GND"});});
assert.equal(r.applied,1);assert.equal(r.added.length,1);assert.equal(h.steps.length,1);
const viaId=r.added[0];
assert.equal(h.project.documents.find(d=>d.id===board.id).items.find(i=>i.id===viaId).net,"GND");
const r1=ref(base,board,"R1");
r=api.transaction("Several",tx=>{tx.update(r1.id,{ref:"R10",value:"22k"});tx.move(track.id,1,0);tx.remove(viaId);tx.select([r1.id]);return "done";});
assert.ok(r.applied>=3);assert.equal(r.result,"done");assert.equal(h.steps.length,2,"one transaction is one step");
assert.equal(ref(h.project,board,"R10").value,"22k");assert.equal(api.items.get(track.id).points[0][0],track.points[0][0]+1);
assert.equal(api.items.get(viaId),null);assert.deepEqual(api.selection.get(),[r1.id]);
assert.equal(api.transaction("Nothing",()=>42).applied,0);assert.equal(h.steps.length,2);
// Updating with null deletes a field; moving a schematic part drags its wires.
api.transaction("Clear value",tx=>tx.update(r1.id,{value:""}));
const sr1=ref(base,sheet,"R1");
api.transaction("Move schematic part",tx=>tx.move(sr1.id,2.54,0));
assert.equal(api.items.get(sr1.id).x,sr1.x+2.54);

// ------------------------------------------------- validation rejects bad edits
const bad=[
  [tx=>tx.add({kind:"blob",x:0,y:0}),/unknown object kind/],
  [tx=>tx.add({kind:"track",points:[[0,0]],width:.2,layer:"Top"}),/not valid/],
  [tx=>tx.update(track.id,{id:"other"}),/cannot change/],
  [tx=>tx.update(track.id,{width:NaN}),/plain JSON/],
  [tx=>tx.update(track.id,{points:[[0,0],["a",1]]}),/not valid/],
  [tx=>tx.add({kind:"part",def:"missing-def",ref:"X1",value:"",x:0,y:0}),/not valid/],
  [tx=>tx.remove("missing-id"),/does not exist/],
  [tx=>tx.setDocument(board.id,{grid:-1}),/invalid grid/],
  [tx=>tx.setDocument(board.id,{kind:"schematic"}),/cannot be set/],
  [tx=>tx.add({kind:"via",id:track.id,x:0,y:0,diameter:.5}),/already used/],
  [tx=>tx.add({kind:"via",x:0,y:0,diameter:-1}),/not valid/],
  [tx=>{tx.update(r1.id,{ref:"R99"});tx.add({kind:"via",x:0,y:0,diameter:0});},/not valid/]
];
const before=JSON.stringify(h.project),steps=h.steps.length;
for(const [fn,re] of bad){assert.throws(()=>api.transaction("Bad",fn),re);assert.equal(JSON.stringify(h.project),before,"a rejected transaction leaves no trace");}
assert.equal(h.steps.length,steps);
assert.ok(!ref(h.project,board,"R99"),"earlier operations in a rejected transaction roll back");
// applyOps alone validates the whole project at the end.
const direct=A.clone(base);
assert.throws(()=>API.applyOps(direct,[{op:"teleport"}],board.id),/unknown operation/);
assert.deepEqual(API.applyOps(A.clone(base),[{op:"add",doc:board.id,item:{id:"v1",kind:"via",x:1,y:1,diameter:.5}}],board.id),{added:["v1"],removed:0});

// ------------------------------------------------------------- permissions
const roHost=API.headless(A.clone(base),{extension:{id:"ro.ext",permissions:{"read:project":true}}}),readOnly=roHost.api;
assert.ok(readOnly.items.list().length);
const untouched=JSON.stringify(roHost.project);
assert.throws(()=>readOnly.transaction("x",tx=>tx.remove(track.id)),/propose:edits or write:edits/,"an edit without permission is refused");
assert.throws(()=>readOnly.proposals.submit({format:"atrium-ai",version:2,ops:[]}),/propose:edits or write:edits/);
assert.throws(()=>readOnly.pour(),/propose:edits or write:edits/);
assert.equal(JSON.stringify(roHost.project),untouched);
assert.throws(()=>readOnly.files.export("a.txt","x"),/outputs:write/);
assert.throws(()=>readOnly.ui.setPanel("p",{}),/ui:panel/);assert.throws(()=>readOnly.commands.register("a.b",()=>1),/ui:command/);
assert.throws(()=>readOnly.selection.set([]),/ui:panel or ui:command/);
const blind=API.headless(A.clone(base),{extension:{id:"no.ext",permissions:{}}}).api;
assert.throws(()=>blind.items.list(),/read:project/);assert.throws(()=>blind.events.on("selectionChanged",()=>{}),/read:project/);
// Revocation is immediate: the host edits the live permission object.
const grants={"read:project":true},revocable=API.headless(A.clone(base),{extension:{id:"rv.ext",permissions:grants}}).api;
assert.ok(revocable.items.count()>0);delete grants["read:project"];assert.throws(()=>revocable.items.count(),/read:project/);
// propose:edits alone, headless: the change comes back as a proposal and nothing is applied.
const pHost=API.headless(A.clone(base),{extension:{id:"p.ext",permissions:{"read:project":true,"propose:edits":true}}});
const pr=pHost.api.transaction("Proposed",tx=>tx.update(track.id,{width:.9}));
assert.equal(pr.applied,0);assert.equal(pr.proposal.version,2);assert.equal(pHost.steps.length,0);
assert.equal(pHost.project.documents[1].items.find(i=>i.id===track.id).width,track.width);

// ------------------------------------------------- guarded proposals (untrusted input)
const ph=API.headless(A.clone(base)),live=()=>ph.project.documents.find(d=>d.id===board.id);
const draft=A.clone(ph.project);draft.documents[1].items.find(i=>i.id===track.id).width=.75;
const {proposal}=AtriumProposal.build(ph.project,draft,{allowV1:false});
assert.ok(ph.api.proposals.submit(proposal,"Widen").applied>0);
assert.equal(live().items.find(i=>i.id===track.id).width,.75);assert.equal(ph.steps.length,1);
assert.throws(()=>ph.api.proposals.submit(proposal),/changed since this proposal was drafted/,"a stale proposal guard is rejected");
ph.api.transaction("User edit",tx=>tx.update(track.id,{width:.5}));
const draft2=A.clone(ph.project);draft2.documents[1].items.find(i=>i.id===track.id).width=.6;
const later=AtriumProposal.build(ph.project,draft2,{allowV1:false}).proposal;
ph.api.transaction("Concurrent edit",tx=>tx.update(track.id,{width:.4}));
assert.throws(()=>ph.api.proposals.submit(later),/changed since/,"an edit that raced the proposal is refused");
const bad1=A.clone(ph.project);bad1.documents[1].items.find(i=>i.id===track.id).points=[[0,0]];
assert.throws(()=>ph.api.proposals.submit(AtriumProposal.build(ph.project,bad1,{allowV1:false}).proposal),/invalid/,"proposals must leave a valid project");
assert.throws(()=>ph.api.proposals.submit({format:"atrium-ai",version:2,project:base.name,ops:[{op:"set",target:"item",document:board.id,id:track.id,path:["__proto__"],after:1}]}),/path|invalid/);
assert.throws(()=>ph.api.proposals.submit({format:"atrium-ai",version:2,project:base.name,ops:[{op:"set",target:"project",path:["documents"],after:[]}]}),/protected/);
assert.throws(()=>ph.api.proposals.submit({version:1}),/version 2/);
assert.throws(()=>ph.api.proposals.submit({format:"atrium-ai",version:2,project:"Other",ops:[{op:"set",target:"project",path:["name"],after:"x"}]}),/another project/);
assert.equal(live().items.find(i=>i.id===track.id).width,.4);

// ------------------------------------------------------- paged reads
const big=A.clone(base);big.documents[1].items=Array.from({length:API.MAX_ITEMS+1},(_,n)=>({id:"v"+n,kind:"via",x:n%100,y:Math.floor(n/100),diameter:.5}));
const bh=API.headless(big).api;
assert.throws(()=>bh.items.list({fields:["id"]}),/limit and offset/,"large reads must page");
assert.equal(bh.items.count(),API.MAX_ITEMS+1);assert.equal(bh.items.list({limit:500,offset:API.MAX_ITEMS-100,fields:["id"]}).length,101);
assert.equal(blind.units.get(),"mm","unprivileged methods still work");

// ------------------------------------------------- commands, events, storage
const reg=api.commands.register("test.echo",(a,b)=>[b,a],{title:"Echo"});
assert.deepEqual(api.commands.execute("test.echo",1,2),[2,1]);
assert.deepEqual(h.call("commands.execute",["test.echo",[3,4]]),[4,3],"the registry routes to in-process handlers");
assert.ok(api.commands.list().some(c=>c.id==="waffle.undo"));assert.ok(api.commands.list().some(c=>c.id==="test.echo"&&c.owner==="script"));
assert.throws(()=>api.commands.execute("waffle.save"),/not available to extensions/,"editing built-ins bypass proposals and are refused");
assert.throws(()=>api.commands.execute("waffle.fit"),/headless/);
assert.throws(()=>api.commands.execute("nope.nothing"),/Unknown command/);
assert.throws(()=>api.commands.register("bad id",()=>{}),/letters/);
reg.dispose();assert.ok(!api.commands.list().some(c=>c.id==="test.echo"));
const seen=[];const sub=api.events.on("documentChanged",e=>seen.push(e));
h.registry.emit("documentChanged",{revision:7});sub.dispose();h.registry.emit("documentChanged",{revision:8});
assert.deepEqual(seen,[{revision:7}]);
api.storage.set("k",{a:[1,2]});assert.deepEqual(api.storage.get("k"),{a:[1,2]});assert.deepEqual(api.storage.keys(),["k"]);
assert.throws(()=>api.storage.set("f",()=>1),/JSON/);assert.throws(()=>api.storage.set("big","x".repeat(300000)),/256 KB/);
api.storage.delete("k");assert.equal(api.storage.get("k"),null);
assert.equal(api.ui.showMessage("hello"),true,"UI calls degrade to no-ops headless");
assert.equal(api.ui.showInputBox({value:"d"}),"d");

// ---------------------------------------------------------- feature modules
const features=api.features();
for(const f of ["bom","drc","connectivity","rules","length"])assert.ok(features.includes(f),f+" is detected");
assert.ok(!features.includes("route"),"absent modules are not advertised");
assert.throws(()=>api.route(),/unavailable/);
const drc=api.drc();assert.ok(Array.isArray(drc.violations));assert.ok(Number.isFinite(drc.total));
assert.ok(api.bom().rows.length>0);
assert.equal(api.rules.query("clearance",{net:"GND",layer:"Top"}).gap,.2);
assert.ok(api.query.connectivity().nets.some(n=>n.name==="GND"));
assert.ok(api.query.connectivity({doc:sheet.id}).nets.length>0);
const lengths=api.length();assert.ok(lengths.some(e=>e.net==="VIN"&&e.length>0));
assert.ok(lengths.every(e=>!("segments" in e)&&e.segmentCount>=0),"segment detail is dropped unless requested");
assert.ok(api.length({segments:true,nets:["VIN"]})[0].segments.length>0);assert.equal(api.length({nets:["VIN"]}).length,1);
assert.ok(API.describe().some(m=>m.method==="items.list"&&m.permission==="read:project"));
assert.ok(API.describe().some(m=>m.method==="transaction.commit"&&m.permission==="edit"));

// ------------------------------------------------------------ runHeadless
assert.equal(JSON.stringify(base),frozen,"the fixture is untouched");
const done=(async()=>{
  const renumber=`
    const parts = await api.items.list({kind: "part", fields: ["id", "ref", "x"]});
    const caps = parts.filter(p => p.ref.startsWith("C")).sort((a, b) => b.x - a.x);
    console.log("caps", caps.length);
    await api.transaction("Reverse caps", tx => caps.forEach((p, n) => tx.update(p.id, {ref: "C" + (n + 1)})));
    await api.transaction("Tag", tx => tx.update(caps[0].id, {value: "tagged"}));
    return {count: caps.length, first: caps[0].ref};`;
  let out=await S.runHeadless(base,renumber,{timeoutMs:2000});
  assert.equal(out.ok,true,out.error?.message);assert.deepEqual(out.result,{count:2,first:"C2"});
  assert.equal(out.transactions,2);assert.deepEqual(out.log.find(l=>l.level==="info"),{level:"info",text:"caps 2"});
  assert.equal(ref(out.project,board,"C1").x,19.4,"the right-most capacitor is C1 now");
  assert.equal(ref(out.project,board,"C1").value,"tagged");
  assert.equal(JSON.stringify(base),frozen,"runHeadless never mutates its input");
  A.validate(out.project);

  out=await S.runHeadless(JSON.stringify(base),"return (await api.project.info()).name");
  assert.equal(out.result,base.name,"project JSON text is accepted");
  out=await S.runHeadless(base,"const x = 1;\nnull.boom;");
  assert.equal(out.ok,false);assert.match(out.error.message,/null/);assert.equal(out.project.documents.length,2);
  out=await S.runHeadless(base,`await api.transaction("ok", tx => tx.update(${JSON.stringify(track.id)}, {width: .5}));
    await api.transaction("bad", tx => tx.add({kind: "track", points: [[0, 0]]}));`);
  assert.equal(out.ok,false);assert.match(out.error.message,/not valid/);
  assert.equal(out.transactions,1,"the earlier transaction stays applied in the returned copy");
  assert.equal(out.project.documents[1].items.find(i=>i.id===track.id).width,.5);
  out=await S.runHeadless(base,"return [typeof Atrium, typeof AtriumAPI, typeof globalThis, typeof require, typeof api, typeof args]",{args:{a:1}});
  assert.deepEqual(out.result,["undefined","undefined","undefined","undefined","object","object"],"application globals are out of scope");
  out=await S.runHeadless(base,"for (;;) await api.items.count();",{timeoutMs:30});
  assert.equal(out.ok,false);assert.match(out.error.message,/time limit/);
  out=await S.runHeadless(base,"return api.transaction(tx => tx.remove("+JSON.stringify(track.id)+"))",{write:false});
  assert.equal(out.ok,false);assert.match(out.error.message,/propose:edits or write:edits/);
  out=await S.runHeadless({format:"nope"},"return 1");
  assert.equal(out.ok,false);assert.equal(out.project,null);
  out=await S.runHeadless(base,"return new Map([[1, 2]])");
  assert.deepEqual(out.result,[[1,2]],"results become JSON data");
  // Every result is JSON text without losing Map keys: a record value with its own key field stays a pair.
  for(const [code,want] of [["return 1n","1"],["return new Map([['id', {key: 'real', n: 1}]])",[["id",{key:"real",n:1}]]],
    ["return new Map([['id', {n: 1}]])",[{key:"id",n:1}]],["return new Map([[2n, {a: 1}], ['m', new Map([['a', 1]])], ['d', new Date(0)]])",[{key:"2",a:1},["m",[["a",1]]],["d","1970-01-01T00:00:00.000Z"]]],
    ["return [new Set([1n]), new BigInt64Array([5n]), new Uint8Array([1, 2]), new Date(NaN), NaN, undefined]",[["1"],["5"],[1,2],null,null,null]],
    ["const a = {n: 1}; a.self = a; a.again = a; return a",{n:1,self:null,again:null}]]){
    const job=S.headlessStart(JSON.stringify({code,timeoutMs:1000}),JSON.stringify(base));
    await new Promise(res=>setTimeout(res,0));
    const r=JSON.parse(S.headlessTake(job,{includeProject:false}));
    assert.equal(r.ok,true,code);assert.deepEqual(r.result,want,code);
  }

  // Two-phase entry used through the JavaScriptCore C API.
  const job=S.headlessStart(JSON.stringify({code:"return (await api.items.count({kind: 'via'}))",timeoutMs:1000}),JSON.stringify(base));
  await new Promise(res=>setTimeout(res,0));
  const taken=JSON.parse(S.headlessTake(job));
  assert.equal(taken.done,true);assert.equal(taken.ok,true);assert.equal(taken.result,5);assert.equal(taken.project.name,base.name);
  assert.equal(JSON.parse(S.headlessTake(job)).ok,false,"a job is collected once taken");
  // Lazy feature modules (app/lazy.js): a missing module loads on first use, and the call resolves.
  {
    const had=globalThis.AtriumERC,hadLazy=globalThis.AtriumLazy;delete globalThis.AtriumERC;
    const asked=[];
    globalThis.AtriumLazy={modules:()=>["AtriumERC"],need:async g=>{asked.push(g);globalThis.AtriumERC={run:()=>({violations:[],lazy:true})};return globalThis.AtriumERC;}};
    const lz=API.headless(A.clone(base),{extension:{id:"script",permissions:API.SCRIPT_PERMISSIONS}}).api;
    assert.deepEqual(await lz.erc(),{violations:[],lazy:true});assert.deepEqual(asked,["AtriumERC"],"the feature loads through AtriumLazy");
    if(had)globalThis.AtriumERC=had;else delete globalThis.AtriumERC;
    if(hadLazy)globalThis.AtriumLazy=hadLazy;else delete globalThis.AtriumLazy;
  }
  // Security regressions: own fields only, no code-bearing proposals.
  {
    const s2=API.headless(A.clone(base),{extension:{id:"script",permissions:API.SCRIPT_PERMISSIONS}}).api;
    assert.deepEqual(s2.items.list({kind:"part",fields:["constructor","__proto__","ref"],limit:1}).map(Object.keys),[["ref"]]);
    for(const field of ["extensions","scripts"])
      assert.throws(()=>s2.proposals.submit({format:"atrium-ai",version:2,project:s2.project.info().name,ops:[{op:"set",target:"project",path:[field],after:[]}]}),/code/);
  }
  console.log("atrium-api tests passed");
})();
// Runners that understand it (tests/jsc-shim.js with the proposed patch) wait for this promise.
globalThis.__testDone=done.catch(e=>{console.error(e);if(globalThis.process)process.exitCode=1;throw e;});
