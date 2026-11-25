"use strict";

// Run on the numeric branch with the table branch's app directory, or with no
// argument once both features are present. Only Node's built-in modules are used.
const assert=require("node:assert/strict"),path=require("node:path");
const app=path.resolve(__dirname,"../../app"),tables=path.resolve(process.argv[2] || app);
for(const name of ["model","source-file","note-fields","calculation-intent","calculation-core","query-fields","calculators",
  "calculation-helpers","calculation-records","calculation-graph","calculation-design","calculations","numeric-fields"])
  require(require("../support/app-source-paths.cjs").appFileFrom(app, name+".js"));
const T=require(path.join(tables,"table-data.js")),F=require(path.join(tables,"table-formulas.js"));
const N=globalThis.AtriumNumericFields;
async function run() {
  let next=0,state=T.create(1000,2,()=>"axis"+(++next));
  state={...state,columns:state.columns.map((c,i)=>i?c:{...c,unit:"mA"})};
  const [input,output]=state.columns.map(c=>c.id),[r1,r2,r3]=state.rows.map(r=>r.id);
  state=T.batch(state,state.rows.map(row=>({rowId:row.id,columnId:input,content:{kind:"literal",text:"1"}})));
  state=T.change(state,r1,input,{style:{italic:true}});
  state=T.change(state,r1,output,{content:F.scan(state,"=AVERAGE(A1:A1000)")});
  const doc=Atrium.sheet("schematic","Measured current"),project=Atrium.project("Shared table calculation");
  project.documents=[doc];
  const table={kind:"textframe",id:"table",widget:{type:"table",state}};doc.items.push(table);
  const graph=F.engine({project,doc,item:table}),runtime=()=>graph.compute(table.widget.state);
  assert.ok(Math.abs(runtime().value(r1,output).value-.001)<1e-12);
  assert.equal(runtime().stats.visited,0);
  const target=T.target(doc.id,table.id,r1,input);
  const num=(source,unit)=>N.evaluate(source,{unit},{project});
  const nextValue=await N.evaluate("5 mA + 6 mA",{target,unit:"mA"},{project});
  assert.equal(nextValue.value,11);
  assert.equal((await N.evaluate("5",{target},{project})).value,5);
  assert.equal((await N.evaluate("0.02 A",{target,unit:"A"},{project})).value,20);
  assert.equal((await N.evaluate("5 V",{target},{project})).diagnostic.code,"dimension");
  assert.equal(N.locate(project,target).write(nextValue.value),true);
  assert.deepEqual(T.readTarget(project,target).cell.style,{italic:true});
  const changed=runtime();
  assert.ok(Math.abs(changed.value(r1,output).value-.00101)<1e-12);
  assert.equal(changed.stats.visited,2);
  state=table.widget.state;
  for(const [row,formula] of [[r2,"=SUM(A1:A1000)"],[r3,"=IF(1=1,B2,1/0)"]])
    state=T.change(state,row,output,{content:F.scan(state,formula)});
  table.widget={...table.widget,state};
  const totals=runtime();
  for(const row of [r2,r3])assert.ok(Math.abs(totals.value(row,output).value-1.01)<1e-12);
  assert.equal((await num("250m","W")).value,.25);
  assert.equal((await num("250 mV","W")).diagnostic.code,"dimension");
  assert.equal((await num("2 ea + 3 pcs","ea")).value,5);
  assert.equal((await num("6 ea / 3 ea","")).value,2);
  assert.equal((await num("2 V / 2 V","ea")).diagnostic.code,"dimension");
  const otherTarget=T.target(doc.id,table.id,r2,output);
  const bind=(address,unit)=>N.remember(project,address,{version:1,target:address,source:"1",unit,storageUnit:unit,bindings:[],watches:[]});
  bind(target,"mA");bind(otherTarget,"");
  // A native record can be edited before the numeric control has finished loading.
  delete globalThis.AtriumNumericFields;
  try {
    const formatted=T.change(state,r1,input,{style:{bold:true}});
    T.clearReplacedNumericTargets(project,doc.id,table,state,formatted);
    assert.ok(N.stored(project,target));assert.ok(N.stored(project,otherTarget));
    const replaced=T.change(formatted,r1,input,{content:{kind:"literal",text:"42"}});
    T.clearReplacedNumericTargets(project,doc.id,table,formatted,replaced);
    assert.equal(N.stored(project,target),undefined);assert.ok(N.stored(project,otherTarget));
    bind(target,"mA");N.remember(project,otherTarget,null);
    const changedUnit={...replaced,columns:replaced.columns.map(c=>c.id===input?{...c,unit:"V"}:c)};
    T.clearReplacedNumericTargets(project,doc.id,table,replaced,changedUnit);
    assert.equal(project.numericExpressions,undefined);
  } finally {globalThis.AtriumNumericFields=N;}
  console.log("PASS registered numeric write, 1,000-input AVERAGE with two visited nodes, SUM, conditional division, field dimensions, tagged counts and cold authored replacements.");
}
run().catch(error=>{console.error(error);process.exitCode=1;});
