"use strict";
const assert = require("node:assert/strict");
const data = new Map();
globalThis.localStorage = {getItem:key=>data.get(key) ?? null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
require("../fixtures/notebook-labs.cjs").enable();
for (const m of ["i18n", "model", "prefs", "blocks", "edit-selection", "selection-clipboard", "clip-history", "palette-personal"])
  require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const P = AtriumPalettePersonal, C = AtriumClipHistory, A = Atrium;

assert.deepEqual(P.saveAliases("cmd:grid","wire dot, Wire dot, layout-grid"),["wire dot","layout-grid"]);
assert.throws(() => P.saveAliases("cmd:undo","Layout-grid"), /already belongs/);
assert.throws(() => P.saveAliases("__proto__","invalid"), /Choose a command/);
assert.deepEqual(P.aliases("cmd:grid"),["wire dot","layout-grid"]);
P.saveAliases("cmd:grid","");
assert.deepEqual(P.aliases("cmd:grid"),[]);
const extKey="command:ext:example.divider:divider";
P.saveAliases(extKey,"vdivide"); assert.deepEqual(P.aliases(extKey),["vdivide"]);
assert.throws(()=>P.saveAliases("command:another-source:divider","no"));

const opened = [];
let presented, handler, scoped;
globalThis.AtriumHost = {openURL:target=>opened.push(target)};
globalThis.AtriumPalette = {present:(m,h)=>{presented=m; handler=h;},close(){},scope:(kind,text)=>{scoped={kind,text};}};
// The standalone JSC shell has no browser or WHATWG URL. Node and Chromium
// run these URL checks against the same production URL implementation.
if (typeof URL === "function") {
  const url = "https://example.test/find/{query}?q={query}", input = "10 kΩ & C=3#✦/Q";
  const encoded = encodeURIComponent(input);
  assert.equal(P.templateURL(url,input),"https://example.test/find/"+encoded+"?q="+encoded);
  assert.equal(P.templateURL("https://example.test?q={query}","x\uD800"),"https://example.test/?q=x%EF%BF%BD");
  for (const bad of ["javascript:alert(1)","file:///tmp/x","//example.test","https://{query}.test/","https://evil@example.test/","https://example.test\\@offsite.test/"])
    assert.throws(() => P.templateURL(bad,input),/full HTTP or HTTPS/);
  const link = P.saveLink({name:"Supplier",template:url});
  assert.throws(() => P.saveLink({name:"supplier",template:url}),/already exists/);
  assert.equal(opened.length,0,"settings and listing do not navigate");
  P.entries(null).find(e=>e.label==="Supplier").run({argument:input});
  assert.equal(presented.kind,"form");
  assert.equal(presented.fields[0].value,input);
  assert.equal(opened.length,0,"opening a quicklink form does not navigate");
  handler.submit({query:input});
  assert.deepEqual(opened,[P.templateURL(url,input)]);
  P.removeLink(link.id);
  assert.deepEqual(P.links(),[]);
}

for (const kind of ["schematic","pcb"]) {
  const project = A.project("Palette design"), doc = project.documents.find(d => d.kind === kind);
  const item = kind === "pcb" ? {id:"source",kind:"track",net:"SIG",layer:"Top",width:.3,points:[[1,1],[2,1]]} :
    {id:"source",kind:"wire",points:[[1,1],[2,1]]};
  doc.items.push(item);
  let edits = 0, selected;
  const context = {kind,docId:doc.id,point:[10,12],selection:[item.id],host:{doc:()=>doc,currentId:()=>doc.id,project:()=>project,
    defs:()=>new Map(),view:()=>null,canvas:()=>null,select:ids=>{selected=ids;},edit:edit=>{edits++; edit();},info(){}}};
  const save = P.entries(context).find(e=>e.key==="personal:save-snippet");
  save.run({context});
  handler.submit({name:"Probe assembly"});
  const durable = JSON.parse(data.get(C.STORE));
  assert.ok(durable.entries.some(x=>x.kind===kind&&x.name==="Probe assembly"&&x.pinned));
  assert.equal(edits,0,"saving a snippet is a personal setting");
  const snippet = P.entries(context).find(e=>e.kind==="insert"&&e.label==="Probe assembly");
  assert.ok(snippet);
  snippet.run({context});
  assert.equal(edits,1);
  assert.equal(doc.items.length,2);
  assert.ok(selected.includes(doc.items[1].id));
  assert.notEqual(doc.items[1].id,item.id);
  assert.deepEqual(doc.items[1].points[0],context.point.map(n=>A.snap(n,doc.grid)));
  assert.throws(() => snippet.run({context:{...context,docId:"elsewhere"}}),/Return to the document/);
  assert.equal(edits,1);

  const actions = P.fallback({context,query:"custom_net?"});
  actions.find(e=>e.key==="personal:search:provider").run({context,query:"custom_net?"});
  assert.deepEqual(scoped,{kind:"provider",text:"custom_net?"});
  assert.equal(P.fallback({context,query:"x",scope:"provider"}).length,0);
  const label = actions.find(e=>e.key==="personal:create:"+(kind==="pcb"?"text":"net"));
  label.run({context,query:"custom_net?"});
  assert.equal(doc.items.at(-1).text,"custom_net?");
  assert.equal(doc.items.at(-1).kind,kind==="pcb"?"label":"netlabel");
  assert.equal(edits,2);

  if (kind === "pcb") {
    const block = {format:"atrium-block",version:1,id:"sensor-layout",name:"Sensor routing",size:[4,3],library:[],
      items:[{id:"route",kind:"track",net:"SIG",layer:"Top",width:.3,points:[[0,0],[2,0]]}]};
    project.layoutBlocks = [block];
    P.entries(context).find(e=>e.label===block.name).run({context});
    assert.match(doc.items.at(-1).net,/^B\d+\/SIG$/,"layout blocks retain their separate-net policy");
    assert.equal(edits,3);
  }
}

console.log("Palette preferences: aliases, safe quicklinks, clipboard snippets, placement, and explicit fallbacks");
