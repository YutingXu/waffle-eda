"use strict";
const assert = require("node:assert/strict");
require("../../app/library/component-match.js");
const C = AtriumComponentMatch;
function part(id, ref, prefix, nets, options = {}) {
  const {version = "", source = "", link = source, x = 0, scope = "sheet", domain = "schematic",
    channel = "", description = "", value = version, count = Object.keys(nets).length} = options;
  const terminals = Array.from({length:count}, (_,i) => ({number:String(i+1)}));
  const def = {id:prefix+version, name:prefix+version, prefix, description, footprintName:"package"+version,
    ...(domain === "pcb" ? {footprint:{pads:terminals}} : {symbol:{pins:terminals}})};
  return C.describe({id,ref,link,altiumSourceId:source,x,y:0,pinNets:nets,value},def,
    {domain,scope,sheet:scope,plane:scope,channel});
}
const solve = (a,b,opts) => C.finish(C.steps(a,b,opts));
const anchor = (nets,scope="sheet") => part("fixed","U1","U",nets,{scope});
const passive = (id,ref,nets,version,options={}) => part(id,ref,"C",nets,
  {version,source:id+"-source",x:version==="old" ? 0 : 80,description:"Ceramic capacitor",...options});

// A printed net name is recycled on another pin of an unchanged IC. Each original circuit
// follows its own numbered IC pin, even with different designators, packages and locations.
const old = [anchor({1:"A",2:"B",3:"RETURN"}),passive("a","C1",{1:"A",2:"RETURN"},"old"),passive("b","C2",{1:"B",2:"RETURN"},"old")];
const changed = [anchor({1:"B",2:"A",3:"RETURN"}),passive("x","C1",{1:"A",2:"RETURN"},"new"),passive("y","C2",{1:"B",2:"RETURN"},"new")];
const result = solve(old,changed);
assert.equal(result.pairs.get("a").target,"y");
assert.equal(result.pairs.get("b").target,"x");
assert.equal(result.pairs.get("a").review,false);
assert.ok(result.pairs.get("a").confidence < 1);
assert.match(result.pairs.get("a").reasons.join(" "),/numbered pin/);
assert.deepEqual([...solve([...old].reverse(),[...changed].reverse()).pairs].sort(),[...result.pairs].sort());
const split = [anchor({1:"A1",2:"A2",3:"G"}),passive("s","C9",{1:"A1",2:"G"},"new")];
const branched = solve([anchor({1:"A",2:"A",3:"G"}),passive("r","C8",{1:"A",2:"G"},"old")],split);
assert.ok(!branched.pairs.get("r") || branched.pairs.get("r").review,"two new nets cannot certify one old net");

// Copies of an entire circuit, including repeated channels, cannot lend identity across sheets.
// An exact match already consuming the other same-source object does not make a copied ID unique.
{
  const original = passive("original","C1",{1:"X",2:"G"},"old",{source:"copied"});
  const first = passive("first","C2",{1:"Y",2:"G"},"old",{source:"copied"});
  const second = passive("second","C3",{1:"Y",2:"G"},"new",{source:"copied"});
  const duplicate = solve([original,first],[original,second]);
  assert.equal(duplicate.pairs.get("first").review,true);
  const missingPath = solve([passive("p","C1",{1:"X",2:"G"},"old",{channel:"repeated/1"})],
    [passive("q","C1",{1:"X",2:"G"},"new",{channel:"repeated/2"})]);
  assert.equal(missingPath.pairs.size,0);
  const otherSheet = changed.slice(1).map(p=>({...p,scope:"duplicate",sheet:"duplicate",plane:"duplicate",key:"d"+p.key}));
  assert.equal(solve(old,[changed[0],...otherSheet]).pairs.has("a"),false);
  // Older pasted objects retained the source ID but lost both source records and the imported link.
  const edited = passive("clipboard-copy","C20",{1:"A",2:"G"},"new",{source:"original-uid",link:"fresh",x:50});
  const historic = solve([passive("placed","C1",{1:"Z",2:"G"},"old",{source:"original-uid"})],[edited]);
  assert.equal(historic.pairs.get("placed").review,true);
  assert.ok(historic.pairs.get("placed").confidence < 1);
}

function linkedPair(id,ref,nets,version,boardId,options={}) {
  const source = id+"-source";
  return [part(id,ref,"C",nets,{version,source,...options}),
    part(boardId,ref,"C",nets,{version,source,domain:"pcb",scope:"board",...options})];
}
{
  const a = linkedPair("old-symbol","C4",{1:"V",2:"G"},"old","held",{description:"Ceramic capacitor"});
  const b = linkedPair("new-symbol","C4",{1:"G",2:"V"},"new","held",{description:"Ceramic capacitor"});
  assert.equal(solve(a,b).pairs.get("old-symbol").review,false);
  const polarized = linkedPair("polar","C4",{1:"G",2:"V"},"new","held",{description:"Polarized tantalum capacitor"});
  assert.equal(solve(a,polarized).pairs.get("old-symbol").review,true,"opposite polarity remains reviewable");
  const pasted = [...b, {...b[0], key:"copy", ids:["copy"]}];
  const m = solve(a,pasted).pairs.get("old-symbol");
  assert.ok(!m || m.review,"duplicate imported source IDs cannot transfer a board object's identity");
}

{
  const users = Array.from({length:9},(_,i)=>part("return-"+i,"R"+i,"R",{1:"G",2:"load-"+i}));
  const base = [anchor({1:"X",2:"Y",3:"Z",4:"G"}),...users], next = [anchor({1:"X",2:"Y",3:"Z",4:"G"}),...users];
  const connectors = (id, ref, terminals, version, count) =>
    ["schematic","pcb"].map(domain=>part(id+domain,ref,"J",terminals,
      {source:id+"-source",version,domain,scope:domain==="pcb"?"board":"sheet",count}));
  base.push(...connectors("old","J1",{1:"G",2:"X",3:"Y",4:"Z",5:"G"},"old",6));
  next.push(...connectors("new","J9",{1:"Z",2:"X",3:"Y"},"new",4));
  const m = solve(base,next);
  for(const domain of ["schematic","pcb"]) {
    assert.equal(m.pairs.get("old"+domain).target,"new"+domain);
    assert.equal(m.pairs.get("old"+domain).review,false);
  }
  const duplicated = solve(base,[...next,...connectors("other","J8",{1:"Z",2:"X",3:"Y"},"new",4)]);
  assert.ok(!duplicated.pairs.get("oldschematic") || duplicated.pairs.get("oldschematic").review);
}

{
  const busy = Array.from({length:10},(_,i)=>part("common-"+i,"R"+(i+10),"R",{1:"G",2:"line-"+i}));
  const a = passive("gone","C1",{1:"G",2:"unused"},"old");
  const b = passive("added","C9",{1:"G",2:"added"},"new");
  assert.equal(solve([...old,...busy,a],[...changed,...busy,b]).pairs.has("gone"),false,
    "a common return by itself does not pair a removed device with a new one");
}

// The charger is a genuine replacement with a different package and pad numbering. Its
// pin functions explain which support part to propose, while the replacement needs review.
{
  const control = (id,version,names,nets) => {
    const def = {name:version,prefix:"U",symbol:{pins:names.map((name,i)=>({number:String(i+1),name}))}};
    return C.describe({id,ref:"U8",def:version,x:0,y:0,pinNets:nets},def,{domain:"schematic",scope:"sheet",sheet:"sheet"});
  };
  const prior = control("old-control","controller-A",["PORT","THERM","BAT","SW"],{1:"PORT",2:"old-sense",3:"old-cell",4:"switch-A"});
  const later = control("new-control","controller-B",["BAT","PORT","SW","THERM"],{1:"new-cell",2:"PORT",3:"switch-B",4:"new-sense"});
  const source = passive("support","C2",{1:"G",2:"old-cell"},"old");
  const reused = passive("other","C2",{1:"G",2:"new-sense"},"new"), correct = passive("cell","C9",{1:"G",2:"new-cell"},"new");
  const plan = solve([anchor({1:"A",2:"B",3:"G"}),prior,source],[anchor({1:"A",2:"B",3:"G"}),later,reused,correct]);
  assert.equal(plan.pairs.get(source.key).target,correct.key);
  assert.equal(plan.pairs.get(source.key).review,true);
  assert.match(plan.pairs.get(source.key).reasons.join(" "),/proposed component replacement/);
}

// The old pull resistor was the only other device on this connector terminal. The new
// connector goes straight to an IC. A different-sheet resistor with only a reused reference
// remains a review question. Moving a genuine termination or retaining its source ID is safe.
{
  const pair = (id,ref,prefix,nets,version,sheet,x=0,source=id) => ["schematic","pcb"].map(domain =>
    part(id+domain,ref,prefix,nets,{source,version,domain,scope:domain==="pcb"?"board":sheet,x}));
  const rail = Array.from({length:9},(_,i)=>part("load"+i,"X"+i,"X",{1:"RETURN"},{domain:"pcb",scope:"board"}));
  const a = [...rail,...pair("connector","J1","J",{1:"OLD",2:"BUS",3:"RETURN"},"port","interface"),
    ...pair("r-old","R1","R",{1:"OLD",2:"RETURN"},"original","interface")];
  const updatedPort = [...rail,...pair("connector","J1","J",{1:"RENAMED",2:"BUS",3:"RETURN"},"port","interface"),
    ...pair("controller","U2","U",{1:"RENAMED",2:"POWER",3:"OTHER"},"active","controller")];
  const nearbyRole = {1:"OTHER",2:"INDICATOR"};
  const unrelated = solve(a,[...updatedPort,...pair("r-new","R1","R",nearbyRole,"different","indicator",20)]);
  assert.equal(unrelated.pairs.has("r-oldpcb"),false);
  assert.equal(unrelated.reviewSources.has("r-oldpcb"),true);
  assert.match(unrelated.unpairedReasons.get("r-oldpcb"),/connects directly to a controller/);
  const moved = solve(a,[...updatedPort,...pair("r-new","R1","R",{1:"RENAMED",2:"RETURN"},"different","indicator",20)]);
  assert.equal(moved.pairs.get("r-oldpcb").target,"r-newpcb","the updated circuit still has the termination");
  const retained = solve(a,[...updatedPort,...pair("r-new","R1","R",nearbyRole,"different","indicator",20,"r-old")]);
  assert.equal(retained.pairs.get("r-oldpcb").confidence,1,"a surviving source link can prove object reuse");
  const sameStock = solve(a,[...updatedPort,...pair("r-new","R1","R",nearbyRole,"original","indicator",20)]);
  assert.ok(sameStock.pairs.has("r-oldpcb"),"the same stock part moved to a new circuit still has independent evidence");
  const sameSheet = solve(a,[...updatedPort,...pair("r-new","R1","R",nearbyRole,"different","interface",20)]);
  assert.equal(sameSheet.pairs.get("r-oldpcb").review,true,"within-sheet intentional replacement remains a proposal");
}

// An importer can assign both placements of a repeated connector the same schematic link.
// Their explicit source objects still distinguish them inside the same PCB document.
{
  const record=(key,source,link="kicad-common") => C.describe({id:key,ref:"J2",link,kicadSourceId:source},
    {id:"jack",name:"Jack"},{scope:"board",domain:"pcb"});
  const old=[record("a","uuid-1"),record("b","uuid-2")], next=[record("x","uuid-2"),record("y","uuid-1")];
  for (const [left,right] of [[old,next],[next,old]]) {
    const r=solve(left,right);
    for (const p of left) {
      const match=r.pairs.get(p.key);
      assert.equal(match.by,"kicad-source");
      assert.equal(match.target,right.find(b=>b.kicadIds[0]===p.kicadIds[0]).key);
    }
  }
  const pasted=record("new-copy","uuid-1","generated-link");
  assert.ok(solve(old,[pasted]).pairs.get("a")?.confidence !== 1);
}

// A former feedback arm and an unrelated enable resistor use the same stock part. A
// crowded rail cannot prove continuation on either physical side of this comparison.
{
  const supply = Array.from({length:10},(_,i)=>part("device"+i,"X"+i,"X",{1:"SUPPLY"}));
  const retained = [anchor({1:"SUPPLY",2:"CONTROL",3:"SENSOR"}),...supply];
  const previous = part("old-arm","R5","R",{1:"OLD_FEEDBACK",2:"SUPPLY"},{version:"stock",x:1});
  const current = part("new-arm","R9","R",{1:"ENABLE",2:"SUPPLY"},{version:"stock",x:80});
  for (const [a,b] of [[previous,current],[current,previous]]) {
    const m = solve([...retained,a],[...retained,b]);
    assert.ok(!m.pairs.has(a.key));
    assert.ok(m.choices.get(a.key).some(e=>e.target===b.key));
    assert.match(m.unpairedReasons.get(a.key),/local circuit connection/);
  }
  const changedUse = {...current,pins:{1:"OLD_FEEDBACK",2:"SUPPLY"}};
  assert.equal(solve([...retained,previous],[...retained,changedUse]).pairs.get(previous.key).target,current.key);
  const distinctA = {...previous,instances:["left#1"]}, distinctB = {...previous,key:"other",ids:["other"],instances:["right#1"]};
  const one = solve([distinctA],[distinctB]).pairs.get(distinctA.key);
  assert.ok(one.review && one.reasons.some(r=>r.includes("sheet instances")));
}

globalThis.__testDone = C.inSlices(C.steps(old,changed,{background:true})).then(async m => {
  assert.deepEqual([...m.pairs],[...result.pairs]);
  assert.equal(await C.inSlices(C.steps(old,changed),()=>false),null);
  console.log("PASS component electrical witnesses, changed net names, connector pinout changes, repeated circuits, pasted source IDs and polarity");
});
