"use strict";
const assert=require("node:assert/strict");
for(const n of ["model","source-file","table-data","calculation-intent","calculation-core","calculation-graph","calculation-records",
  "note-fields","calculation-design","table-formulas","table-exchange"])require(require("../support/app-source-paths.cjs").appFile(n+".js"));
const T=AtriumTableData,R=AtriumTableFormulas,X=AtriumTableExchange;
let id=0,s=T.create(5,5,()=>String(++id));const r=s.rows.map(x=>x.id),c=s.columns.map(x=>x.id),point=(ri,ci)=>({rowId:r[ri],columnId:c[ci]});
const p=Atrium.project("Inputs"),doc=Atrium.sheet("schematic","Sheet");p.documents=[doc];
doc.items=[{id:"r5",kind:"part",ref:"R5",value:"10 kΩ",pins:[]}];
const e=R.engine({project:p,doc,item:{id:"t"}});let status=e.compute(s,{revision:1});
const put=(ri,ci,text)=>{s=T.change(s,r[ri],c[ci],{content:text.startsWith("=")?status.bind(text):{kind:"literal",text}});};
put(0,0,"2");put(2,0,"4");put(0,1,"=SUM(A1:A3)");put(0,2,"=AVERAGE(A1:A3)");put(0,3,"=MIN(A1:A3)");put(0,4,"=MAX(A1:A3)");
put(1,1,"=IF(A1=2,B1,1/0)");put(1,2,"=B1*C1");put(3,0,"=A5");put(4,0,"=A4");put(4,2,"=R5.Value");
status=e.compute(s,{revision:1});
const value=(ri,ci)=>status.value(r[ri],c[ci]);
assert.deepEqual([value(0,1).value,value(0,2).value,value(0,3).value,value(0,4).value,value(1,1).value,value(1,2).value],[6,3,2,4,6,18]);
assert.equal(value(3,0).diagnostic.code,"cycle");assert.equal(value(4,0).diagnostic.code,"cycle");
assert.equal(value(4,2).value,10000);assert.equal(T.get(s,r[4],c[2]).content.references[0].target.itemId,"r5");
assert.equal(e.compute(s,{revision:1}).stats.visited,0);
put(1,0,"9");status=e.compute(s,{revision:1});
assert.equal(value(0,2).value,5);assert.equal(value(1,2).value,75);assert.equal(status.stats.visited,7);
const locked=R.scan(s,"=$A1+A$1+$A$1+B2");
assert.equal(R.copyTo(s,locked,point(0,0),point(1,1)).source,"=$A2+B$1+$A$1+C3");
const more=T.axis(s,"rows",0,1,true,()=>String(++id));
assert.equal(R.spelling(more,locked),"=$A2+A$2+$A$2+B3");
assert.equal(R.spelling(T.axis(s,"columns",0,1,false),locked),"=#REF!+#REF!+#REF!+A2");
const withUnits={...s,columns:s.columns.map((col,i)=>i===0?{...col,unit:"mm"}:col)};
const units=R.engine().compute(withUnits);assert.equal(units.value(r[0],c[1]).value,AtriumCalculationCore.evaluate("2 mm + 9 mm + 4 mm").value);
const bad=T.change(withUnits,r[1],c[0],{content:{kind:"literal",text:"4 A"}});
assert.equal(R.engine().compute(bad).value(r[1],c[0]).ok,false);
const pasted=X.paste(s,point(0,0),X.tsv('A\t"B\nC"\r\n=1+1\t"quote ""x"""'),()=>String(++id));
assert.deepEqual(T.get(pasted,r[1],c[0]).content,{kind:"literal",text:"=1+1"});
assert.equal(X.render(pasted,{rows:r.slice(0,2),columns:c.slice(0,2)},undefined,{csvOnly:true}),'A,"B\nC"\r\n=1+1,"quote ""x"""\r\n');
let wide=T.create(1001,2,()=>String(++id)),[input,output]=wide.columns.map(c=>c.id);
wide=T.batch(wide,wide.rows.slice(0,1000).map(row=>({rowId:row.id,columnId:input,content:{kind:"literal",text:"1"}})));
wide=T.change(wide,wide.rows[1000].id,input,{content:{kind:"literal",text:"not measured"}});
wide=T.change(wide,wide.rows[0].id,output,{content:R.scan(wide,"=AVERAGE(A1:A1001)")});
const broad=R.engine(),raw=broad.compute(wide);assert.equal(raw.value(wide.rows[0].id,output).value,1);
assert.equal(broad.compute(wide).stats.visited,0);
wide=T.change(wide,wide.rows[9].id,input,{content:{kind:"literal",text:"11"}});
const incremental=broad.compute(wide);assert.equal(incremental.value(wide.rows[0].id,output).value,1.01);assert.equal(incremental.stats.visited,2);
assert.equal(raw.value(wide.rows[0].id,output).value,1);

{
  let table=T.create(2,2,()=>String(++id));
  const [first,second]=table.rows.map(row=>row.id),[source,result]=table.columns.map(column=>column.id);
  table=T.batch(table,[{rowId:first,columnId:source,content:{kind:"literal",text:"2"}},
    {rowId:second,columnId:source,content:{kind:"literal",text:"not measured"}}]);
  const engine=R.engine(),before=engine.compute(table);
  assert.equal(before.value(second,source).ok,false);
  table=T.change(table,first,result,{content:R.scan(table,"=SUM(A1:A2)")});
  assert.deepEqual(engine.compute(table).value(first,result),R.engine().compute(table).value(first,result));
  assert.equal(engine.compute(table).value(first,result).value,2);
  assert.equal(before.value(first,result),undefined);
}

{
  require("../../app/history/undo-store.js");
  const U=AtriumUndoStore,board=Atrium.sheet("pcb","Board"),part=doc.items[0],history=[],future=[];
  const track={id:"track",kind:"track",width:.2,x1:0,y1:0,x2:3,y2:0,layer:"F.Cu"};
  board.items=[track];p.documents.push(board);
  U.reset(p);
  U.mark(p);
  const reportOptions={store:U};
  const item={id:"journal-table",widget:{state:s}};
  const read=revision=>R.report(p,doc,item,{...reportOptions,revision});
  const edit=(d,i,fn)=>{
    const before=U.mark(p);fn();U.checkpoint(history,future,before);U.record(p,{doc:d,items:[i]});
  };
  const initial=read(10);
  edit(board,track,()=>{track.width=.3;});
  const other=read(11);
  assert.equal(other.stats.evaluated,0);
  assert.equal(other.value(r[4],c[2]).value,10000);
  edit(doc,part,()=>{part.value="22 kΩ";});
  const changed=read(12);
  assert.equal(changed.stats.evaluated,1);
  assert.equal(changed.value(r[4],c[2]).value,22000);
  assert.equal(initial.value(r[4],c[2]).value,10000);
  assert(U.jump(history,future,U.mark(p),-1));
  assert.equal(read(13).value(r[4],c[2]).value,10000);
  assert(U.jump(history,future,U.mark(p),1));
  assert.equal(read(14).value(r[4],c[2]).value,22000);
  U.reset(p);part.value="not measured";U.mark(p);
  assert.deepEqual(read(15).value(r[4],c[2]),R.engine({project:p,doc,item}).compute(s,{revision:15}).value(r[4],c[2]));
  assert.equal(changed.value(r[4],c[2]).value,22000);
  U.reset();p.documents.pop();part.value="10 kΩ";
}

{
  let table=T.create(144,144,()=>String(++id));
  const formula=R.scan(table,"=1+1");
  table=T.batch(table,table.rows.flatMap(row=>table.columns.map(column=>({rowId:row.id,columnId:column.id,content:formula}))));
  const report=R.engine().compute(table);
  assert.equal(report.value(table.rows[0].id,table.columns[0].id).value,2);
  assert.equal(report.stats.visited,1);
}
if (process.argv.includes("--benchmark")) {
  const idle = [], changed = [], row = wide.rows[0].id;
  for (let i = 0; i < 100; i++) {
    let start = performance.now();
    assert.equal(broad.compute(wide).stats.visited,0);
    idle.push(performance.now()-start);
    wide = T.change(wide,wide.rows[9].id,input,{content:{kind:"literal",text:String(2+i%2)}});
    start = performance.now();
    const result = broad.compute(wide);
    changed.push(performance.now()-start);
    assert.equal(result.stats.visited,2);
    assert.ok(Math.abs(result.value(row,output).value-(1001+i%2)/1000)<1e-10);
  }
  function quantiles(values) {
    values.sort((a,b)=>a-b);
    return {sample:values.length,median:(values[49]+values[50])/2,p95:values[94],max:values.at(-1),raw:values};
  }
  console.log(JSON.stringify({endpoint:"table formula graph compute (milliseconds)", unchanged:quantiles(idle),oneChangedCell:quantiles(changed)}));
}
const numericProject={documents:[{id:"sheet",items:[{id:"table",kind:"textframe",widget:{type:"table",state:s}}]}],numericExpressions:[]};
const owner=numericProject.documents[0].items[0],nt=T.target("sheet","table",r[3],c[3]);
let adapter,registrations=0,drops=0;const numeric={registerTargetResolver(name,handler){
  assert.equal(name,"table-cell");adapter=handler;registrations++;return ()=>drops++;
}};
const unsubscribe=T.registerNumericFields(numeric);assert.equal(T.registerNumericFields(numeric),unsubscribe);assert.equal(registrations,1);
const service=adapter.resolve(numericProject,nt);assert.equal(service.owner,owner);assert.equal(service.read(),null);assert(service.write(3.2));assert.equal(service.read(),"3.2");
owner.widget.state=T.change(owner.widget.state,r[3],c[3],{style:{bold:true}});assert(service.write(null));assert.equal(T.get(owner.widget.state,r[3],c[3]).style.bold,true);
globalThis.AtriumNumericFields=numeric;numericProject.numericExpressions=[{target:nt}];
const original=owner.widget.state,next=T.change(original,r[3],c[3],{content:R.scan(original,"=12+3")});
T.clearReplacedNumericTargets(numericProject,"sheet",owner,original,next);owner.widget.state=next;
assert.equal(Object.hasOwn(numericProject,"numericExpressions"),false);assert.equal(adapter.resolve(numericProject,nt),null);assert.equal(service.write(1),false);
assert.equal(adapter.resolve(numericProject,{...nt,path:["cells","removed",c[3],"value"]}),null);
unsubscribe();assert.equal(drops,1);delete globalThis.AtriumNumericFields;
if(process.argv.includes("--numeric-peer")){
  const revision=process.argv[process.argv.indexOf("--numeric-peer")+1];
  assert.match(revision,/^[a-f0-9]{8,40}$/);
  const source=require("node:child_process").execFileSync("git",["show",revision+":app/editor/numeric-fields.js"],{encoding:"utf8"});
  require("node:vm").runInThisContext(source,{filename:"numeric-fields-"+revision+".js"});
  const peer=globalThis.AtriumNumericFields;
  owner.widget.state=T.change(s,r[3],c[3],{content:null});
  const recipient=peer.locate(numericProject,nt);
  assert.equal(recipient.owner,owner);assert.equal(recipient.read(),null);
  assert.equal(recipient.write(0),true);assert.equal(recipient.read(),"0");
  const entry={target:nt,source:"2*5",bindings:[]};peer.remember(numericProject,nt,entry);
  let authored=owner.widget.state;
  const styled=T.change(authored,r[3],c[3],{style:{italic:true}});
  T.clearReplacedNumericTargets(numericProject,"sheet",owner,authored,styled);
  owner.widget.state=styled;assert.equal(peer.stored(numericProject,nt),entry);
  const changedUnit={...styled,columns:styled.columns.map(column=>column.id===c[3]?{...column,unit:"V"}:column)};
  T.clearReplacedNumericTargets(numericProject,"sheet",owner,styled,changedUnit);owner.widget.state=changedUnit;
  assert.equal(peer.stored(numericProject,nt),undefined);assert.equal(recipient.read(),null);assert.equal(recipient.write(15),false);
  const volts=peer.locate(numericProject,nt);assert.equal(volts.unit,"V");assert.equal(volts.read(),"0");assert.equal(volts.write(5),true);
  owner.widget.state=styled;peer.remember(numericProject,nt,entry);assert.equal(volts.write(18),false);
  authored=T.change(styled,r[3],c[3],{content:R.scan(styled,"=12+3")});
  T.clearReplacedNumericTargets(numericProject,"sheet",owner,styled,authored);
  owner.widget.state=authored;
  assert.equal(peer.stored(numericProject,nt),undefined);
  assert.equal(peer.locate(numericProject,nt),null);assert.equal(recipient.write(8),false);
  owner.widget.state=T.axis(authored,"rows",3,1,false);
  assert.equal(peer.locate(numericProject,nt),null);assert.equal(recipient.write(9),false);
  console.log("Numeric controls "+revision+" passed stable zero, preserved style, changed-unit reads and writes, authored replacement and deleted-axis checks.");
}

{
  require("../../app/notebook/preferred-values.js");
  require("../../app/notebook/calculation-helpers.js");
  let table=T.create(4,5,()=>String(++id));
  const [first,,third,fourth]=table.rows.map(row=>row.id),[result,,,,seriesColumn]=table.columns.map(col=>col.id);
  table=T.batch(table,[{rowId:third,columnId:seriesColumn,content:{kind:"literal",text:"7"}},
    {rowId:fourth,columnId:seriesColumn,content:{kind:"literal",text:"1"}}]);
  const engine=R.engine();
  const check=(content,expected)=>{
    table=T.change(table,first,result,{content});
    assert.equal(engine.compute(table).value(first,result).value,expected,content.source);
  };
  for(const source of ["=log10(100)","=20*log10 (2)","=3.3k in E24","=3.3k in E3","=nearest E3 3.3k"]){
    const content=engine.compute(table).bind(source);
    assert.deepEqual(content.references,[],source);
    check(content,AtriumCalculationCore.evaluate(source.slice(1)).value);
  }
  check(engine.compute(table).bind("=E3"),7);
  check(engine.compute(table).bind("=SUM(E3:E4)"),8);
  const source="=E3+log10(100)";
  const old={...engine.compute(table).bind(source),references:[
    {type:"cell",span:[1,3],rowId:third,columnId:seriesColumn,absoluteRow:false,absoluteColumn:false},
    {type:"cell",span:[4,9],rowId:null,columnId:null,absoluteRow:false,absoluteColumn:false}
  ]};
  table=T.axis(table,"rows",2,1,true,()=>String(++id));
  assert.equal(R.spelling(table,old),"=E4+log10(100)");
  check(old,9);
}

{
  const project=Atrium.project("Qualified"),
    board=Atrium.sheet("schematic","Board"),other=Atrium.sheet("schematic","Other"),namedLikeCell=Atrium.sheet("schematic","D1");
  board.items=[{id:"board-r5",kind:"part",ref:"R5",value:"10k",pins:[]}];
  other.items=[{id:"other-r5",kind:"part",ref:"R5",value:"4k7",pins:[]}];
  namedLikeCell.items=[{id:"d1-r5",kind:"part",ref:"R5",value:"2k2",pins:[]}];
  project.documents=[board,other,namedLikeCell];
  let table=T.create(2,4,()=>String(++id));
  const rowId=table.rows[0].id,columnId=table.columns[0].id;
  const engine=R.engine({project,doc:board,item:{id:"qualified"}});
  const check=(content,expected)=>{
    table=T.change(table,rowId,columnId,{content});
    assert.equal(engine.compute(table,{revision:1}).value(rowId,columnId).value,expected,content.source);
  };
  const binding=source=>engine.compute(table,{revision:1}).bind(source);
  const otherValue=binding("=Other::R5.Value"),boardValue=binding("=Board::R5.Value");
  assert.deepEqual(otherValue.references.map(r=>[r.name,r.span,r.target?.itemId]),[["Other::R5.Value",[1,16],"other-r5"]]);
  check(otherValue,4700);
  check(boardValue,10000);
  check({kind:"formula",source:"=D1::R5.Value",references:[
    {type:"cell",span:[1,3],rowId,columnId:table.columns[3].id,absoluteRow:false,absoluteColumn:false},
    {type:"design",name:"R5.Value",span:[5,13],target:boardValue.references[0].target}
  ]},2200);
}
console.log("Table formula bindings, quantities, shared graph and clipboard passed.");
