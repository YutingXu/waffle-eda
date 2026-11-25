"use strict";
// Run on already-exported .waffle snapshots. Only aggregate results leave the
// process. Each endpoint's destinations must equal a fresh compiler's unions.
const fs=require("node:fs"), path=require("node:path"), assert=require("node:assert/strict");
for (const m of ["model","sch-objects","hierarchy","multichannel","sheet-connections","undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium,H=AtriumHierarchy,S=AtriumSheetConnections,U=AtriumUndoStore;
const folder=process.argv[2]; if (!folder) throw Error("Pass the folder of read-only .waffle snapshots.");
const id=(inst,item,entry)=>JSON.stringify([inst.id,item.id,entry?.id]);
for(const f of fs.readdirSync(folder).filter(f=>f.endsWith(".waffle")).sort()) {
  const p=JSON.parse(fs.readFileSync(path.join(folder,f),"utf8")); U.mark(p);U.prime();
  const r=S.index(H.compileCached(p)), h=H.compile(A.clone(p)),groups=new Map(),keys=new Map();
  function link(k,t) {
    if (!groups.has(k)) groups.set(k,new Set());
    if (!keys.has(t)) keys.set(t,new Set());
    groups.get(k).add(t);keys.get(t).add(k);
  }
  for(const n of h.nets) for(const {inst,net} of n.local){
    for(const s of net.sources) if(s.item.kind!=="wire") link(n.key,id(inst,s.item));
    for(const e of net.entries) link(n.key,id(inst,e.symbol,e.entry));
  }
  for(const b of h.busLinks) for(const k of b.keys) link(k,id(b.inst,b.item,b.entry));
  let linked=0, cross=0, max=0;
  const kinds={};
  for(const t of r.targets){
    const own=id(t.instance,t.item,t.entry), expected=new Set(), lookup=r.targetsFor(t.doc.id,t.item.id,t.entry?.id,t.instance.id);
    for(const k of keys.get(own)||[]) for(const other of groups.get(k)) if(other!==own) expected.add(other);
    const actual=new Set(lookup.targets.map(v=>id(v.instance,v.item,v.entry)));
    assert.ok(actual.size===expected.size && [...expected].every(x=>actual.has(x)),"destinations differ from a fresh compile");
    if(t.kind==="power") {
      const summary=r.targetsFor(t.doc.id,t.item.id,t.entry?.id,t.instance.id,3);
      assert.equal(summary.count,actual.size);assert.equal(summary.sheets,lookup.sheets);
      assert.ok(summary.targets.length<=3 && summary.targets.every(v=>actual.has(id(v.instance,v.item,v.entry))));
    }
    kinds[t.kind]=(kinds[t.kind]||0)+1;
    if(actual.size)linked++;if(lookup.otherSheet)cross++;max=Math.max(max,actual.size);
  }
  console.log(JSON.stringify({fixture:path.basename(f,".waffle"),scope:h.effective,targets:r.targets.length,linked,cross,max,kinds}));
  U.reset();
}
