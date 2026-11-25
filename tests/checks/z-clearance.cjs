"use strict";
// Z-axis clearance rule (z-clearance.js + rules.js zClearance): copper of
// different nets on neighbouring copper layers, measured through the
// dielectric of the layer stack, and its canvas overlay.
const assert=require("node:assert/strict");
for(const m of ["model","pcb-appearance","pcb-pours","stackup","connectivity","rules","z-clearance"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const R=AtriumRules,Z=AtriumZClearance,S=AtriumStackup;
const rule=(props={})=>({id:"z-"+(props.name||"1"),type:"zClearance",name:props.name||"ZAxis",comment:"",enabled:true,priority:1,scope:AtriumDesignQueryRecord.selector("all"),gap:.1,adjacentOnly:true,...props});
const rulesWith=(...rs)=>{const c=R.create();c.list.push(...rs);R.validate(c);return c;};
const track=(id,net,points,layer,width=.1)=>({kind:"track",id,net,points,width,layer});
function hdi(){
  // 4 layers with a 50 µm prepreg between Top and Inner 1 (HDI build-up).
  const st=S.preset("4"),cu=st.layers.map((l,i)=>[l,i]).filter(([l])=>S.isCopper(l));
  const between=st.layers.slice(cu[0][1]+1,cu[1][1]);for(const l of between)l.thickness=.05/between.length;
  return st;
}
const board=(items,rules)=>({kind:"pcb",name:"HDI",items,notes:[],stackup:hdi(),rules,outline:[[0,0],[20,0],[20,20],[0,20]]});
const of=out=>out.violations.filter(v=>v.type==="zClearance");
const close=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<e,a+" differs from "+b);

// The type is registered, starts with no rules and validates.
assert.equal(R.types.zClearance.title,"Z-Axis Clearance");
assert.ok(!R.create().list.some(r=>r.type==="zClearance"),"no rule until one is added (as in Altium)");
assert.throws(()=>R.validate(rulesWith(rule({gap:-1}))));

// Dielectric thickness from the stack.
{
  const d=board([]),D=Z.dielectric(d,new Map());
  close(D.gap("Top","Inner 1"),.05,1e-9);close(D.gap("Inner 1","Top"),.05,1e-9);
  assert.ok(D.gap("Inner 1","Inner 2")>.1,"the core between the planes");
  assert.ok(D.adjacent("Top","Inner 1")&&!D.adjacent("Top","Inner 2"));
}
const rules=rulesWith(rule());
// Crossing copper on adjacent layers: distance = dielectric.
{
  const items=[track("a","A",[[2,5],[12,5]],"Top"),track("b","B",[[7,4.5],[7,5.5]],"Inner 1"),
    track("c","C",[[2,12],[12,12]],"Top"),track("d","D",[[2,12.5],[12,12.5]],"Inner 1"),   // 0.4 mm lateral: fine
    track("e","E",[[2,16],[12,16]],"Top"),track("f","F",[[2,16.15],[12,16.15]],"Inner 1"), // 0.05 lateral: hypot(.05,.05)
    track("g","A",[[2,8],[12,8]],"Top"),track("h","A",[[7,7],[7,9]],"Inner 1"),           // same net: fine
    track("k","K",[[2,3],[12,3]],"Top"),track("m","M",[[7,2],[7,4]],"Inner 2")];          // not adjacent
  const v=of(R.drc(board(items,rules),new Map(),rules));
  const pairs=v.map(x=>[x.id,x.otherId].sort().join("-")).sort();
  assert.deepEqual(pairs,["a-b","e-f"],JSON.stringify(pairs));
  const ab=v.find(x=>[x.id,x.otherId].includes("a"));close(ab.actual,.05,1e-9);close(ab.dielectric,.05,1e-9);close(ab.lateral,0);
  assert.deepEqual(ab.layers.sort(),["Inner 1","Top"]);assert.ok(Array.isArray(ab.at));
  const ef=v.find(x=>[x.id,x.otherId].includes("e"));close(ef.actual,Math.hypot(.05,.05),1e-6);
  assert.ok(/dielectric/.test(ef.detail));
  // Same layer pairs are the Clearance rule's job.
  assert.ok(!v.some(x=>x.layers[0]===x.layers[1]));
  // A thicker dielectric clears every pair.
  const thick=board(items,rules);thick.stackup=S.preset("4");
  assert.deepEqual(of(R.drc(thick,new Map(),rules)),[]);
  // Every layer pair (adjacentOnly off) with a large gap reaches Inner 2 through the stack.
  const all=rulesWith(rule({adjacentOnly:false,gap:2}));
  assert.ok(of(R.drc(board(items,all),new Map(),all)).some(x=>[x.id,x.otherId].sort().join("-")==="k-m"),"non-adjacent pair with adjacentOnly off");
  // Net scope.
  const scoped=rulesWith(rule({scope:AtriumDesignQueryRecord.selector("net", "E")}));
  assert.deepEqual(of(R.drc(board(items,scoped),new Map(),scoped)).map(x=>[x.id,x.otherId].sort().join("-")),["e-f"]);
  // Z.check runs only this rule.
  assert.equal(Z.check(board(items,rules),new Map()).length,2);
}
// Only the wide trace matches even when its narrower neighbour has the same net and layer.
{
  const scoped=rulesWith(rule({scope:AtriumDesignQueryRecord.create("track where width >= 0.2 mm")}));
  const items=[track("wide","SIG",[[2,3],[12,3]],"Top",.2),track("narrow","SIG",[[2,8],[12,8]],"Top",.1),
    track("return","GND",[[7,2],[7,9]],"Inner 1")];
  const hit=Z.check(board(items,scoped),new Map());
  assert.deepEqual(hit.map(v=>[v.id,v.otherId].sort()),[["return","wide"]]);
  close(hit[0].actual,.05); close(hit[0].required,.1);
}

// A footprint pad keeps its owning designator and pad number through the Z check.
{
  const defs=new Map([["foot",{footprint:{pads:[{number:"1",x:0,y:0,w:.4,h:.4,shape:"rect"}]}}]]);
  const part=(id,ref,y)=>({kind:"part",id,ref,def:"foot",layer:"Top",x:7,y,angle:0,pinNets:{"1":"SIG"}});
  const scoped=rulesWith(rule({scope:AtriumDesignQueryRecord.create('pad where component.designator = "U2" and pin.number = "1"')}));
  const d=board([part("u1","U1",3),part("u2","U2",8),track("ground","GND",[[7,2],[7,9]],"Inner 1")],scoped);
  const hit=Z.check(d,defs);
  assert.deepEqual(hit.map(v=>[v.id,v.otherId].sort()),[["ground","u2"]]);
  close(hit[0].actual,.05);
}

// Poured islands retain their polygon identity even when they share a net and layer.
{
  const polygon=(id,name,y)=>({kind:"polygon",id,name,layer:"Inner 1",net:"GND",points:[[2,y],[12,y],[12,y+2],[2,y+2]]});
  const guard=polygon("guard","Guard",3), spare=polygon("spare","Spare",8);
  const items=[guard,spare,track("sig","SIG",[[7,2],[7,11]],"Top")];
  const scoped=rulesWith(rule({pours:true,scope:AtriumDesignQueryRecord.create('polygon where name = "Guard"')}));
  const d=board(items,scoped);
  d.pcbDrawing={pours:[guard,spare].map(p=>AtriumPCBPours.region([p.points],p.layer,p.net,{polygon:p.id}))};
  const hit=Z.check(d,new Map());
  assert.deepEqual(hit.map(v=>[v.id,v.otherId]),[["sig","guard"]]);
  assert.equal(hit[0].pour,true); close(hit[0].actual,.05);
  // Imported artwork can lack an editable polygon or name.
  const imported=board([items[2]],rulesWith(rule({pours:true,scope:AtriumDesignQueryRecord.create('polygon where net.name = "GND"')})));
  imported.pcbDrawing={pours:[AtriumPCBPours.region([guard.points],guard.layer,guard.net),AtriumPCBPours.region([spare.points],"Silk",spare.net)]};
  const stored=Z.check(imported,new Map());
  assert.deepEqual(stored.map(v=>[v.id,v.otherId]),[["sig",null]]);
  close(stored[0].actual,.05);
}

// Overlay: a renderer that paints a mark and a tag for every violation.
{
  const items=[track("a","A",[[2,5],[12,5]],"Top"),track("b","B",[[7,1],[7,9]],"Inner 1")],d=board(items,rules);
  const calls=[];const ctx=new Proxy({},{get:(t,k)=>k in t?t[k]:(...a)=>calls.push([k,...a]),set:(t,k,v)=>{t[k]=v;return true;}});
  Z.overlay(d,new Map(),Z.check(d,new Map()))(ctx,{scale:10,dpr:1});
  assert.ok(calls.some(c=>c[0]==="arc")&&calls.some(c=>c[0]==="fillText"&&/Z 0\.050/.test(c[1])),"ring and label");
  // The view toggle through the editor host.
  let renderer=null,action=null;
  const host={doc:()=>d,defs:()=>new Map(),revision:()=>1,info(){},invalidate(){},registerAction:(id,f)=>{if(id==="z-clearance-overlay")action=f;},addRenderer:f=>{renderer=f;}};
  Z.attach(host);assert.equal(renderer(d),null,"off by default");
  action();assert.ok(Z.enabled&&typeof renderer(d).overlay==="function");
  action();assert.equal(renderer(d),null);
}
console.log("z-clearance ok");
