"use strict";
// Constraint Manager (app/checks/constraints.js), review M3: an edit that lands on a disabled or
// lower-priority rule enables it and lifts it so the edited value applies, and says so.
const assert=require("node:assert/strict");
for(const m of ["model","parts","stackup","impedance","altium-rules","net-intent","signals","rules","length-tuning","dfa","constraints"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const R=AtriumRules,K=AtriumConstraints,S=AtriumStackup;
const track=(id,net,width,points)=>({id,kind:"track",net,layer:"Top",width,points});
function setup(extra){
  const doc={kind:"pcb",id:"b",name:"Board",outline:[[0,0],[60,0],[60,40],[0,40]],stackup:{version:1,layers:S.preset("4").layers},
    items:[track("t1","CLK",.2,[[0,0],[10,0]]),track("t3","D0",.2,[[0,5],[30,5]])]};
  const rules=R.create();rules.netClasses={Fast:["CLK","D0"]};
  rules.list.push({id:"w-fast",type:"width",name:"Width_Fast",comment:"",enabled:true,priority:1,scope:{kind:"netclass",value:"Fast"},min:.3,preferred:.3,max:1});
  rules.list.push({id:"w-clk",type:"width",name:"Width_CLK_old",comment:"",priority:9,scope:{kind:"net",value:"CLK"},min:.1,preferred:.2,max:1,...extra});
  const project={name:"P",library:[],documents:[doc]};R.store(doc,project,rules);
  return {project,doc};
}
for(const [extra,word] of [[{enabled:true},"moved to the top priority"],[{enabled:false,priority:1},"enabled"]]){
  const {project,doc}=setup(extra),defs=new Map();
  let M=K.model(project,doc,defs);const row=M.rows("nets").find(r=>r.name==="CLK");
  const d0=M.metrics("nets",M.rows("nets").find(r=>r.name==="D0")).cells.widthMin;
  const set=JSON.parse(JSON.stringify(R.effective(doc,project)));
  const msg=K.setCell(set,"nets",row,"widthMin",.18,M);
  assert.ok(msg.includes(word),msg);
  R.store(doc,project,set);
  M=K.model(project,doc,defs);
  assert.equal(M.metrics("nets",M.rows("nets").find(r=>r.name==="CLK")).cells.widthMin,.18,"the edited value applies");
  assert.equal(M.metrics("nets",M.rows("nets").find(r=>r.name==="D0")).cells.widthMin,d0,"other nets keep their rule");
}
console.log("PASS constraints-promote: edits land on the rule that applies");
