"use strict";
const assert = require("node:assert/strict");
for (const name of ["model","altium-rules","rules","project-rules","component-classes","design-query"])
  require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const A = Atrium, CC = AtriumComponentClasses, Q = AtriumDesignQueryRecord, D = AtriumDesignQuery, P = AtriumProjectRules;
const p = A.project("Board classes",[]), board = p.documents.find(d=>d.kind==="pcb");
const other = A.sheet("pcb","Sibling"), part = {id:"u3",kind:"part",ref:"U3",x:0,y:0}, outside = {id:"u4",kind:"part",ref:"U4",x:5,y:0};
board.items = [part,outside]; other.items = [{...part,id:"sibling-u3"}]; p.documents = [board,other];
CC.set(board,"Power",["U3"]); CC.set(other,"Power",["U3"]);
const source = 'object where (in component class "Power" and comment = "Power") or (in component class "Power" and in component "U3")';
const start = source.indexOf('"U3"'), bound = Q.create(source,[{id:"owner",name:"U3",span:[start,start+4],target:{scope:"item",docId:board.id,itemId:part.id}}]);
const base = AtriumRules.create().list.find(r=>r.type==="clearance");
board.sourceRules = ["RULEKIND=Clearance|NAME=Local|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|GAP=0.2mm"];
const scoped = {...base,id:"local",name:"Local",boards:[board.id],origin:{kind:"import",tool:"Altium",board:board.id},
  scope:bound,scope2:Q.selector("componentclass","Power")};
const shared = {...base,id:"shared",name:"Shared",priority:2,scope:Q.selector("componentclass","Power")};
const otherOnly = {...base,id:"other",name:"Other board only",priority:3,boards:[other.id],scope:Q.selector("componentclass","Power")};
p.rules = {format:"atrium-rules",version:3,units:"mm",list:[scoped,shared,otherOnly]};
const wins = (doc,scope) => {
  const result = D.compile(scope,D.context(p,doc));
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  return doc.items.filter(i=>result.plan.matches(i)).map(i=>i.id);
};
assert.deepEqual(wins(board,scoped.scope2),[part.id]);
const earlier=p.rules, original=JSON.stringify(earlier);
CC.headless(p,{op:"rename",document_id:board.id,name:"Power",new_name:"Power supply"});
assert.equal(JSON.stringify(earlier),original,"source-record adoption never mutates the previous saved Undo state");
const own = p.rules.list.find(r=>r.id===scoped.id), sibling = P.forBoard(p,other), local = P.forBoard(p,board);
const changed = source.replaceAll('in component class "Power"','in component class "Power supply"');
assert.equal(own.scope.source,changed);
assert.equal(own.scope2.source,'object in component class "Power supply"');
assert.deepEqual(own.scope.bindings,[{...bound.bindings[0],span:[changed.indexOf('"U3"'),changed.indexOf('"U3"')+4]}]);
assert.deepEqual(wins(board,own.scope),[part.id]);
assert.deepEqual(wins(board,own.scope2),[part.id]);
assert.deepEqual(sibling.list.find(r=>r.id==="other").scope,otherOnly.scope);
assert.deepEqual(wins(other,sibling.list.find(r=>r.name==="Shared").scope),["sibling-u3"]);
assert.deepEqual(wins(board,local.list.find(r=>r.name==="Shared").scope),[part.id]);
assert.deepEqual(Object.keys(other.componentClasses),["Power"]);
console.log("Component class rename preserves both rule sides, other string literals, stable bound objects and sibling-board meanings.");
