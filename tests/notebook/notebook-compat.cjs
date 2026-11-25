"use strict";
const assert=require("node:assert/strict");
const {nativeRoundTrip}=require("../support/native-cad.cjs");
for(const file of ["model","parts","sch-objects","hierarchy","multichannel","messages","erc","note-fields","notebook","edit-selection","selection-clipboard"]) require(require("../support/app-source-paths.cjs").appFile(file+".js"));
const p=Atrium.project("Notebook compatibility",AtriumParts.catalogue),d=p.documents[0],def=p.library.find(v=>v.prefix==="R");
const part={id:"resistance",kind:"part",def:def.id,link:"test-link",ref:"R1",value:"4k7",x:12,y:9,angle:0};
d.items.push(part,{id:"signal",kind:"netlabel",x:7,y:9,text:"REF"},{id:"wire",kind:"wire",points:[[7,9],[12,9]]});
const electrical=project=>{
  const h=AtriumHierarchy.compile(project),e=AtriumERC.run(project);
  return {nets:h.nets.map(n=>[n.name,n.pins.map(v=>[v.part.id,v.pin.number])]),erc:e.messages.filter(v=>v.check!=="summary").map(v=>[v.check,v.text])};
};
const before=electrical(p),source="Threshold {R1.Value}",note={id:"note",kind:"textframe",x:6,y:4,w:40,h:19,text:source,richText:AtriumNotebook.textBody(source)};
note.richText.blocks[0].runs=AtriumNotebook.parseInline(source,p,d);d.items.push(note);
assert.deepEqual(electrical(p),before,"notes leave physical nets and ERC unchanged");
const reopened=nativeRoundTrip(p);
assert.deepEqual(reopened.documents[0].items.at(-1),note,"the native note preserves its owner, bounds, source, runs and bindings");
assert.deepEqual(electrical(reopened),before,"reopening a native note leaves the electrical model intact");
assert.equal(AtriumNotebook.read(Atrium.validate(reopened)).rows[0].text,"Threshold 4k7");
const defs=new Map(p.library.map(v=>[v.id,v]));
function copy(ids,target=p,targetDoc=d) {
  const captured=AtriumEditSelection.capture(d,defs,new Set(ids),false,null,p);
  const packet=AtriumSelectionClipboard.encode(captured,"stable-test-origin");
  const clip=AtriumSelectionClipboard.decode(packet.data);
  return AtriumEditSelection.prepare(target,targetDoc,clip,new Map(target.library.map(v=>[v.id,v]))).items;
}
const together=copy([part.id,note.id]),pair=together.find(i=>i.richText).richText.blocks[0].runs[1].binding;
assert.equal(pair.itemId,together.find(i=>i.kind==="part").id);assert.notEqual(pair.itemId,part.id);
const same=copy([note.id])[0].richText.blocks[0].runs[1];
assert.equal(AtriumNoteFields.resolve(p,d,same.expression,same.binding).text,"4k7");
const foreign=Atrium.clone(p),external=copy([note.id],foreign,foreign.documents[0])[0].richText.blocks[0].runs[1];
assert.equal(external.binding.detached,true);assert.equal(AtriumNoteFields.resolve(foreign,foreign.documents[0],external.expression,external.binding).broken,true);
console.log("PASS native 2.0 note load/save, unchanged electrical/ERC results, copied internal bindings and detached external clipboard references");
