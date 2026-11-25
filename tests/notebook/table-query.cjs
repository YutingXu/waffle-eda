"use strict";
const assert=require("node:assert/strict"), path=require("node:path"), fs=require("node:fs");
const flag = process.argv.indexOf("--query-service-dir"), queryApp = flag < 0 ? path.resolve(__dirname,"../../app") : path.resolve(process.argv[flag+1]);
for(const n of ["model","source-file","table-data","table-query","calculation-intent","calculation-core","calculation-graph","table-formulas",
  "format-2-codec","format-2-units","format-2-values","format-2-model","table-format"])
  require(require("../support/app-source-paths.cjs").appFile(n+".js"));
const {appFileFrom} = require("../support/app-source-paths.cjs");
const serviceFile = name => flag < 0 ? appFileFrom(queryApp, name) : path.join(queryApp, name);
require(serviceFile("design-query.js"));
if (flag >= 0 || fs.existsSync(serviceFile("butter-query-service.js")))
  require(serviceFile("butter-query-service.js"));
const T=AtriumTableData,Q=AtriumTableQuery,M=AtriumFormat2Model,F=AtriumFormat2;
(async()=>{
  let counter=0,s=T.create(1,3,()=>String(++counter));
  const p=Atrium.project("Parts"),src=Atrium.sheet("schematic","Sources"),dest=Atrium.sheet("schematic","Table");
  p.documents=[src,dest];src.items=[
    {id:"first",kind:"part",ref:"R1",value:"10 kΩ",x:0,y:0},
    {id:"second",kind:"part",ref:"R2",value:"100 kΩ",x:10,y:0},
    {id:"near",kind:"part",ref:"U1",x:0,y:3}];
  const [name,value,note]=s.columns.map(c=>c.id);
  s.query=Q.definition({languageVersion:1,source:'part where designator like "R*"'},src.id,[{field:"designator",columnId:name},{field:"value",columnId:value}],s);
  let res=await Q.refresh(s,{project:p,revision:1});assert.equal(res.complete,true);assert.equal(res.count,2);s=res.state;
  const first=s.rows.find(r=>r.object.itemId==="first"),second=s.rows.find(r=>r.object.itemId==="second");
  s=T.change(s,first.id,note,{content:{kind:"literal",text:"external calibration"}});
  src.items=[{...src.items[0],ref:"R20"},src.items[2],{id:"third",kind:"part",ref:"R6",x:20,y:0}];
  res=await Q.refresh(s,{project:p,revision:2});assert(res.complete);assert.equal(res.count,2);assert.equal(res.removed,1);
  assert.equal(T.get(res.state,first.id,note).content.text,"external calibration");assert.equal(T.get(res.state,first.id,name).content.text,"R20");
  assert.equal(res.state.rows.find(r=>r.id===second.id).removed,true);
  const table={id:"t",kind:"textframe",x:1,y:1,w:60,h:30,widget:{type:"table",state:res.state,fallback:{type:"text",text:"Calibration"}}};
  const reopened=M.document(M.parse(F.serialize(M.createDocument({...dest,items:[table]})))).items[0].widget.state;
  assert.deepEqual(reopened.query,s.query);assert.equal(T.get(reopened,first.id,note).content.text,"external calibration");
  const blocked=await Q.refresh(reopened,{project:p,authority:{readProject:false},revision:3});
  assert.equal(blocked.complete,false);assert.equal(blocked.diagnostic.code,"denied");assert.equal(Object.hasOwn(blocked,"state"),false);
  const restricted=await Q.refresh(reopened,{project:p,authority:{canReadItem:id=>id!=="first"},revision:3});
  assert.equal(restricted.complete,false);assert.equal(restricted.diagnostic.code,"denied");assert.equal(Object.hasOwn(restricted,"state"),false);
  const clean=Q.clearRemoved(reopened);assert.equal(clean.rows.length,2);assert(!clean.rows.some(r=>r.id===second.id));
  src.items.push({id:"second",kind:"part",ref:"R8",x:12,y:0});
  const back=await Q.refresh(reopened,{project:p,revision:4});assert.equal(back.removed,0);assert.equal(back.state.rows.find(r=>r.object.itemId==="second").id,second.id);
  console.log("Live table: approved index, two original matches, rename retained user column, one removed row survived reopen, reappearance restored its identity; denied access published no rows.");
  if (globalThis.AtriumQueryService) {
    const savedQueryId=Atrium.id(), scope={documentId:src.id}, fields=s.query.fields;
    p.savedQueries=[{id:savedQueryId,name:"Resistors",scope,query:{languageVersion:1,source:'part where designator like "R*"'},columns:[]}];
    const saved=await Q.author(back.state,{project:p,documentId:src.id,savedQueryId,fields,queryEnabled:true,revision:5});
    assert.equal(saved.ok,true);
    assert.deepEqual(saved.query.scope,{savedQueryId});
    const bound={...back.state,query:saved.query};
    const rows=await Q.refresh(bound,{project:p,revision:5,queryEnabled:true});
    assert.equal(rows.complete,true);
    assert.equal(rows.state.rows.find(r=>r.object.itemId==="first").id,first.id);
    assert.equal(T.get(rows.state,first.id,note).content.text,"external calibration");
    p.savedQueries[0].query={languageVersion:1,source:'part where designator like "R2*"'};
    const fewer=await Q.refresh(rows.state,{project:p,revision:6,queryEnabled:true});
    assert.equal(fewer.complete,true);assert.equal(fewer.count,1);assert.equal(fewer.removed,2);
    assert.deepEqual(fewer.state.query.scope,{savedQueryId});
    const off=await Q.refresh(bound,{project:p,revision:7,queryEnabled:false});
    assert.deepEqual([off.complete,off.diagnostic.code,"state" in off],[false,"disabled",false]);
    const forbidden=await Q.refresh(bound,{project:p,revision:7,queryEnabled:true,authority:{readProject:false}});
    assert.deepEqual([forbidden.complete,forbidden.diagnostic.code,"state" in forbidden],[false,"denied",false]);
    console.log("Saved query service: exact scope, stable row identity, retained local edits, source revision, opt-in and denied access.");
  }
  if(flag<0)await mergeAndQuantities();
})().catch(e=>{console.error(e);process.exitCode=1;});

async function mergeAndQuantities(){
  const R=AtriumTableFormulas, project=Atrium.project("Live data"),
    source=Atrium.sheet("schematic","Parts"),board=Atrium.sheet("pcb","Board");
  project.documents=[source,board];project.parameters={Pitch:{value:12,unit:"mil"}};
  const a={id:"part-a",kind:"part",ref:"C1",value:"470 nF",x:0,y:0};
  const b={id:"part-b",kind:"part",ref:"R1",value:"2 kΩ",x:1,y:0};
  const c={id:"part-c",kind:"part",ref:"R2",value:"3 kΩ",x:2,y:0};
  const track={id:"trace",kind:"track",x1:0,y1:0,x2:2,y2:0,width:.2,layer:"F.Cu"};
  board.items=[track];
  let serial=0,revision=20;
  const make=()=>T.create(1,3,()=>"axis-"+(++serial));
  const refresh=state=>Q.refresh(state,{project,revision:++revision,queryEnabled:true});
  function quantity(state,rowId,columnId,output,expected,unit){
    const addressed=T.label(state,rowId,columnId), formula=R.scan(state,"="+addressed);
    const next=T.change(state,rowId,output,{content:formula});
    const result=R.engine().compute(next).value(rowId,output);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.ok(Math.abs(AtriumCalculationCore.as(result,unit)-expected)<1e-12);
  }
  const scopes=[{languageVersion:1,source:"part"}];
  if(globalThis.AtriumQueryService){
    project.savedQueries=[{id:"parts",name:"All parts",scope:{documentId:source.id},query:scopes[0],columns:[]}];
    scopes.push({savedQueryId:"parts"});
  }
  for(const scope of scopes){
    source.items=[a,c];let state=make();
    const [v,pitch,note]=state.columns.map(column=>column.id);
    state.query=Q.definition(scope,source.id,[{field:"value",columnId:v},{field:"Pitch",columnId:pitch}],state);
    const first=await refresh(state);assert.equal(first.complete,true,JSON.stringify(first));
    const rowOf=(hit,id)=>hit.rows.find(row=>row.object.itemId===id).id;
    const firstId=rowOf(first.state,a.id),thirdId=rowOf(first.state,c.id);
    state=T.batch(first.state,[
      {rowId:firstId,columnId:note,content:{kind:"literal",text:"first"}},
      {rowId:thirdId,columnId:note,content:{kind:"literal",text:"third"}}
    ]);
    state=T.join(state,{rowId:firstId,columnId:note},{rowId:thirdId,columnId:note});
    source.items.splice(1,0,b);
    const after=await refresh(state);
    assert.equal(after.complete,true,JSON.stringify(after));assert.equal(after.count,3);
    assert.equal(after.state.merges.length,0);
    assert.equal(T.get(after.state,firstId,note).content.text,"first");
    assert.equal(T.get(after.state,thirdId,note).content.text,"third");
    quantity(after.state,firstId,v,note,470e-9,"F");
    quantity(after.state,rowOf(after.state,b.id),v,note,2000,"Ω");
    quantity(after.state,firstId,pitch,note,12,"mil");
  }
  const table=make(),[width,output]=table.columns.map(column=>column.id);
  table.query=Q.definition({languageVersion:1,source:"track"},board.id,[{field:"width",columnId:width}],table);
  const traces=await refresh(table);
  assert.equal(traces.complete,true,JSON.stringify(traces));
  const row=traces.state.rows[0].id;
  assert.equal(T.get(traces.state,row,width).content.text,"0.2 mm");
  quantity(traces.state,row,width,output,.2,"mm");

  require("../../app/history/undo-store.js");
  const store=AtriumUndoStore,host={project:()=>project,revision:()=>revision};
  const prefs=globalThis.AtriumPrefs;
  globalThis.AtriumPrefs={get:key=>key==="butter.query"};
  store.reset(project);store.mark(project);
  try{
    for(const scope of scopes){
      const local=make(),[value]=local.columns.map(column=>column.id);
      local.query=Q.definition(scope,source.id,[{field:"value",columnId:value}],local);
      const projected=()=>Q.projected(local,{project,host,revision});
      const initial=await projected();assert.equal(initial.complete,true);
      track.width+=.05;store.record(project,{doc:board,items:[track]});revision++;
      assert.equal(await projected(),initial);
      b.value="5 kΩ";store.record(project,{doc:source,items:[b]});revision++;
      const modified=await projected();assert.notEqual(modified,initial);
      const sourceRow=modified.state.rows.find(row=>row.object.itemId===b.id);
      quantity(modified.state,sourceRow.id,value,local.columns[1].id,5000,"Ω");
      b.value="2 kΩ";store.record(project,{doc:source,items:[b]});revision++;
    }
  } finally {
    store.reset();
    if(prefs===undefined)delete globalThis.AtriumPrefs;else globalThis.AtriumPrefs=prefs;
  }
}
