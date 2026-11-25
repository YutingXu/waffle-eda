"use strict";

const assert=require("node:assert/strict");
require("../../app/project/source-file.js");
require("../../app/notebook/table-data.js");
require("../../app/history/undo-store.js");
const T=AtriumTableData,U=AtriumUndoStore;

let loads=0,workers=0;
const lazy=globalThis.AtriumLazy,worker=globalThis.Worker;
globalThis.AtriumLazy={need(){loads++;throw Error("Unexpected module request.");}};
globalThis.Worker=class {constructor(){workers++;throw Error("Unexpected worker.");}};
assert.equal(globalThis.AtriumNumericFields,undefined);

try{
  let n=0,s=T.create(3,2,()=>"id"+(++n));
  const [r1,r2]=s.rows.map(r=>r.id),[c1,c2]=s.columns.map(c=>c.id);
  s={...s,columns:s.columns.map(c=>({...c,unit:"Ω"}))};
  s=T.change(s,r1,c1,{content:{kind:"literal",text:"17"}});
  const docId="sheet",itemId="table",binding=(name,target)=>({source:name,target,storageUnit:"Ω",bindings:[]});
  const target=(row,column)=>T.target(docId,itemId,row,column);
  const main=binding("main",target(r1,c1)),sameColumn=binding("same column",target(r2,c1));
  const others=[binding("other column",target(r1,c2)),binding("other document",{...target(r1,c1),documentId:"other"}),
    binding("other widget",{...target(r1,c1),itemId:"other"}),binding("other path",{...target(r1,c1),path:["cells",r1,c1,"style"]})];
  const initial=[main,sameColumn,...others];
  const owner={id:itemId,kind:"textframe",widget:{type:"table",state:s}};
  let p={documents:[{id:docId,kind:"schematic",items:[owner]}],numericExpressions:initial};
  const history=[],future=[],item=()=>p.documents[0].items[0],state=()=>item().widget.state;
  const snap=()=>U.mark(p,{current:docId});
  function edit(next){
    const before=snap(),o=item();
    T.clearReplacedNumericTargets(p,docId,o,state(),next);
    o.widget={...o.widget,state:next};
    U.checkpoint(history,future,before,"Edit table");
    U.touch(p,{doc:p.documents[0],items:[o]});
  }
  function jump(delta){
    assert(U.jump(history,future,snap(),delta));
    p=U.root();U.touch(p);
  }
  function units(nextUnit){
    return {...state(),columns:state().columns.map(c=>c.id===c1?{...c,unit:nextUnit}:c)};
  }
  U.reset();
  const style=T.change(s,r1,c1,{style:{bold:true}});
  edit({...style,rows:[style.rows[1],style.rows[0],style.rows[2]],columns:style.columns.map(c=>({...c,widthNm:20000000}))});
  assert.equal(p.numericExpressions,initial);
  edit(T.change(state(),r1,c1,{content:{kind:"formula",source:"=4+5",references:[]}}));
  assert.deepEqual(p.numericExpressions,[sameColumn,...others]);
  assert.equal(history.length,2);
  jump(-1);
  assert.deepEqual(p.numericExpressions,initial);assert.equal(T.get(state(),r1,c1).content.text,"17");
  jump(1);
  assert.deepEqual(p.numericExpressions,[sameColumn,...others]);assert.equal(T.get(state(),r1,c1).content.source,"=4+5");
  jump(-1);
  edit(units("V"));
  assert.deepEqual(p.numericExpressions,others);assert.equal(T.get(state(),r1,c1).content.text,"17");
  jump(-1);assert.deepEqual(p.numericExpressions,initial);assert.equal(state().columns.find(c=>c.id===c1).unit,"Ω");
  jump(1);assert.deepEqual(p.numericExpressions,others);
  jump(-1);
  edit(units(""));assert.deepEqual(p.numericExpressions,others);
  jump(-1);
  edit(T.axis(state(),"rows",T.index(state()).rows.get(r2),1,false));
  assert.deepEqual(p.numericExpressions,[main,...others]);
  jump(-1);
  U.reset();history.length=0;future.length=0;
  p.numericExpressions=[main];
  edit(T.change(state(),r1,c1,{content:null}));
  assert.equal(Object.hasOwn(p,"numericExpressions"),false);
  jump(-1);assert.deepEqual(p.numericExpressions,[main]);
  assert.equal(globalThis.AtriumNumericFields,undefined);assert.equal(loads,0);assert.equal(workers,0);
  console.log("Cold table edit: exact target and changed-unit cleanup, one Undo/Redo, preserved other owners, zero module loads and zero workers.");
}finally{
  U.reset();
  if(lazy===undefined)delete globalThis.AtriumLazy;else globalThis.AtriumLazy=lazy;
  if(worker===undefined)delete globalThis.Worker;else globalThis.Worker=worker;
}
