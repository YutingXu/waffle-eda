"use strict";
const assert=require("node:assert/strict");
for(const name of ["model","source-file","sch-objects","hierarchy","multichannel","note-fields","notebook","diff","collab-crdt","undo-store",
  "widget-catalogue","sheet-widgets","table-data","table-exchange","table-visual"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const T=AtriumTableData,C=AtriumCollabCRDT,U=AtriumUndoStore;
let id=0,state=T.create(3,3,()=>String(++id));const [r1,r2,r3]=state.rows.map(r=>r.id),[c1,c2]=state.columns.map(r=>r.id);
const p=Atrium.project("Review"),d=p.documents[0],item={kind:"textframe",id:"table",x:0,y:0,w:40,h:25,text:"Input",widget:{type:"table",state,fallback:{type:"text",text:"Input"}}};
d.items=[item];
const update=(project,edit)=>{const result=structuredClone(project),owner=result.documents[0].items[0];owner.widget.state=edit(owner.widget.state);return result;};
const literal=(s,r,c,text)=>T.change(s,r,c,{content:{kind:"literal",text}});
const owner=project=>project.documents[0].items[0];
const table=project=>owner(project).widget.state;
const changed=update(p,s=>literal(s,r1,c1,"Design revision"));
const rows=AtriumDiff.compare(p,changed,{validate:false}).changes.filter(row=>row.category==="notes");
assert.equal(rows.length,1);assert.equal(rows[0].text,"Table cell A1 changed");assert.deepEqual(rows[0].fields,["cells",r1,c1]);
function concurrent(base,left,right) {
  const a=C.create({replica:"alice",project:base}),b=C.create({replica:"bob",project:base});
  const aa=a.commit(update(a.project(),left)),bb=b.commit(update(b.project(),right));a.receive(bb);b.receive(aa);
  assert.equal(C.canon(a.project()),C.canon(b.project()));
  const final=a.project().documents[0].items[0].widget.state;T.validate(final);return final;
}
const same=concurrent(p,s=>literal(s,r1,c1,"retained"),s=>T.change(s,r1,c1,{style:{bold:true}}));
assert.equal(T.get(same,r1,c1).content.text,"retained");assert.equal(T.get(same,r1,c1).style.bold,true);
const orphan=concurrent(p,s=>T.axis(s,"rows",0,1,false),s=>literal(s,r1,c1,"raced"));
assert.equal(orphan.cells.length,0);
const a={rowId:r1,columnId:c1},b={rowId:r2,columnId:c2},c={rowId:r3,columnId:c1};
const merged=concurrent(p,s=>T.join(s,a,b,()=>"one"),s=>T.join(s,{rowId:r2,columnId:c1},c,()=>"two"));
assert.equal(merged.merges.length,1);assert.equal(merged.merges[0].id,"one");
const sorted={...state,columns:state.columns.map((v,i)=>i===0?{...v,sortDirection:"desc"}:v)};
const values=(r)=>({[r1]:"5",[r2]:"14",[r3]:"9"}[r]);
assert.deepEqual(T.presentationRows(sorted,values).map(r=>r.id),[r2,r3,r1]);

// Match the live publisher: settle the committed item journal, consume its
// cursor, and patch back the replica projection when collaboration needs it.
function journal(replica, full) {
  const editor=structuredClone(replica.project()),doc=editor.documents[0],item=owner(editor),history=[],future=[];
  U.reset();U.mark(editor,{});U.prime();
  let cursor=U.itemEdits(editor,null,true).cursor;
  function patch(touched) {
    const patch=replica.preparePatch(editor,touched);
    patch.apply();U.record(editor,patch.scopes);
    cursor=U.itemEdits(editor,null,true).cursor;
  }
  return {editor,patch,commit(edit,reconcile,inspect,compact=false) {
    const before=U.mark(editor,{});
    const prior=item.widget.state;
    edit(item);
    U.checkpoint(history,future,before,"Edit table");
    U.record(editor,compact?T.cellUndoScope(doc,item,prior,item.widget.state):{doc,items:[item]});
    const range=U.itemEdits(editor,cursor,true);
    cursor=range.cursor;
    assert.equal(range.updates.length,1);
    inspect?.(range.updates[0]);
    const batch=replica.commit(editor,{updates:range.updates,reconcile});
    if(full) {
      const expected=full.commit(editor);
      assert.equal(C.canon(batch),C.canon(expected),"journal and full operations, order and stamps agree");
      assert.equal(C.canon(replica.project()),C.canon(full.project()));
    }
    if(batch?.related)patch(batch.related);
    return batch;
  }};
}
function agree(left,right) {
  assert.equal(C.canon(left.project()),C.canon(right.project()));
  return T.validate(table(left.project()));
}
const cross=(left,right,leftBatch,rightBatch)=>{
  if(rightBatch)left.receive(rightBatch,{author:right.replica});
  if(leftBatch)right.receive(leftBatch,{author:left.replica});
  return agree(left,right);
};
{
  const base=update(p,s=>literal(literal(s,r1,c1,"Before"),r1,c2,"Neighbour"));
  const left=C.create({replica:"alice",project:base});
  const validate=draft=>{
    const checked=Atrium.validate(draft),cell=owner(checked)?T.get(table(checked),r1,c1):null;
    if(cell?.content.aux)cell.content.aux.values[2].number=99;
    return checked;
  };
  const right=C.create({replica:"bob",project:base,validate}),control=C.create({replica:"control",project:base,validate});
  const editor=structuredClone(right.project()),full=structuredClone(control.project()),original=owner(editor);
  const comparePatch=batch=>{
    const result=right.receive(batch,{author:left.replica}),expected=control.receive(batch,{author:left.replica});
    const plan=right.preparePatch(editor,result.touched);
    plan.apply();control.patch(full,new Set(expected.touched));
    assert.deepEqual(editor,full,"remote scoped patch equals an independent validated complete projection");
    assert.equal(right.hiddenCount(),control.hiddenCount());
    assert.deepEqual(right.vv(),control.vv());
    return plan;
  };
  const styled=left.commit(update(left.project(),s=>T.change(s,r1,c1,{style:{bold:true}})));
  assert.deepEqual(comparePatch(styled).scopes.map(scope=>scope.items.map(item=>item.id)),[[original.id]]);
  assert.equal(owner(editor),original);
  assert.deepEqual(T.get(table(editor),r1,c1).style,{bold:true});
  const op=styled.ops[0];
  let n=op.n,c=op.ts.c;
  const peer=(...changes)=>({from:left.replica,ops:changes.map(change=>({...op,...change,n:++n,ts:{c:++c,r:left.replica}}))});
  const widget=original.widget;
  assert.deepEqual(comparePatch(styled).scopes,[],"duplicate delivery requires no patch");
  assert.deepEqual(comparePatch(peer({})).scopes,[],"a peer's same-value write requires no editor patch");
  assert.equal(original.widget,widget);
  const sparse=new Array(3);
  sparse[1]=undefined;sparse[2]={number:-0,bad:Infinity,omitted:undefined};
  const content={kind:"literal",text:"Measurement \ud800",aux:{values:sparse}};
  comparePatch(peer({k:"content",v:content}));
  const values=T.get(table(editor),r1,c1).content.aux.values;
  assert.deepEqual(values,[null,null,{number:0,bad:null}],"the ledger and validation draft agree on JSON normalization");
  assert.deepEqual(T.get(table(right.raw()),r1,c1).content.aux.values,values,"validator mutations stay in its detached draft");
  values[2].number=7;
  assert.equal(T.get(table(right.raw()),r1,c1).content.aux.values[2].number,0,"editor mutations cannot change the ledger");
  values[2].number=0;
  comparePatch(peer({o:original.id,k:"text",v:"Mixed"},{k:"style",v:{italic:true}}));
  assert.equal(original.text,"Mixed");
  const neighbour=op.o.slice(0,-T.cellId(r1,c1).length)+T.cellId(r1,c2);
  comparePatch(peer({o:neighbour,k:"columnId",v:c1}));
  assert.equal(owner(editor),undefined,"two cell IDs at one position do not enter the editor");
  comparePatch(peer({k:"style",v:{bold:true}}));
  assert.equal(owner(editor),undefined,"a later scoped projection also rejects the duplicate position");
  comparePatch(peer({o:neighbour,k:"columnId",v:c2}));
  assert.ok(owner(editor));
  assert.deepEqual(T.get(table(editor),r1,c1).content.aux.values,values,"recovery retains the original detached values");
  const invalid=peer({v:{bold:"invalid"}});
  // The complete model filtering sets the owner aside; the plan removes it from its list as a delete would.
  assert.deepEqual(comparePatch(invalid).scopes.map(scope=>scope.items.length),[0],"invalid table fields go through complete model filtering");
  assert.equal(right.hiddenCount(),1);
  assert.equal(owner(editor),undefined);
}
{
  const base=update(p,s=>literal(s,r1,c1,"Before"));
  const left=C.create({replica:"alice",project:base}),full=C.create({replica:"alice",project:base}),right=C.create({replica:"bob",project:base});
  const J=journal(left,full);
  cross(left,right,J.commit(item=>{item.text="Measured";}));
  const cell=J.commit(item=>{item.widget.state=literal(item.widget.state,r1,c1,"Published");});
  assert.equal(cell.ops.length,1);
  assert.equal(T.get(cross(left,right,cell),r1,c1).content.text,"Published");
  const undo=left.undo();assert.deepEqual(undo,full.undo());
  J.patch(left.touches(undo));
  assert.equal(T.get(cross(left,right,undo),r1,c1).content.text,"Before");
  const redo=left.redo();assert.deepEqual(redo,full.redo());
  J.patch(left.touches(redo));
  assert.equal(T.get(cross(left,right,redo),r1,c1).content.text,"Published");
  const editCell=(text,inspect)=>J.commit(item=>{item.widget.state=literal(item.widget.state,r1,c1,text);},undefined,inspect,true);
  const checkSource=update=>{
    assert.equal(update.tableEdit.before.id,T.cellId(r1,c1));
    assert.equal(update.tableEdit.after.id,update.tableEdit.before.id);
    assert.ok(update.tableEdit.beforeVersion);assert.ok(update.tableEdit.afterVersion);
  };
  cross(left,right,editCell("After redo",checkSource));
  cross(left,right,editCell("Repeat",update=>{
    checkSource(update);
    // A warm exact edit never needs to decode either large item snapshot.
    const unexpected=()=>assert.fail("the verified warm cell edit read the full journal item");
    Object.defineProperties(update,{before:{get:unexpected},after:{get:unexpected}});
    Object.defineProperties(update.tableEdit,{beforeJSON:{get:unexpected},afterJSON:{get:unexpected}});
  }));
  let verifiedWithoutToken=false;
  cross(left,right,editCell("Missing journal version",update=>{
    checkSource(update);
    Object.defineProperties(update.tableEdit,{beforeVersion:{value:undefined},beforeJSON:{value:undefined}});
    const {get}=Object.getOwnPropertyDescriptor(update,"before");
    Object.defineProperty(update,"before",{get(){verifiedWithoutToken=true;return get();}});
  }));
  assert.equal(verifiedWithoutToken,true,"missing journal evidence requires checking the saved table");
  const peerChange=right.commit(update(right.project(),s=>T.change(s,r1,c2,{style:{bold:true}})));
  J.patch(left.receive(peerChange).touched);full.receive(peerChange);
  const postPeer=editCell("After peer edit",update=>{
    checkSource(update);
    Object.defineProperty(update,"before",{value:undefined});
  });
  assert.deepEqual(T.get(cross(left,right,postPeer),r1,c2).style,{bold:true});
  const mixed=J.commit(item=>{
    item.text="Title and cell";item.widget.state=literal(item.widget.state,r1,c1,"Mixed");
  },undefined,update=>assert.equal(update.tableEdit,undefined,"a cell hint cannot hide a change elsewhere in the item"));
  assert.equal(cross(left,right,mixed).cells.length,2);
  const insert=J.commit(item=>{item.widget.state=T.axis(item.widget.state,"rows",1,1,true,()=>"inserted");});
  assert.equal(cross(left,right,insert).rows[1].id,"inserted");
  const clear=J.commit(item=>{item.widget.state=T.change(item.widget.state,r1,c1,{content:null});});
  assert.equal(T.get(cross(left,right,clear),r1,c1),undefined);
  const rejected=J.commit(item=>{item.widget.state=literal(item.widget.state,r1,c1,"Locked");},ops=>{
    assert.deepEqual([...left.touches({ops})],[item.id]);
    J.patch(new Set([item.id]));
    return new Set([item.id]);
  });
  assert.equal(rejected,null,"rejecting a locked table also rejects its child operations");
  agree(left,right);
}
{
  const base=update(p,s=>literal(s,r1,c1,"Before"));
  const left=C.create({replica:"alice",project:base}),right=C.create({replica:"bob",project:base});
  const J=journal(left);
  const clear=J.commit(item=>{item.widget.state=T.change(item.widget.state,r1,c1,{content:null});});
  const bold=right.commit(update(right.project(),s=>T.change(s,r1,c1,{style:{bold:true}})));
  const after=cross(left,right,clear,bold);
  assert.equal(T.get(after,r1,c1).content,undefined);
  assert.deepEqual(T.get(after,r1,c1).style,{bold:true});
  const undo=cross(left,right,left.undo());
  assert.equal(T.get(undo,r1,c1).content.text,"Before");
  assert.deepEqual(T.get(undo,r1,c1).style,{bold:true});
  const redo=cross(left,right,left.redo());
  assert.equal(T.get(redo,r1,c1).content,undefined);
  assert.deepEqual(T.get(redo,r1,c1).style,{bold:true});
  assert.equal(T.get(cross(left,right,null,right.undo()),r1,c1),undefined);
}
{
  const left=C.create({replica:"alice",project:p}),right=C.create({replica:"bob",project:p});
  const put=left.commit(update(left.project(),s=>literal(s,r1,c1,"Authored")));
  right.receive(put);
  const bold=right.commit(update(right.project(),s=>T.change(s,r1,c1,{style:{bold:true}})));
  left.receive(bold);
  const after=cross(left,right,left.undo());
  assert.equal(T.get(after,r1,c1).content,undefined,"undo creating the cell withdraws its content");
  assert.deepEqual(T.get(after,r1,c1).style,{bold:true});
  assert.equal(T.get(cross(left,right,left.redo()),r1,c1).content.text,"Authored");
}
{
  const ids=["table-empty-row","row-b","table-empty-column","column-b"];
  const base=update(p,()=>T.create(2,2,()=>ids.shift()));
  const left=C.create({replica:"alice",project:base}),right=C.create({replica:"bob",project:base});
  const remove=(state,at)=>T.axis(T.axis(state,"rows",at,1,false),"columns",at,1,false);
  const aa=left.commit(update(left.project(),s=>remove(s,0))),bb=right.commit(update(right.project(),s=>remove(s,1)));
  const empty=cross(left,right,aa,bb),row=empty.rows[0].id,column=empty.columns[0].id;
  assert.notEqual(row,"table-empty-row","the placeholder does not reuse a removed axis ID");
  assert.notEqual(column,"table-empty-column");
  const J=journal(left);
  const title=J.commit(item=>{item.text="Empty";});
  assert.equal(title.ops.length,1,"a title edit leaves the placeholder unowned");
  cross(left,right,title);
  const insert=J.commit(item=>{item.widget.state=T.axis(item.widget.state,"rows",0,1,true,()=>"new-row");});
  const inserted=cross(left,right,insert);
  assert.deepEqual(inserted.rows.map(r=>r.id),["new-row",row]);
  assert.deepEqual(inserted.columns.map(c=>c.id),[column]);
  const undo=left.undo();
  J.patch(left.touches(undo));
  assert.equal(cross(left,right,undo).rows.length,1);
  const redo=left.redo();
  J.patch(left.touches(redo));
  assert.deepEqual(cross(left,right,redo).rows.map(r=>r.id),["new-row",row]);
  const put=J.commit(item=>{item.widget.state=literal(item.widget.state,"new-row",column,"On the placeholder column");});
  assert.equal(T.get(cross(left,right,put),"new-row",column).content.text,"On the placeholder column");
  const fresh=C.create({replica:"fresh",snapshot:JSON.parse(JSON.stringify(right.snapshot()))});
  agree(left,fresh);
}
{
  let n=0;
  const base=update(p,()=>T.create(T.limits.rows-1,T.limits.columns-1,()=>"axis-"+(++n)));
  const left=C.create({replica:"alice",project:base}),right=C.create({replica:"bob",project:base});
  const insert=(s,actor)=>T.axis(T.axis(s,"rows",s.rows.length,1,true,()=>actor+"-row"),"columns",s.columns.length,1,true,()=>actor+"-column");
  const aa=left.commit(update(left.project(),s=>insert(s,"alice"))),bb=right.commit(update(right.project(),s=>insert(s,"bob")));
  const capped=cross(left,right,aa,bb);
  assert.equal(capped.rows.length,T.limits.rows);assert.equal(capped.columns.length,T.limits.columns);
  assert.equal(capped.rows.at(-1).id,"alice-row");assert.equal(capped.columns.at(-1).id,"alice-column");
  const J=journal(left);
  const remove=J.commit(item=>{
    const s=item.widget.state;
    item.widget.state=T.axis(T.axis(s,"rows",s.rows.length-1,1,false),"columns",s.columns.length-1,1,false);
  });
  const revealed=cross(left,right,remove);
  assert.equal(revealed.rows.at(-1).id,"bob-row");assert.equal(revealed.columns.at(-1).id,"bob-column");
  assert.equal(C.canon(table(J.editor)),C.canon(revealed),"the local editor also reveals reserved axes");
  assert.equal(cross(left,right,left.undo()).rows.at(-1).id,"alice-row");
  assert.equal(cross(left,right,left.redo()).columns.at(-1).id,"bob-column");
}
console.log("Table collaboration: journal/full parity, peer edits, personal Undo/Redo, sparse styles, locks, axis replacement and limits passed.");
