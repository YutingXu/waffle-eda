"use strict";
// Project templates (templates.js) and the start page's recent-projects adapter (start-page.js).
const assert=require("node:assert/strict");
for(const m of ["model","parts","library-panel","footprint-wizard","starter-library","impedance","stackup","viastack","polygon-pour","rules","rigid-flex","fab-presets","fab-presets/jlcpcb","fab-profiles","templates","start-page"])
  require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const T=AtriumTemplates,A=Atrium,S=AtriumStackup,RF=AtriumRigidFlex;
const run=async()=>{
  const ids=T.list().map(t=>t.id);
  assert.deepEqual(ids,["blank","sheet-a4","sheet-a3","sheet-letter","sheet-infinite","2l-100x80-jlc","4l-impedance","shield","rigid-flex"]);
  for(const t of T.list()){assert.ok(t.title&&t.summary,t.id);if(t.id!=="blank" && !t.paper)assert.ok(t.outline.length>=4,t.id+" has an outline preview");}
  // Every template builds a project that validates and survives a JSON round trip.
  const built={};
  for(const id of ids){
    const p=await T.build(id,{name:"T "+id});
    assert.equal(p.name,"T "+id);A.validate(JSON.parse(JSON.stringify(p)));built[id]=p;
    assert.deepEqual(p.documents.map(d=>d.kind),["schematic","pcb"],id);
  }
  assert.equal(built.blank.documents[0].sheet, undefined, "blank keeps the fixed default");
  for (const size of ["A4","A3","Letter"]) assert.deepEqual(built["sheet-"+size.toLowerCase()].documents[0].sheet,{size});
  assert.deepEqual(built["sheet-infinite"].documents[0].sheet,{infinite:true});
  // Blank: the built-in catalogue only unless the starter library is asked for.
  assert.equal(built.blank.documents[1].outline.length,0);
  assert.equal(built.blank.library.length,AtriumParts.catalogue.length);
  const withStarter=await T.build("blank",{name:"S",starter:true});
  assert.equal(withStarter.library.length,AtriumParts.catalogue.length+AtriumStarterLibrary.count);
  // 2-layer 100 × 80 mm with JLC rules.
  const b2=built["2l-100x80-jlc"].documents[1];
  assert.deepEqual(A.bounds(b2.outline),[0,0,100,80]);
  assert.equal(b2.stackup.layers.filter(S.isCopper).length,2);
  assert.equal(b2.fabProfile.id,"jlcpcb-2l");
  const clearance=AtriumRules.stored(b2,built["2l-100x80-jlc"]).list.find(r=>r.type==="clearance");assert.ok(clearance,"clearance rule");
  // 4 layers with impedance profiles referenced to the planes.
  const b4=built["4l-impedance"].documents[1];
  assert.equal(b4.stackup.layers.filter(S.isCopper).length,4);
  assert.equal(b4.fabProfile.id,"jlcpcb-4l");
  const prof=S.impedanceProfiles(b4);assert.deepEqual(prof.map(p=>p.id),["se50","diff90","diff100"]);
  assert.deepEqual(prof[0].layers.Top.reference,[null,"Inner 1"]);
  // Shield: generic outline and four header rows placed on both documents, linked.
  const sh=built.shield,[ss,sb]=sh.documents;
  assert.deepEqual(A.bounds(sb.outline).map(v=>Math.round(v*100)/100),[0,0,68.58,53.34]);
  assert.equal(ss.items.filter(i=>i.kind==="part").length,4);assert.equal(sb.items.filter(i=>i.kind==="part").length,4);
  assert.deepEqual(sb.items.map(i=>i.link).sort(),ss.items.map(i=>i.link).sort());
  assert.ok(sh.library.some(d=>d.id==="starter-hdr-1x8"),"headers come from the starter library");
  assert.doesNotMatch(JSON.stringify(T.list()),/arduino/i,"no trademarks");
  // Rigid-flex: three regions, the middle one on the flex substack, one bend.
  const rf=built["rigid-flex"].documents[1],regions=RF.regions(rf);
  assert.equal(regions.length,3);
  assert.equal(regions.find(g=>RF.geometry.inside([50,15],g.points)).stack,"flex");
  assert.equal(rf.stackup.bends.length,1);
  // Preferences: units, grids and sheet defaults reach new projects.
  const pref=await T.build("blank",{name:"P",prefs:{"general.units":"mil","schematic.grid":2.54,"pcb.grid":.1,"schematic.sheetSize":"A3","schematic.titleBlock":"ansi"}});
  assert.equal(pref.units,"mil");assert.equal(pref.documents[0].grid,2.54);assert.equal(pref.documents[1].grid,.1);
  assert.deepEqual(pref.documents[0].sheet,{size:"A3",titleBlock:"ansi"});A.validate(pref);
  // Community templates: register, list, build, dispose.
  const reg=T.register({id:"demo",title:"Demo",outline:[[0,0],[10,0],[10,10]],build:ctx=>A.project(ctx.name,[])});
  assert.ok(T.list().some(t=>t.id==="demo"));assert.equal((await T.build("demo",{name:"D"})).name,"D");
  reg.dispose();assert.ok(!T.list().some(t=>t.id==="demo"));
  await assert.rejects(T.build("nope"),/Unknown template/);
  assert.throws(()=>T.register({id:"x"}),/build function/);

  // Recent projects use metadata without opening any project, with one native grant on click.
  const opened=[];
  globalThis.AtriumAutosave={recent:()=>[{slot:"s1",name:"Motor driver",path:"/p/motor.waffle",updated:Date.now()-120000}],refreshRecent:async()=>{},openRecent:s=>opened.push("slot:"+s)};
  let nativeFiles=["/p/motor.waffle",{path:"/p/other.waffle",openedAt:1234}], lookups=0;
  globalThis.AtriumHost={refreshRecentFiles:async o=>{assert.deepEqual(o,{metadataOnly:true});lookups++;return nativeFiles;},
    openRecent:(f,o)=>{assert.equal(o.activate,true);opened.push("host:"+(f.path||f));return [];}};
  let r=await AtriumStartPage.recent();
  assert.deepEqual(r.map(x=>x.name),["Motor driver","other"]);
  assert.equal(r[0].timeKind,"autosaved");
  assert.equal(r[1].when,1234);assert.equal(r[1].timeKind,"accessed");
  assert.equal(r[1].kind,"project");assert.equal(r[1].badge,null);assert.equal(r[1].thumbnail,null);
  assert.equal(opened.length,0);
  await r[0].open();await r[1].open();assert.deepEqual(opened,["host:/p/motor.waffle","host:/p/other.waffle"]);
  const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfL8AAAAASUVORK5CYII=";
  globalThis.AtriumRecent={list:async()=>[{name:"From store",path:"/q/a.wsch",modified:"2026-10-20T14:20:00Z",branch:"refs/heads/release",thumbnail:png},
    {file:"/q/board.PCBDoc ",thumbnail:"https://example.test/board.png",time:"9"}],open:e=>opened.push("recent:"+e.name)};
  nativeFiles=[{path:"/p/design.PrjPcb",openedAt:1234}, {path:"/p/board.wpcb"}];
  const pending=AtriumStartPage.recent();assert.strictEqual(AtriumStartPage.recent(),pending,"overlapping views share one read of each provider");
  r=await pending;
  assert.equal(lookups,2);
  assert.deepEqual(r.map(x=>x.name),["From store","design","board.PCBDoc ","board"]);
  assert.equal(r[0].kind,"schematic");assert.equal(r[0].badge,"release");assert.equal(r[0].badgeKind,"branch");
  assert.equal(r[0].timeKind,"modified");if(globalThis.atob)assert.equal(r[0].thumbnail,png);
  assert.equal(r[1].badge,"Altium");assert.equal(r[1].badgeKind,"format");
  assert.equal(r[2].path,"/q/board.PCBDoc ");assert.equal(r[2].when,null);assert.equal(r[2].thumbnail,null);
  assert.equal(r[3].kind,"pcb");assert.equal(r[3].when,null);
  await r[0].open();assert.equal(opened.at(-1),"recent:From store");
  nativeFiles=[];
  r=await AtriumStartPage.recent();assert.deepEqual(r.map(x=>x.name),["From store","board.PCBDoc "],"refreshed removals cannot leave stale rows");
  let scanned=0;
  globalThis.AtriumRecent.list=()=>({*[Symbol.iterator](){for(let n=0;n<200;n++){scanned++;yield {slot:"bounded-"+n,name:"Stored "+n,time:n+1};}}});
  r=await AtriumStartPage.recent();assert.equal(scanned,40);assert.equal(r.length,10);assert.equal(r[0].name,"Stored 39");
  const format=AtriumStartPage.formatRecentTime, now=new Date(2026,10,22,18,0).getTime();
  assert.match(format(new Date(2026,10,22,14,20).getTime(),now,"en-GB"),/^Today, 14:20$/);
  assert.equal(format(new Date(2026,10,21,8).getTime(),now,"en-GB"),"Yesterday");
  assert.equal(format(new Date(2026,10,16,8).getTime(),now,"en-GB"),"Monday");
  assert.equal(format(new Date(2026,10,14,8).getTime(),now,"en-GB"),"14 Nov");
  assert.equal(format(null,now,"en-GB"),"");
  delete globalThis.AtriumRecent;delete globalThis.AtriumAutosave;delete globalThis.AtriumHost;
  assert.deepEqual(await AtriumStartPage.recent(),[]);
  console.log("SHIM-OK start-page");
};
run().catch(e=>{console.log("SHIM-FAIL "+e.message+"\n"+e.stack);});
