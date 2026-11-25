"use strict";

const assert = require("node:assert/strict");
for (const name of ["model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model"])
  require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, p = Atrium.project("Additive metadata",[]);
const sheet = p.documents[0], row = name => ({id:Atrium.id(),name});
const savedQuery = {...row("Sheet items"),scope:{documentId:sheet.id},query:{languageVersion:1,source:"object"},columns:["kind"]};
const savedView = {...row("Review"),documentId:sheet.id,camera:{center:[1,2.5],scale:1.5,referenceScale:2,rotationRadians:0,flipped:false},
  viewport:{pixelWidth:1200,pixelHeight:800},selection:[],filter:{scope:{savedQueryId:savedQuery.id},mask:true,highlight:false}};
const slide = {...row("Intro"),notes:"Review this slide.",aspect:"16:9",source:{kind:"savedView",savedViewId:savedView.id}};
const link = {id:Atrium.id(),source:{objectId:sheet.id,documentId:sheet.id,kind:"schematic"},
  target:{projectId:p.id,objectId:savedQuery.id},label:"Open query"};
const anchor = {id:Atrium.id(),kind:"pin",documentId:sheet.id,ownerId:Atrium.id(),terminal:"1"};
const pdf = {id:Atrium.id(),sha256:"a".repeat(64),byteLength:128,title:"Bench datasheet",pageCount:2};
const note = {id:Atrium.id(),datasheetId:pdf.id,page:2,region:[10,20,30,40],type:"note",text:"Confirm the rating"};
const metadata = {savedQueries:[savedQuery],savedViews:[savedView],slides:[slide],links:{[link.id]:link},linkAnchors:{[anchor.id]:anchor},
  datasheets:[pdf],datasheetAnnotations:[note]};
const original = M.fromEditor(p);
assert.equal(original.manifest.header.formatVersion,"2.0");
const requested = {...p,...metadata};
const added = F.applyDelta(original.manifest,M.manifestEdits(original.manifest,requested));
assert.equal(added.changedRows,7);
assert.equal(added.file.header.formatVersion,"2.1");
assert.equal(added.file.header.requires,undefined);
const native = M.parse(F.serialize(added.file));
const project = M.manifest(native).project;
for (const key of Object.keys(metadata)) assert.deepEqual(project[key],metadata[key],key);
const oldKinds = Array.from(original.manifest.records(), r => r.kind);
const older = F.parse(F.serialize(native),{knownKinds:oldKinds});
const opaque = [savedQuery,savedView,slide,link,anchor,pdf,note];
const legacyEdit = F.edit(older,{header:{...older.header,name:"Read elsewhere"}});
for (const item of opaque) {
  assert.equal(older.isOpaque(item.id),true);
  assert.equal(legacyEdit.rawRecord(item.id),native.rawRecord(item.id));
}
const duplicate = {...requested,savedQueries:[savedQuery,savedQuery]};
assert.throws(() => M.manifestEdits(original.manifest,duplicate),/saved query record/i);
const malformed = {...requested,datasheetAnnotations:[{...note,region:[40,20,30,50]}]};
assert.throws(() => M.manifestEdits(original.manifest,malformed),/datasheetAnnotation record/i);
const wrong = F.create({...original.manifest.header,formatVersion:"2.0"},[
  ...original.manifest.records(),{kind:"projectSetting",id:Atrium.id(),key:"savedQueries",value:[savedQuery]},
],M.readOptions("project",p.id));
assert.throws(() => M.manifest(wrong),/reserved native savedQueries/i);
console.log("Seven optional metadata kinds preserve 2.0 owners and remain opaque to an older reader");
