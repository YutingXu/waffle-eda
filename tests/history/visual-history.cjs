"use strict";
const assert = require("node:assert/strict");
require("../../app/core/uuid-v7.js");
require("../../app/core/model.js");
require("../../app/history/undo-store.js");
require("../../app/history/history-edits.js");
const U=AtriumUndoStore, E=AtriumHistoryEdits;
const copy=x=>JSON.parse(JSON.stringify(x));
const p={format:"atrium",version:1,name:"Bench",library:[],documents:[
  {...Atrium.sheet("schematic","Power"),id:"s",items:[{id:"u",kind:"label",text:"U1",x:0,y:0,value:"A"}]},
  {...Atrium.sheet("pcb","Board"),id:"b",items:[{id:"r",kind:"label",text:"R1",x:2,y:0}]}]};
const h=[],f=[],doc=p.documents[0], board=p.documents[1], item=doc.items[0];
const host={project:()=>p,docById:key=>p.documents.find(d=>d.id===key),edit(fn,label){
  const mark=U.mark(p); fn(); U.checkpoint(h,f,mark,label); U.record(p); return true;
}};
const initial=copy(p);
host.edit(()=>{item.x=5;doc.name="Supply";},"Move U1");
const first=copy(p);
host.edit(()=>{item.value="B";doc.items.push({id:"t",kind:"label",text:"Filter",x:5,y:0});},"Label filter");
const second=copy(p);
U.peerPatch(p,()=>{item.y=17;item.value="Peer";board.items[0].x=18;U.record(p);});
let emitted=0;const off=U.onAuthored(()=>emitted++);
const v=U.viewState(h[0]), basic=v.project();
assert.deepEqual(basic,initial);
assert.deepEqual(U.viewState(h[1]).doc("s"), first.documents[0]);
assert.equal(emitted,0,"preview never publishes an edit or marks a folder dirty");
assert.equal(item.value,"Peer"); assert.equal(board.items[0].x,18);
const review=E.plan(p,basic,v.peers);
host.edit(()=>{item.x=12;board.name="Latest";doc.items.push({id:"z",kind:"label",text:"Newer",x:9,y:0});},"Later changes");
const preApply=copy(p), beforeSteps=h.length;
const result=E.restore(host,review,"Restore preview");
assert.ok(result.applied>0 && result.preserved>=3);
assert.equal(h.length,beforeSteps+1);
assert.equal(item.x,12);assert.equal(item.y,17);assert.equal(item.value,"Peer");
assert.equal(doc.name,"Power");assert.equal(board.name,"Latest");assert.equal(board.items[0].x,18);
assert.deepEqual(doc.items.map(i=>i.id),["u","z"]);
U.jump(h,f,U.mark(p),-1);assert.deepEqual(p,preApply,"one Undo restores the state just before Restore");
U.jump(h,f,U.mark(p),1);assert.deepEqual(doc.items.map(i=>i.id),["u","z"]);
const beforeFork=copy(p);
assert.equal(U.preserveLine(h[0],h,U.mark(p)),true);
assert.deepEqual(U.project(U.branches().at(-1).trees.at(-1)),beforeFork);
assert.equal(emitted>0,true); off();
const middle=copy(second), later=copy(second);
later.documents[0].items.push({id:"extra",kind:"label",text:"Newer",x:2,y:2});
middle.documents[0].items.reverse();
const mhost={project:()=>later,docById:key=>later.documents.find(d=>d.id===key),edit(fn){fn();return true;}};
E.restore(mhost,E.plan(second,middle),"Reorder");
assert.deepEqual(later.documents[0].items.map(i=>i.id),["t","u","extra"]);
console.log("PASS detached historic documents, guarded one-step restore, peer and later edits, forks and stable ordering");

const target=copy(second),actual=copy(second);
target.documents[0].items=[target.documents[0].items[1],{id:"x",kind:"label",text:"Inserted",x:3,y:3},target.documents[0].items[0]];
const ahost={...mhost,project:()=>actual};
E.restore(ahost,E.plan(second,target),"Reorder and insert");
assert.deepEqual(actual,target);

const bench={name:"Session",library:[],documents:[{id:"sheet",kind:"schematic",name:"Sheet",items:[]}]};
const local=[],redo=[],marks=[],expected=[];
U.reset(bench);
for(let i=0;i<90;i++) {
  const d=bench.documents[0], mark=U.mark(bench);
  marks.push(mark);expected.push(copy(bench));
  if(i%7===0)bench.library.push({id:"part"+i,symbol:{pins:[i]}});
  if(i%5===0 && d.items.length>2)d.items.splice(0,1);
  if(i%3===0)d.items.reverse();
  if(i%6===0)d.name="Sheet "+i;
  if(i%4===0 && d.items[0])d.items[0].text="V"+i;
  d.items.push({id:"i"+i,kind:"label",text:"N"+i,x:i});
  if(i%10===0)bench.documents.push({id:"pcb"+i,kind:"pcb",items:[],name:"Board "+i});
  U.checkpoint(local,redo,mark,"Change "+i);U.record(bench);
}
for(let i=0;i<marks.length;i++) {
  assert.deepEqual(U.viewState(marks[i]).project(),expected[i],"incremental/full snapshot at "+i);
  assert.deepEqual(U.viewState(marks[i]).doc("sheet"),expected[i].documents[0]);
  assert.deepEqual(U.libraryAt(marks[i]),expected[i].library);
}
const now=copy(bench);
U.jump(local,redo,U.mark(bench),-12);
assert.deepEqual(U.project(redo[0]),now);
const other=U.mark(bench);
bench.name="Alternate path";U.checkpoint(local,redo,other,"Branch");U.record(bench);
assert.deepEqual(U.project(U.branches().at(-1).trees.at(-1)),now);
console.log("PASS 90 mixed structural/field edits, redo and alternate tip match independent full snapshots");

// A later writer can return to the exact reviewed value. Keep their intent even through that ABA.
U.reset(bench);const reviewed=U.reviewMark(bench), edited=bench.documents[0].items[0];
const desired=copy(bench);desired.documents[0].items[0].text="earlier author";
const receipt=E.plan(bench,desired),old=edited.text;
edited.text="subsequent";U.record(bench);edited.text=old;U.record(bench);
const decision=E.restore({project:()=>bench},receipt,"Restore",U.sinceReview(reviewed));
assert.equal(decision.applied,0);assert.equal(edited.text,old);

const forked={name:"A",library:[],documents:[]},line=[],ahead=[];
U.reset(forked);
function writeName(name){
  const mark=U.mark(forked);forked.name=name;U.checkpoint(line,ahead,mark,name);U.record(forked);
}
writeName("B");writeName("C");writeName("D");
U.jump(line,ahead,U.mark(forked),-1);writeName("E");
const alternate=U.branches().at(-1).trees.at(-1),saved=line.slice(),prior=U.mark(forked);
assert.equal(U.project(alternate).name,"D");
writeName("D");
assert.ok(U.preserveLine(alternate,saved,prior));
assert.equal(U.project(U.branches().at(-1).trees.at(-1)).name,"E","forking at another line retains the current line");

// A retained branch must keep the state of every field below its fork after the active
// journal reuses those positions. Both stock branch adoption and previews use that path.
const branched=Atrium.project("Anchored"), sheet=branched.documents[0], past=[], next=[];
sheet.items.push({id:"a",kind:"label",text:"A",x:0,y:0},{id:"b",kind:"label",text:"B",x:0,y:0});
U.reset(branched);
const branchEdit=change=>{
  const mark=U.mark(branched); change(); U.checkpoint(past,next,mark); U.record(branched);
};
const move=(index,key,value)=>branchEdit(()=>{sheet.items[index][key]=value;});
move(1,"y",5);
const originalFork=copy(branched);
move(0,"x",15);
const originalTip=copy(branched);
U.jump(past,next,U.mark(branched),-1);
move(0,"x",8);
const retained=U.branches().at(-1);
U.jump(past,next,U.mark(branched),-2);
assert.deepEqual(U.project(retained.trees.at(-1)),originalTip,"the original tip survives the cut past its fork");
move(1,"y",100);move(0,"x",25);
const newTip=copy(branched);
assert.deepEqual(U.project(retained.fork),originalFork);
assert.deepEqual(U.viewState(retained.trees.at(-1)).project(),originalTip);
assert.ok(U.adopt(past,next,U.mark(branched),retained.trees.at(-1)));
assert.deepEqual(branched,originalTip,"stock branch switch restores the historical model");
assert.ok(U.jump(past,next,U.mark(branched),-1));
assert.deepEqual(branched,newTip,"one Undo reverses a branch switch");

// Independently validate the staged model before the transaction can touch the editor.
const invalid=copy(newTip);
invalid.documents[0].items[0].x="invalid";
const invalidPlan=E.plan(branched,invalid);
assert.throws(()=>E.restore({project:()=>branched,edit(){throw Error("live edit called");}},invalidPlan,"Invalid restore"),
  /would leave the design invalid/);
assert.deepEqual(branched,newTip);

{
  for (const file of ["source-file","table-data","history-panel","visual-history"]) require(require("../support/app-source-paths.cjs").appFile(file+".js"));
  const T=AtriumTableData, q=Atrium.project("Reviewed table"), doc=q.documents[0], past=[], future=[];
  let id=0;
  const seed=T.create(2,2,()=>String(++id)), [r0,r1]=seed.rows, [c0,c1]=seed.columns;
  const literal=text=>({kind:"literal",text});
  const first=T.batch(seed,[
    {rowId:r0.id,columnId:c0.id,content:literal("Original Alice")},
    {rowId:r0.id,columnId:c1.id,content:literal("Original Bob")}
  ]);
  const item={id:"table",kind:"textframe",text:"Parts",x:0,y:0,w:20,h:10,
    widget:{type:"table",state:T.validate(first),fallback:{type:"text",text:"Parts"}}};
  doc.items=[item];
  const initial=copy(q);
  U.reset(q);
  let revision=0;
  const host={
    project:()=>q, docById:()=>doc,
    edit(change,label,touched) {
      const mark=U.mark(q);
      change();U.checkpoint(past,future,mark,label);
      U.record(q,typeof touched==="function"?touched():touched);
      revision++;
      return true;
    }
  };
  function cell(row,column,patch,peer=false) {
    const prior=item.widget.state, next=T.change(prior,row.id,column.id,patch);
    const apply=()=>{item.widget={...item.widget,state:next};};
    const hints=[T.cellUndoScope(doc,item,prior,next)];
    if(peer) U.peerPatch(q,()=>{apply();U.record(q,hints);});
    else host.edit(apply,"Edit table cell",hints);
  }
  const content=(row,column)=>T.get(item.widget.state,row.id,column.id)?.content?.text;
  cell(r0,c0,{content:literal("Alice edit")});
  const alice=copy(q), beforeAlice=past[0], afterAlice=U.live(revision);
  assert.deepEqual(U.viewState(beforeAlice).project(),initial,"the table snapshot replays exactly");
  const snapshots=U.stats().tableSnapshots;
  const label=AtriumHistoryPanel.label(beforeAlice,afterAlice);
  assert.equal(label.label,"Edit table cell");assert.equal(label.count,1);
  assert.equal(U.stats().tableSnapshots,snapshots,"the timeline label needs no serialized table");
  const art=AtriumVisualHistory.affected(label,doc.id);
  assert.deepEqual(art.before[0].widget.state,initial.documents[0].items[0].widget.state);
  assert.deepEqual(art.after[0].widget.state,alice.documents[0].items[0].widget.state);

  const reviewed=E.plan(q,U.viewState(beforeAlice).project()), baseline=U.reviewMark(q);
  cell(r0,c1,{content:literal("Bob edit")},true);
  cell(r0,c0,{style:{bold:true}},true);
  const peerState=copy(q), previous=item.widget.state, view=U.viewState(beforeAlice);
  const includingPeers=E.plan(q,view.project(),view.peers);
  assert.deepEqual(includingPeers.ops.map(op=>op.after),["Original Alice"]);
  assert.equal(includingPeers.preserved,2,"Bob's cell and style paths survive current historical previews");
  assert.deepEqual(E.restore(host,reviewed,"Restore Alice",U.sinceReview(baseline)),{applied:1,preserved:0});
  assert.equal(content(r0,c0),"Original Alice");
  assert.equal(content(r0,c1),"Bob edit");
  assert.equal(T.get(item.widget.state,r0.id,c0.id).style.bold,true);
  assert.equal(T.get(previous,r0.id,c0.id).content.text,"Alice edit","indexed source cells remain immutable");
  assert.ok(U.jump(past,future,U.mark(q),-1));
  assert.deepEqual(q,peerState,"one stock Undo reverses a guarded restore");
  const restored=U.project(future.at(-1));
  cell(r1,c0,{content:literal("Fork edit")});
  const branch=U.branches().at(-1);
  assert.deepEqual(U.project(branch.trees.at(-1)),restored,"table cells at a retained fork match a full snapshot");
  assert.equal(content(r1,c0),"Fork edit");
  const beforeAppend=U.viewState(past.at(-1)).project(), withAppend=item.widget.state;
  const compact=U.stats().tableCells;
  assert.equal(E.restore(host,E.plan(q,beforeAppend),"Restore empty cell").applied,1);
  assert.equal(content(r1,c0),undefined);
  assert.equal(T.get(withAppend,r1.id,c0.id).content.text,"Fork edit");
  assert.equal(U.stats().tableCells,compact+1,"clearing the added cell is another compact edit");
  assert.ok(U.jump(past,future,U.mark(q),-1));
  assert.equal(content(r1,c0),"Fork edit");

  const current=item.widget.state, reordered=copy(q), expected=reordered.documents[0].items[0].widget.state;
  expected.cells.reverse();
  expected.cells[0].content=literal("Moved");
  assert.equal(E.restore(host,E.plan(q,reordered),"Restore order").applied,2);
  assert.deepEqual(item.widget.state,expected,"a structural history change retains exact sparse-cell order");
  assert.equal(T.get(current,r1.id,c0.id).content.text,"Fork edit","general restore does not mutate the old index");
  assert.equal(content(r1,c0),"Moved");
  const restoredRow=copy(q);
  const extra=T.axis(item.widget.state,"rows",2,1,true,()=>String(++id));
  const added=extra.rows.at(-1);
  restoredRow.documents[0].items[0].widget.state=T.change(extra,added.id,c0.id,{content:literal("Present before deletion")});
  assert.equal(E.restore(host,E.plan(q,restoredRow),"Restore row and cell").applied,2);
  assert.equal(content(added,c0),"Present before deletion");

  for (const axis of ["rows","columns"]) {
    const current=item.widget.state, existing=T.get(current,r0.id,c0.id);
    const expected=copy(q), wanted=expected.documents[0].items[0];
    wanted.x+=1;
    wanted.widget.state=T.change(wanted.widget.state,r0.id,c0.id,{content:literal("Reviewed earlier content")});
    const review=E.plan(q,expected), baseline=U.reviewMark(q);
    const peer=state=>U.peerPatch(q,()=>{
      item.widget={...item.widget,state};
      U.record(q,{doc,items:[item]});
    });
    peer(T.axis(current,axis,0,1,false));
    const recreated=T.axis(item.widget.state,axis,0,1,true,()=>current[axis][0].id);
    peer(T.change(recreated,r0.id,c0.id,{content:existing.content,style:existing.style}));
    assert.deepEqual(E.restore(host,review,"Restore with recreated "+axis,U.sinceReview(baseline)),{applied:1,preserved:1});
    assert.equal(content(r0,c0),existing.content.text);
    assert.equal(item.x,wanted.x);
  }
  console.log("PASS compact table history previews, labels, exact peer guards and guarded Undo and forks");
}


{
  // Older IDs and an occupied address must both block a stale write. A sibling
  // edit in the same reviewed restore can still apply.
  const T=AtriumTableData, literal=text=>({kind:"literal",text});
  for (const occupied of [true,false]) {
    const project=Atrium.project("Durable cell identity"), doc=project.documents[0];
    let i=0;
    const empty=T.create(2,2,()=>String(++i)), [row]=empty.rows, [column]=empty.columns;
    const state=occupied?T.change(empty,row.id,column.id,{content:literal("Common content")}):empty;
    const item={id:"table",kind:"textframe",x:0,y:0,w:20,h:10,text:"Input",
      widget:{type:"table",state,fallback:{type:"text",text:"Input"}}};
    doc.items=[item];
    const target=copy(project), revived=target.documents[0].items[0];
    revived.x=3;
    revived.widget.state=T.change(revived.widget.state,row.id,column.id,{content:literal("Reviewed earlier content")});
    const plan=E.plan(project,target);
    assert.equal(plan.ops.length,2);
    T.get(state,row.id,column.id); // The existing index may outlive a legacy item replacement.
    const replacement={id:"replacement-cell",rowId:row.id,columnId:column.id,content:literal("Common content")};
    if (occupied) state.cells[0]=replacement;
    else state.cells.push(replacement);
    const host={project:()=>project,edit(fn){fn();return true;}};
    assert.deepEqual(E.restore(host,plan,"Restore table identity"),{applied:1,preserved:1});
    assert.equal(item.x,3);
    assert.deepEqual(item.widget.state.cells,[replacement]);
  }

  for (const blocked of [false,true]) {
    const project=Atrium.project("Legacy cell relocation"), doc=project.documents[0];
    let i=0;
    const state=T.create(2,2,()=>String(++i)), [source,destination]=state.rows, [column]=state.columns;
    const previous={id:"legacy-cell",rowId:source.id,columnId:column.id,content:literal("Introduced on the older row")};
    state.cells=[previous];
    const item={id:"table",kind:"textframe",x:0,y:0,w:20,h:10,text:"Input",
      widget:{type:"table",state,fallback:{type:"text",text:"Input"}}};
    doc.items=[item];
    const target=copy(project), revived=target.documents[0].items[0];
    revived.x=3;
    revived.widget.state.cells[0].rowId=destination.id;
    const plan=E.plan(project,target);
    if (blocked) item.widget.state=T.change(state,destination.id,column.id,{content:literal("New occupant")});
    const host={project:()=>project,edit(fn){fn();return true;}};
    assert.deepEqual(E.restore(host,plan,"Restore cell position"),blocked?{applied:1,preserved:1}:{applied:2,preserved:0});
    assert.equal(item.x,3);
    assert.equal(item.widget.state.cells[0].id,"legacy-cell");
    assert.equal(item.widget.state.cells[0].rowId,blocked?source.id:destination.id);
    if (blocked) assert.equal(T.get(item.widget.state,destination.id,column.id).content.text,"New occupant");
  }
}
