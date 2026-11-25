"use strict";
const assert = require("node:assert/strict");
for (const m of ["model","sch-objects","hierarchy","sheet-connections","undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, H = AtriumHierarchy, C = AtriumSheetConnections, S = AtriumSchObjects, U = AtriumUndoStore;
let project = A.project("Inter-sheet connections", []);
const top = project.documents[0], child = A.sheet("schematic","Sensor"), peer = A.sheet("schematic","Control"), other = A.sheet("schematic","Elsewhere");
project.documents = [top,child,peer,other];
project.rules = {list:[{type:"ercNetScope",netScope:"hierarchical",scope:{languageVersion:1,source:"object"}}]};
assert.equal(H.scopeSetting(project),"hierarchical");
assert.equal(H.scopeRule({list:[{...project.rules.list[0],scope:{kind:"all"}}]}),undefined);
assert.equal(globalThis.AtriumDesignQuery,undefined);
const put = (doc, item) => (doc.items.push(item), item);
const port = (doc, name, kind="port") => put(doc, S.make(kind,[0,doc.items.length*15],{text:name,io:"input"}));
const symbol = (doc, entries, name) => put(top, S.make("sheetsymbol",[20,top.items.length*40],{sheet:doc.id,name,entries:entries.map((name,n)=>({id:"e"+n,name,io:"input",side:"left",offset:2.54*(n+1)}))}));
const sensor = symbol(child,["SIG","D[0..1]","Repeat(OUT)"],"Repeat(S,1,2)"), ctrl = symbol(peer,["SIG"],"Control");
const signal = port(child,"SIG"), siblingPort = port(peer,"SIG"), isolatedPort = port(other,"SIG");
const bus = port(child,"D[0..1]"), out = port(child,"OUT"), off = port(child,"CLOCK","offsheet"), siblingOff = port(peer,"CLOCK","offsheet");
const remote = put(other,{id:A.id(),kind:"netlabel",text:"CLOCK",x:5,y:15,schPaint:{type:"power",offSheet:true}});
const p1 = port(child,"GND","power"), p2 = port(other,"GND","power");
const label = doc => put(doc,{id:A.id(),kind:"netlabel",text:"LOCAL",x:82,y:42});
const l1 = label(child), l2 = label(peer);
const occurrence = (r,d) => r.compiled.instances.filter(i=>i.doc.id===d.id);
const get = (r,d,i,e,instance) => r.targetsFor(d.id,i.id,e?.id,instance?.id);
const result = () => C.index(H.compileCached(project));
U.mark(project); U.prime();
let r = result();
assert.equal(r,result(),"one index per certified compile");
const ch = occurrence(r,child);
assert.equal(ch.length,2);
assert.deepEqual(get(r,child,signal,null,ch[0]).direct.map(t=>[t.item.id,t.entry.id]),[[sensor.id,"e0"]]);
assert.deepEqual(get(r,top,sensor,sensor.entries[0]).direct.map(t=>t.instance.id),ch.map(c=>c.id));
assert.deepEqual(get(r,top,sensor,sensor.entries[1]).direct.map(t=>t.item.id),[bus.id,bus.id],"bus without scalar pins");
assert.deepEqual(get(r,top,sensor,sensor.entries[2]).direct.map(t=>t.item.id),[out.id,out.id],"repeat-entry fanout");
assert.deepEqual(get(r,peer,siblingPort).direct.map(t=>t.item.id),[ctrl.id]);
assert.ok(get(r,other,isolatedPort).ignored.some(s=>s.includes("hierarchical scope connects ports only to sheet entries")));
assert.deepEqual(get(r,child,off,null,ch[0]).direct.map(t=>t.item.id).sort(),[off.id,siblingOff.id].sort());
assert.equal(get(r,other,remote).source.kind,"offsheet"); assert.equal(get(r,other,remote).count,0);
assert.deepEqual(get(r,child,l1,null,ch[0]).targets,[]);
assert.ok(get(r,child,l1).ignored[0].includes("keeps net labels on their sheet"));
assert.ok(get(r,child,p1).targets.some(t=>t.item===p2));
assert.ok(r.connectionsFor("GND").some(t=>t.item===p2));
function snapshot(index) { return index.targets.map(t=>{
  const row=get(index,t.doc,t.item,t.entry,t.instance);
  return [t.instance.id,t.item.id,t.entry?.id,row.targets.map(b=>[b.instance.id,b.item.id,b.entry?.id]),row.ignored];
}); }
const history=[],future=[];
function change(fn,hint) {
  const mark=U.mark(project); fn(); U.checkpoint(history,future,mark); U.record(project,hint);
  r=result(); assert.deepEqual(snapshot(r),snapshot(C.index(H.compile(A.clone(project)))));
}
function go(n) {
  U.jump(history,future,U.mark(project),n); project=U.root(); U.record(project);
  r=result(); assert.deepEqual(snapshot(r),snapshot(C.index(H.compile(A.clone(project)))));
}
change(()=>{signal.text="CHANGED";},{doc:child,items:[signal]});
assert.equal(get(r,top,sensor,sensor.entries[0]).direct.length,0);
go(-1); assert.equal(get(r,top,sensor,sensor.entries[0]).direct.length,2);
change(()=>{project.rules.list[0].netScope="global";},[]);
assert.ok(get(r,child,l1).direct.some(t=>t.item.id===l2.id));
change(()=>{project.rules.list[0].netScope="flat";},[]);
assert.equal(get(r,top,sensor,sensor.entries[0]).direct.length,0);
assert.ok(get(r,other,isolatedPort).direct.some(t=>t.item.id===siblingPort.id));
go(-2); go(2);
console.log("PASS compiled scalar, bus, repeat, sibling, power and scoped name navigation through edits and history");
