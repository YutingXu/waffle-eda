"use strict";

const assert = require("node:assert/strict");
const {fixture, options} = require("../notebook/smart-pdf.cjs");
for (const name of ["uuid-v7","link-record","vendor/notebook-fonts/faces","notebook-fonts","note-fields","notebook","rich-text-view"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const project = fixture(), [doc] = project.documents;
project.id ??= AtriumUUID.next();
const note = {id:AtriumUUID.next(),kind:"textframe",x:50,y:55,w:55,h:30,size:2.7,border:false};
const href = AtriumLinkRecord.format({projectId:project.id,objectId:note.id});
note.richText = {font:"sans",blocks:[{style:"paragraph",runs:[
  {type:"text",text:"Review this schematic note",href},
  {type:"text",text:"Rejected path",href:href+"?path=/tmp/elsewhere.waffle"}
]}]};
doc.items.push(note);
assert.equal(AtriumNotebook.safeURL(href),href);
assert.equal(AtriumNotebook.safeURL(note.richText.blocks[0].runs[1].href),"");
const bytes = flag => new TextDecoder("latin1").decode(AtriumPrint.build(project,
  {...options, documents:[doc.id],recordLinks:flag}).bytes({compress:false}));
assert.ok(!bytes(false).includes(href));
const linked = bytes(true);
assert.ok(linked.includes(href));
assert.ok(!linked.includes("?path=/tmp"));
console.log("Smart PDF uses the note’s actual vector link rectangle and accepts only a canonical opt-in Waffle record URI.");
