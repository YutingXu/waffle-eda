"use strict";
const assert=require("node:assert/strict");
for(const name of ["model","source-file","note-fields","notebook","widget-catalogue","sheet-widgets","table-data","table-exchange","table-visual","format-2-codec","format-2-units","format-2-values","format-2-model","table-format","folder-project-engine"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const T=AtriumTableData,F=AtriumFormat2,M=AtriumFormat2Model,V=AtriumTableVisual,N=AtriumNotebook;
const p=Atrium.project("Inspection"),doc=p.documents[0],second=p.documents[1],old=AtriumSheetWidgets.make("table",[5,5]);
doc.name="Sheet";doc.items=[old];let counter=0,s=T.create(4,3,()=>"a"+(++counter));const [r1,r2,r3]=s.rows.map(x=>x.id),[c1,c2,c3]=s.columns.map(x=>x.id);
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8SUAAAAASUVORK5CYII=","base64");
const ref={sha256:F.sha256(png),byteLength:png.length,mediaType:"image/png"};
const rich=N.textBody("");rich.blocks[0].runs=N.parseInline("**Gain** $a^2$ {sheet.Title}",p,doc);
s=T.batch(s,[{rowId:r1,columnId:c1,content:{kind:"rich",richText:rich}},
  {rowId:r2,columnId:c1,content:{kind:"math",tex:"a^2"}},
  {rowId:r1,columnId:c2,content:{kind:"image",assetRef:ref,alt:"Inspection mark"}},
  {rowId:r3,columnId:c1,content:{kind:"link",label:"Board",target:{documentId:second.id,itemId:"connector"}}},
  {rowId:r2,columnId:c2,content:{kind:"link",label:"Drawing",url:"https://example.org/drawing"}}]);
assert.equal(AtriumTableExchange.plain(T.get(s,r1,c1).content),"Gain $a^2$ {sheet.Title}");
const item={...old,w:38,h:22,widget:{...old.widget,state:s}},born=M.createDocument({...doc,items:[item]}),bytes=F.serialize(born);
const reopened=M.document(M.parse(bytes)).items[0];
for(const cell of s.cells)assert.deepEqual(T.get(reopened.widget.state,cell.rowId,cell.columnId).content,cell.content);
assert.deepEqual(V.imageRequests(p,doc,item,[[5,5,18,22]]),[]);assert.equal(V.imageRequests(p,doc,item,[[20,5,30,9]])[0].ref.sha256,ref.sha256);
doc.items=[old];const root=M.createManifest(p,{id:"manifest",references:[{id:doc.id,kind:"document",docKind:"schematic",name:doc.name,path:"Sheet.wsch"}]});
const engine=AtriumFolderProjectEngine.create(),rec=(path,file)=>({path,bytes:F.serialize(file),sha256:F.sha256(F.serialize(file))});
(async()=>{
  const desktop=await engine.run({op:"manifest",record:rec("Project.waffle",root)});
  await engine.run({op:"owner",ref:desktop.members[0],record:rec("Sheet.wsch",M.createDocument(doc))});
  const result=await engine.run({op:"plan",changes:[{id:doc.id,kind:"schematic",put:[item],remove:[]}],
    attachments:[{ownerId:doc.id,assetRef:ref,assetToken:"verified-test-token"}]});
  assert.deepEqual(result.plan.map(entry=>entry.path).sort(),["Project.waffle","Sheet.wsch","assets/"+ref.sha256]);
  assert.equal(result.plan.find(entry=>entry.assetToken)?.assetToken,"verified-test-token");
  console.log("Portable cells reopened with rich fields, math, links and an exact SHA-256 image. Atomic first save contained the manifest, schematic and one original. Clipped-out images requested zero bytes.");
})().catch(e=>{console.error(e);process.exitCode=1;});
