"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {webcrypto}=require("node:crypto");
const bus={packet:null,writes:0,reads:0};
function desktop(){
  return {writeSelection:async p=>{bus.packet=p;bus.writes++;return true;},readSelection:async()=>{bus.reads++;return bus.packet;}};
}
// Independent editors with no shared JS scope.
function editor(host){
  const listeners={},doc={querySelector:()=>null,addEventListener:(name,fn)=>listeners[name]=fn};
  const env=vm.createContext({document:doc,window:{getSelection:()=>""},crypto:webcrypto,__waffleUUIDSeed:globalThis.__waffleUUIDSeed,structuredClone,navigator:{},AtriumHost:host});
  for(const name of ["uuid-v7","model","parts","placement","paste-plan","edit-selection","selection-clipboard"])vm.runInContext(fs.readFileSync(require("../support/app-source-paths.cjs").appFile(name+".js"),"utf8"),env);
  const {Atrium:A,AtriumEditSelection:E,AtriumSelectionClipboard:C}=env;
  let project=env.AtriumParts.example(),current=project.documents[1],clip=null,rev=0;
  const item=current.items.find(i=>i.kind==="part"),wire=current.items.find(i=>i.kind==="track");
  const ids=new Set([item.id,wire.id]);let reports=[],placements=[],memberCopies=[],cuts=0;
  const defs=()=>new Map(project.library.map(d=>[d.id,d]));
  const api=C.install({
    capture:cut=>E.capture(current,defs(),ids,cut),local:()=>clip,context:()=>current,revision:()=>rev,
    store:(v,cut)=>{clip=v;if(cut){current.items=current.items.filter(i=>!ids.has(i.id));cuts++;rev++;}},
    place:v=>{const plan=E.prepare(project,current,v,defs());placements.push(...plan.commit([15,20]));rev++;},
    memberFiles:files=>memberCopies.push(files),
    report:text=>reports.push(text)
  });
  return {env,project,current,doc,handlers:listeners,ids,item,wire,api,C,reports,placements,memberCopies,cuts:()=>cuts,clip:()=>clip,changed:()=>rev++,differentDocument:()=>{current=project.documents[0];}};
}
function event(target={}){const values=new Map();
  return {target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},clipboardData:{setData:(key,v)=>values.set(key,v),getData:key=>values.get(key)||""},values};
}
async function markupRoundTrip() {
  const source=editor(desktop()),target=editor(desktop()),empty=editor(desktop());
  for(const app of [source,target,empty])app.differentDocument();
  const photo={id:"photo",kind:"image",x:6,y:9,w:8,h:5,src:"data:image/png;base64,iVBORw0KGgo="};
  const mark={id:"mark",kind:"imageMarkup",imageId:photo.id,shape:"box",at:[100000,100000],to:[400000,400000],width:4000,colour:"#aa3344"};
  const sheet=app=>app.project.documents[0];
  sheet(source).items.push(photo,mark);
  sheet(target).items.push({...photo});
  source.ids.clear();source.ids.add(mark.id);
  await source.api.copy(false);
  assert.deepEqual(JSON.parse(bus.packet.data).origin,[photo.x,photo.y]);
  await target.api.paste();
  assert.deepEqual(target.reports,[]);
  const pasted=sheet(target).items.find(i=>i.id===target.placements[0]);
  assert.equal(pasted.imageId,photo.id);
  assert.equal(Object.hasOwn(pasted,"x"),false);
  assert.equal(JSON.stringify(pasted.at),JSON.stringify(mark.at));
  assert.equal(JSON.stringify(pasted.to),JSON.stringify(mark.to));

  await empty.api.paste();
  assert.equal(empty.placements.length,0);
  assert.match(empty.reports.at(-1),/image/i);

  source.ids.add(photo.id);
  await source.api.copy(false);
  await empty.api.paste();
  assert.equal(empty.placements.length,2);
  const image=sheet(empty).items.find(i=>i.id===empty.placements[0]);
  const relative=sheet(empty).items.find(i=>i.id===empty.placements[1]);
  assert.notEqual(image.id,photo.id);
  assert.deepEqual([image.x,image.y],[15,20]);
  assert.equal(relative.imageId,image.id);
  assert.equal(JSON.stringify(relative.at),JSON.stringify(mark.at));
  assert.equal(JSON.stringify(relative.to),JSON.stringify(mark.to));
}
async function run(){
  const left=editor(desktop()),right=editor(desktop());
  left.item.altiumSourceId=left.item.link="source-from-import";
  left.item.kicadSourceId="a1b2";left.item.kicadPath="/a1b2";left.wire.kicadSourceId="c3d4";
  assert.equal(bus.reads+bus.writes,0,"ordinary focus and startup never touch system clipboard");
  await left.api.copy(true);assert.equal(left.cuts(),1);assert.equal(left.current.items.find(i=>i.id===left.item.id),undefined);
  assert.ok(bus.packet.summary.includes(left.item.ref));assert.equal(JSON.parse(bus.packet.data).format,"atrium-selection");
  await left.api.paste();assert.deepEqual(left.placements,[...left.ids],"a cut can restore original IDs in its own document");
  assert.equal(left.current.items.find(i=>i.id===left.item.id).altiumSourceId,"source-from-import");
  await right.api.paste();assert.equal(right.placements.length,2);assert.ok(right.placements.every(id=>!left.ids.has(id)));
  assert.ok(right.current.items.find(i=>i.id===right.placements[0]&&i.kind==="part"&&i.ref!==left.item.ref));
  assert.equal(right.current.items.find(i=>i.id===right.placements[0]).altiumSourceId,undefined,"a pasted copy has its own physical identity");
  assert.equal(left.current.items.find(i=>i.id===left.item.id).kicadSourceId,"a1b2");
  assert.equal(left.current.items.find(i=>i.id===left.wire.id).kicadSourceId,"c3d4");
  for(const i of right.current.items.filter(i=>right.placements.includes(i.id))) {
    assert.equal(i.kicadSourceId,undefined);assert.equal(i.kicadPath,undefined);
  }
  right.env.Atrium.validate(right.project);
  const valid=bus.packet,count=right.placements.length;
  const files=[{name:"Independent.wpcb",data:"AQID"}];
  bus.packet={files};await right.api.paste();
  assert.deepEqual(right.memberCopies,[files],"a native file packet uses the project copy entry point");
  assert.equal(right.placements.length,count,"a native file paste never places objects");
  bus.packet={text:valid.summary+"\nWaffle-Selection/1\n"+valid.data};await right.api.paste();assert.equal(right.placements.length,count+2);
  for(const bad of [{text:"R1, 10k"},{text:valid.data},{data:"{}"},{data:valid.data.replace('"version":1','"version":8')},{data:valid.data.replace('"items":[','"items":[{},')}]){
    bus.packet=bad;await right.api.paste();assert.equal(right.placements.length,count+2);
  }
  bus.packet=valid;right.differentDocument();await right.api.paste();assert.match(right.reports.at(-1),/PCB layout/);
  const refused=editor({writeSelection:async()=>false,readSelection:async()=>null});
  await refused.api.copy(true);assert.equal(refused.cuts(),0);assert.ok(refused.current.items.some(i=>i.id===refused.item.id));
  const stale=editor({writeSelection:()=>new Promise(r=>setTimeout(()=>r(true),5)),readSelection:()=>new Promise(r=>setTimeout(()=>r(valid),5))});
  const pending=stale.api.copy(true);stale.changed();await pending;assert.equal(stale.cuts(),0);
  const reading=stale.api.paste();stale.differentDocument();await reading;assert.equal(stale.placements.length,0);
  const source=editor(undefined),target=editor(undefined),copy=event();source.handlers.copy(copy);
  assert.equal(copy.defaultPrevented,true);assert.equal(copy.values.size,2);
  assert.ok(copy.values.get("text/plain").includes(source.item.ref));assert.ok(source.clip().items.length);
  const rich=event();for(const [type,data] of copy.values)rich.values.set(type,data);
  target.handlers.paste(rich);assert.equal(target.placements.length,2);
  const textOnly=event();textOnly.values.set("text/plain",copy.values.get("text/plain"));target.handlers.paste(textOnly);assert.equal(target.placements.length,4);
  const form=event({closest:()=>({})});source.handlers.cut(form);assert.equal(form.defaultPrevented,false);assert.equal(source.cuts(),0);
  source.doc.querySelector=()=>({});const modal=event();source.handlers.copy(modal);assert.equal(modal.defaultPrevented,false);
  source.doc.querySelector=()=>null;source.env.window.getSelection=()=>"selected text";const text=event();source.handlers.copy(text);assert.equal(text.defaultPrevented,false);
  const unavailable=editor(undefined);unavailable.env.navigator.clipboard={writeText:async()=>{throw Error("Denied");}};
  await unavailable.api.copy(true);assert.equal(unavailable.cuts(),0);
  // No clipboard permission: the copy stays inside Waffle with a plain message, and Paste uses it.
  assert.ok(unavailable.clip()?.items.length,"the in-app clipboard keeps the selection");
  assert.match(unavailable.reports.at(-1),/^Copied inside Waffle; the system clipboard is unavailable, so nothing was cut\.$/);
  await unavailable.api.copy(false);assert.equal(unavailable.reports.at(-1),"Copied inside Waffle; the system clipboard is unavailable.");
  unavailable.env.navigator.clipboard.readText=async()=>{throw Error("Denied");};
  await unavailable.api.paste();assert.equal(unavailable.placements.length,2,"Paste falls back to the in-app clipboard");
  const cancelled=editor(undefined);cancelled.doc.execCommand=()=>false;
  await cancelled.api.copy(true);assert.equal(cancelled.cuts(),0);
  await markupRoundTrip();
  console.log("PASS two independent editors exchange validated PCB selections through native, MIME and typed-text clipboards. Local cut restores IDs, foreign paste regenerates IDs, read denial, stale requests and native text editing preserve selection.");
}
globalThis.__testDone=run().catch(error=>{console.error(error);process.exitCode=1;});
