"use strict";
// Live pours: incremental repour after edits, one undo step per edit (copper
// is derived data), redo kept, manual mode, pour-on-commit, affected() and
// stateOf() and the main-thread budget.
const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");

function load(names) {
  for (const name of names) require(appFile(name + ".js"));
}

load(["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "board-shape", "polygon-pour"]);
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const PP = AtriumPolygonPour, A = Atrium;
const rect = (x0, y0, x1, y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const rules = {format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.2,trackWidth:.15,viaDrill:.3},nets:{}};
const catalogue = new Map(AtriumParts.catalogue.map(p => [p.id,p]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const regionsOf = (doc, id) => (doc.pcbDrawing?.pours || []).filter(region => region.polygon === id);

function itemIds(prefix) {
  let next = 0;
  return () => prefix + (++next);
}

function via(id, x, y, net, diameter = .6) {
  return {id, kind:"via", x, y, net, diameter, drill:.3, layer:"Multi"};
}

// The host keeps user history separate from derived copper and can hold a drag.
function editor(project, definitions = catalogue, {emitChanges = true} = {}) {
  let revision = 0, dirty = false, redraws = 0, drag = null, selection = [];
  const history = [], future = [], infos = [], listeners = new Map();
  const snapshot = () => JSON.stringify(project);
  const changed = () => {
    revision++;
    dirty = true;
    if (emitChanges) for (const listener of listeners.get("change") || []) listener();
  };
  return {
    project: () => project, doc: () => project.documents.find(d => d.kind === "pcb"), defs: () => definitions,
    revision: () => revision, isDirty: () => dirty, info: message => infos.push(message), infos,
    registerAction() {}, invalidate() {}, redraw() { redraws++; },
    get redraws() { return redraws; }, get history() { return history.length; }, get future() { return future.length; },
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    selection: () => selection, drag: () => drag,
    setDrag(value, ids = []) { drag = value; selection = ids; },
    edit(fn) { const before = snapshot(); fn(); history.push(before); future.length = 0; changed(); },
    undo() { if (history.length) { future.push(snapshot()); project = JSON.parse(history.pop()); changed(); } },
    redo() { if (future.length) { history.push(snapshot()); project = JSON.parse(future.pop()); changed(); } },
    derive(fn) { const wasDirty = dirty; fn(); changed(); dirty = wasDirty; }
  };
}

async function until(check, description, {poll = 2, attempts = 4000, advance} = {}) {
  for (let k = 0; k < attempts && !check(); k++) {
    advance?.();
    await wait(poll);
  }
  assert.ok(check(), description);
}

const settled = () => !PP.live.busy && !PP.tiles.busy;
const settle = advance => until(settled, "live repour settles", {advance});

const TILE_FIXTURES = {
  hold: {title:"Fade hold", count:12, xStep:2.6, y:8, yStep:.5, pours:[["GND","Top",1,39]]},
  exact: {title:"Tiles live", count:16, xStep:2.2, y:6, yStep:.45, pours:[["GND","Top",1,25],["SIG","Top",15,39],["GND","Bottom",1,39]]}
};

async function tileEditor(name, id, {addItems, settleTiles = settle} = {}) {
  const {title, count, xStep, y, yStep, pours} = TILE_FIXTURES[name];
  const project = A.project(title, AtriumParts.catalogue), pcb = project.documents.find(d => d.kind === "pcb");
  pcb.outline = rect(0,0,40,25);
  pcb.rules = rules;
  pcb.items = Array.from({length:count}, (_, k) => via(id(), 3+k*xStep, y+(k%3)*yStep, k%2?"SIG":"GND"));
  addItems?.(pcb.items);
  pours.forEach(([net, layer, start, end], pourIndex) => pcb.items.push(PP.make(rect(start,1,end,24), {net,layer,pourIndex})));
  const defs = new Map(project.library.map(def => [def.id, def]));
  PP.apply(pcb, defs, {});
  const H = editor(project, defs);
  PP.tiles.enable(true);
  PP.live.setMode("live");
  PP.live.attach(H);
  PP.tiles.schedule();
  await settleTiles();
  await until(() => PP.tiles.state, "tile sessions built");
  return {H, defs};
}

async function incremental() {
  const defs = catalogue, id = itemIds("o");
  const makeVia = (x,y,net) => via(id(), x,y,net);
  const track = (points,net,layer="Top") => ({id:id(),kind:"track",points,width:.25,layer,net});
  function covered(doc,pid,x,y){
    const pip=(r,x,y)=>{let ins=false;const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++){const x1=r[2*j],y1=r[2*j+1],x2=r[2*i],y2=r[2*i+1];if((y1>y)!==(y2>y)&&x<x1+(y-y1)*(x2-x1)/(y2-y1))ins=!ins;}return ins;};
    return regionsOf(doc,pid).some(g=>{const rs=PP.rings(g);return pip(rs[0],x,y)&&!rs.slice(1).some(h=>pip(h,x,y));});
  }
  function board(){
    const d=A.sheet("pcb","Live");d.outline=rect(0,0,40,30);d.rules=rules;
    d.items.push(makeVia(5,5,"GND"),makeVia(30,20,"VCC"),track([[2,15],[12,15]],"SIG"));
    const a=PP.make(rect(1,1,20,29),{net:"GND",layer:"Top",pourIndex:0}),b=PP.make(rect(18,1,39,29),{net:"VCC",layer:"Top",pourIndex:1}),c=PP.make(rect(1,1,39,29),{net:"GND",layer:"Bottom",pourIndex:2});
    d.items.push(a,b,c);
    PP.apply(d,defs,{});
    return {project:{name:"Live",documents:[d]},a:a.id,b:b.id,c:c.id};
  }

  // 1. An edit repours only the affected pours, after the edit, in one undo step.
  {
    const {project,a,b,c}=board(),H=editor(project);PP.live.reset();PP.live.setMode("live");PP.live.attach(H);
    const before=JSON.stringify(H.doc().pcbDrawing.pours.filter(r=>r.polygon===c));
    assert.ok(covered(H.doc(),a,10,10),"GND pours under the new via position at first");
    H.edit(()=>{H.doc().items.push(makeVia(10,10,"SIG"));});
    assert.deepEqual(PP.stale(H.doc(),defs).sort(),[a,c].sort(),"the via touches the Top GND pour and the Bottom pour");
    assert.equal(PP.displayState(H.doc(),defs),"source","live mode keeps the last copper visible until the repour lands");
    assert.equal(PP.stateOf(H.doc(),defs).polygons[b],"poured");
    await settle();
    assert.deepEqual(PP.stale(H.doc(),defs),[],"nothing stale after the live repour");
    assert.ok(!covered(H.doc(),a,10,10),"the new via is cleared in the GND pour");
    assert.notEqual(JSON.stringify(H.doc().pcbDrawing.pours.filter(r=>r.polygon===c)),before,"the Bottom pour was repoured (multilayer via)");
    assert.deepEqual(PP.live.last.ids.sort(),[a,c].sort(),"only the affected pours were repoured");
    assert.equal(H.history,1,"the repour adds no undo step");
    // Undo restores the geometry and its matching copper together; redo too.
    H.undo();assert.deepEqual(PP.stale(H.doc(),defs),[],"undo: copper matches the restored board");
    assert.ok(covered(H.doc(),a,10,10),"undo brings the old copper back");
    await settle();assert.equal(H.future,1,"redo survives the live engine");
    H.redo();assert.deepEqual(PP.stale(H.doc(),defs),[]);assert.ok(!covered(H.doc(),a,10,10),"redo brings the repoured copper back");
    await settle();assert.equal(H.history,1);
  }
  // 2. Undo before the repour finished: the job is discarded, redo is kept,
  // and redoing the not-yet-repoured state repours it again.
  {
    const {project,a}=board(),H=editor(project);PP.live.reset();PP.live.setMode("live");PP.live.attach(H);
    H.edit(()=>{H.doc().items.find(i=>i.kind==="track").points=[[2,12],[16,12]];});
    H.undo();
    await settle();
    assert.equal(H.future,1,"redo kept");
    assert.deepEqual(PP.stale(H.doc(),defs),[]);
    H.redo();
    assert.ok(PP.stale(H.doc(),defs).includes(a),"the redone state was saved before its repour");
    await settle();
    assert.deepEqual(PP.stale(H.doc(),defs),[],"and is repoured now");
    assert.equal(H.history,1);assert.equal(H.future,0);
    H.undo();assert.equal(H.future,1);await settle();assert.equal(H.future,1,"still redoable");
  }
  // 3. Several quick edits coalesce; the latest state is poured.
  {
    const {project,a}=board(),H=editor(project);PP.live.reset();PP.live.setMode("live");PP.live.attach(H);
    for(let k=0;k<4;k++)H.edit(()=>{H.doc().items.find(i=>i.kind==="via"&&i.net==="GND").x=5+k;});
    await settle();
    assert.deepEqual(PP.stale(H.doc(),defs),[]);assert.equal(H.history,4);
  }
  // 4. Manual mode leaves pours stale and the canvas says so.
  {
    const {project,a}=board(),H=editor(project);PP.live.reset();PP.live.setMode("manual");PP.live.attach(H);
    H.edit(()=>{H.doc().items.push(makeVia(10,10,"SIG"));});
    await wait(20);await settle();
    assert.ok(PP.stale(H.doc(),defs).includes(a),"manual: still stale");
    assert.equal(PP.displayState(H.doc(),defs),"stale");
    assert.equal(PP.stateOf(H.doc(),defs).mode,"manual");
    PP.live.setMode("live");await wait(5);await settle();
    assert.deepEqual(PP.stale(H.doc(),defs),[],"switching to live repours what is stale");
    PP.live.reset();
  }
  // 5. A drawn pour fills when its outline is committed, in the same undo step.
  {
    const {project}=board(),H=editor(project);PP.live.reset();PP.live.setMode("manual");
    let placed;
    H.edit(()=>{placed=PP.place(H.doc(),defs,rect(2,2,15,10),{layer:"Inner 1",net:"GND"});});
    assert.ok(placed.regions.length>0,"the new pour has copper at once");
    assert.equal(PP.stateOf(H.doc(),defs).polygons[placed.item.id],"poured");
    assert.deepEqual(PP.stale(H.doc(),defs),[]);
    H.undo();assert.ok(!H.doc().items.some(i=>i.id===placed.item.id),"undo removes the pour");assert.equal(regionsOf(H.doc(),placed.item.id).length,0,"and its copper");
    H.redo();assert.ok(regionsOf(H.doc(),placed.item.id).length>0,"redo restores both");
    assert.throws(()=>PP.place(H.doc(),defs,[[0,0],[1,1]],{}),/outline/);
  }
  // 6. affected(): objects bring the pours their area reaches and later ones on that layer.
  {
    const {project,a,b,c}=board(),d=project.documents[0];
    const v=d.items.find(i=>i.kind==="via"&&i.net==="GND");
    assert.deepEqual(PP.affected(d,[v.id],defs),[a,b,c],"a via near A on every layer: A, B after it on Top, and C");
    const t=d.items.find(i=>i.kind==="track");
    assert.deepEqual(PP.affected(d,[t.id],defs),[a,b],"a Top track: Top pours only");
    assert.deepEqual(PP.affected(d,[b],defs),[b],"a polygon: itself and later pours on its layer");
    assert.deepEqual(PP.affected(d,[a],defs),[a,b]);
    const s=PP.stateOf(d,defs);
    assert.deepEqual(Object.keys(s.polygons).sort(),[a,b,c].sort());
    assert.ok(["live","manual"].includes(s.mode)&&Array.isArray(s.pending)&&Array.isArray(s.stale));
  }
  // 7. A pour added after the board was first seen (a paste, a script) is poured at once, in
  // the same undo step; a polygon the board already had unpoured (an imported zone) is left alone.
  {
    const {project,c}=board(),d0=project.documents[0],zone=PP.make(rect(2,2,8,8),{net:"GND",layer:"Bottom",pourIndex:3});
    d0.items=d0.items.filter(i=>i.id!==c).concat(zone);d0.pcbDrawing.pours=d0.pcbDrawing.pours.filter(r=>r.polygon!==c);
    const H=editor(project);PP.live.reset();PP.live.setMode("live");PP.live.attach(H);
    const pasted=PP.make(rect(22,12,38,28),{net:"VCC",layer:"Bottom",pourIndex:4});
    H.edit(()=>{H.doc().items.push(pasted);});
    await settle();
    assert.ok(regionsOf(H.doc(),pasted.id).length,"the new pour filled without Repour All");
    assert.equal(regionsOf(H.doc(),zone.id).length,0,"the zone the board was opened with stays unpoured");
    assert.equal(H.history,1,"pouring the new pour adds no undo step");
    PP.live.reset();
  }
  // 8. current(): Repour All would change nothing (the editor then adds no undo step).
  {
    const {project}=board(),d=project.documents[0];
    assert.equal(PP.current(d,defs),true,"freshly poured copper is current");
    const before=JSON.stringify(d.pcbDrawing);PP.apply(d,defs,{});assert.equal(JSON.stringify(d.pcbDrawing),before,"a repour of current copper is byte-identical");
    d.items.push(makeVia(10,10,"SIG"));assert.equal(PP.current(d,defs),false,"an edit under a pour makes it stale");
    PP.apply(d,defs,{});d.items.push(PP.make(rect(2,2,6,6),{net:"GND",layer:"Bottom",pourIndex:5}));assert.equal(PP.current(d,defs),false,"a pour never poured");
    PP.apply(d,defs,{});d.pcbDrawing.pours.push({layer:"Top",net:"GND",points:[0,0,1,0,1,1]});assert.equal(PP.current(d,defs),false,"imported copper is replaced by Repour All");
  }
  // 9. Main-thread budget on a 4-layer board with 10 pours: one track move.
  {
    const d=A.sheet("pcb","Budget");d.outline=rect(0,0,100,80);d.rules=rules;
    let seed=7;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const nets=["GND","VCC","N1","N2","N3","N4"],L=["Top","Inner 1","Inner 2","Bottom"];
    for(let k=0;k<300;k++)d.items.push({id:id(),kind:"part",def:"std-r",x:5+rnd()*90,y:5+rnd()*70,angle:0,ref:"R"+k,pinNets:{"1":nets[k%6],"2":nets[(k+3)%6]}});
    for(let k=0;k<400;k++)d.items.push(makeVia(5+rnd()*90,5+rnd()*70,nets[k%6]));
    for(let k=0;k<1200;k++){const x=5+rnd()*85,y=5+rnd()*70;d.items.push(track([[x,y],[x+2,y+2],[x+6,y+2]],nets[k%6],L[k%4]));}
    [["Top","GND",rect(1,1,50,79)],["Top","VCC",rect(50,1,99,40)],["Top","N1",rect(50,40,99,79)],["Inner 1","GND",rect(-1,-1,101,81)],["Inner 2","VCC",rect(1,1,60,79)],
     ["Inner 2","N2",rect(60,1,99,79)],["Bottom","GND",rect(1,1,99,50)],["Bottom","N3",rect(1,50,40,79)],["Bottom","N4",rect(40,50,70,79)],["Bottom","N5",rect(70,50,99,79)]]
      .forEach(([layer,net,o],k)=>d.items.push(PP.make(o,{layer,net,pourIndex:k})));
    PP.apply(d,defs,{});
    const H=editor({name:"Budget",documents:[d]});PP.live.reset();PP.live.setMode("live");PP.live.attach(H);
    const t=H.doc().items.find(i=>i.kind==="track"&&i.layer==="Top"&&i.points[0][0]<45);
    H.edit(()=>{t.points=t.points.map(p=>[p[0]+.7,p[1]+.4]);});
    await settle();
    assert.deepEqual(PP.stale(H.doc(),defs),[]);
    const last=PP.live.last;
    console.log("live repour of "+last.ids.length+" pour(s): main thread "+last.main.toFixed(1)+" ms (longest slice "+last.longest.toFixed(1)+" ms), wall "+last.ms.toFixed(0)+" ms");
    assert.ok(last.ids.length<10,"not every pour was repoured");
    assert.ok(last.longest<60,"no main-thread slice above 60 ms (budget 30 ms; slack for slow CI)");
  }
}

async function speculate() {
  const defs = catalogue, S = PP.speculation, id = itemIds("s");
  function board(){
    const d=A.sheet("pcb","Spec");d.outline=rect(0,0,40,30);
    d.rules=rules;
    for(let k=0;k<30;k++)d.items.push(via(id(),2+(k*7)%36,2+(k*5)%26,["GND","VCC","S"][k%3]));
    d.items.push(PP.make(rect(1,1,20,29),{net:"GND",layer:"Top",pourIndex:0}),PP.make(rect(18,1,39,29),{net:"VCC",layer:"Top",pourIndex:1}),
      PP.make(rect(1,1,39,29),{net:"GND",layer:"Bottom",pourIndex:2}),PP.make(rect(30,20,38,28),{net:"S",layer:"Bottom",pourIndex:3}));
    return d;
  }
  // A journal like the undo store's.
  const log=[];
  PP.reuse.journal({changed(doc,since){const seq=log.length;if(since==null)return {seq,ids:null,items:null};const ids=new Set(),items=new Map();for(let k=since;k<seq;k++)ids.add(log[k].id);for(const i of doc.items)if(ids.has(i.id))items.set(i.id,i);return {seq,ids,items};},outer:()=>0});
  const idle = () => until(() => !S.running, "speculation settles", {poll:1, attempts:3000});
  const full = d => JSON.stringify(PP.repourAll(d,defs,{reuse:false}).regions);
  const stored = d => JSON.stringify((d.pcbDrawing?.pours||[]).filter(r=>r.polygon!=null));

  const d=board(),project={format:"atrium",name:"P",library:[],documents:[d]},H=editor(project);
  PP.live.reset();PP.reuse.clear();S.reset();
  PP.live.setMode("manual");
  PP.live.attach(H);
  H.edit(()=>PP.apply(d,defs,{}));
  // An edit leaves pours stale; the Polygon Pours submenu opens: the stale pours are solved ahead.
  const v=d.items.find(i=>i.kind==="via"&&i.x<15);
  H.edit(()=>{v.x+=.7;log.push(v);});
  const before=stored(d),rev=H.revision();
  S.intent("submenu",true);await idle();
  let s=S.stats;
  assert.equal(s.started,1,"started: "+JSON.stringify(s));assert.equal(s.completed,1);assert.ok(s.poursSolved>=1,"solved ahead: "+JSON.stringify(s));
  assert.equal(stored(d),before,"speculation does not touch the document");assert.equal(H.revision(),rev,"no edit, no undo step");
  // Repour All uses it: copper equals a full repour, nothing solved again.
  const solvedBefore=PP.reuse.stats.solved;
  PP.repour(d,defs,{project},fn=>H.edit(fn),m=>H.infos.push(m));
  for(let k=0;k<200&&H.infos.at(-1)!=="Polygon pours repoured";k++)await wait(2);
  assert.equal(stored(d),full(d),"Repour All after speculation equals a full repour");
  assert.equal(PP.reuse.stats.solved,solvedBefore,"Repour All solved nothing again: "+JSON.stringify(PP.reuse.stats));
  s=S.stats;assert.equal(s.used,s.poursSolved,"every speculative pour used: "+JSON.stringify(s));assert.equal(s.wasted,0);

  // An edit after speculation, near a pour: that pour's speculative copper is wasted, the others used.
  const w=d.items.find(i=>i.kind==="via"&&i.x>25);
  H.edit(()=>{w.y+=.6;log.push(w);});
  S.intent("palette",true);await idle();
  const solvedSpec=S.stats.poursSolved;
  const w2=d.items.find(i=>i.kind==="via"&&i.x>25&&i!==w)||w;
  H.edit(()=>{w2.x+=1.1;log.push(w2);});
  PP.repour(d,defs,{project},fn=>H.edit(fn),m=>H.infos.push(m));
  for(let k=0;k<400&&PP.state(d,defs)==="stale";k++)await wait(2);
  assert.equal(stored(d),full(d),"Repour All after a later edit equals a full repour");
  s=S.stats;assert.ok(s.poursSolved>solvedSpec-1&&s.used+s.wasted+s.pending>=s.poursSolved-0,"accounting: "+JSON.stringify(s));

  // An edit stops a run.
  H.edit(()=>{v.x-=.7;log.push(v);});
  S.intent("chord-tg",true);
  H.edit(()=>{v.y+=.2;log.push(v);});
  await idle();
  assert.ok(S.stats.stopped>=1,"an edit stops speculation: "+JSON.stringify(S.stats));

  // Weak intents wait SPEC_DWELL and are cancelled by an edit.
  const started=S.stats.started;
  S.intent("menu",false);H.edit(()=>{v.y-=.2;log.push(v);});await wait(400);
  assert.equal(S.stats.started,started,"a weak intent cancelled by an edit never starts");

  // Efficiency pauses speculation even when a saved preference opts in.
  globalThis.AtriumPower={efficient:()=>true};
  const sp=S.stats.skippedPower;S.intent("submenu",true);await idle();
  assert.equal(S.stats.started,started,"no speculation in Efficiency mode");assert.equal(S.stats.skippedPower,sp+1);
  S.setMode("always");S.intent("submenu",true);await idle();
  assert.equal(S.stats.started,started,"Efficiency still pauses opted-in speculation");
  S.setMode("off");S.intent("submenu",true);await idle();assert.equal(S.stats.started,started,"off");
  S.setMode(null);delete globalThis.AtriumPower;
  // Live mode: the live repour does this work already.
  PP.live.setMode("live");const st=S.stats.started;S.intent("submenu",true);await idle();assert.equal(S.stats.started,st,"not in live mode");
  console.log("repour-speculate: "+JSON.stringify(S.stats));
}

async function fadeHold() {
  // Animation frames run only when the test says so.
  let frames=[];
  const flush=()=>{const f=frames;frames=[];for(const cb of f)cb(performance.now());};
  const patched=doc=>PP.displayPours(doc).some(r=>r.patch);
  const patchRegion=()=>PP.tiles.patches.values().next().value?.region;
  const settleFrames = async () => { await settle(flush); flush(); };
  // An in-flight verification can publish the fresh retained result without a second worker reply.
  const arrival = before => until(() => patchRegion() && patchRegion() !== before, "a fresh tile patch was prepared", {poll:1, attempts:400});

  const fades=[];
  globalThis.AtriumMotion={level:()=>"full",animate(o){fades.push(o);return {cancel(){}};}};
  globalThis.AtriumCanvasFast={lastBoardMs:()=>20};
  globalThis.requestAnimationFrame=f=>{frames.push(f);return frames.length;};
  const {H} = await tileEditor("hold", itemIds("h"), {settleTiles: settleFrames});
  const v=H.doc().items.find(i=>i.kind==="via"&&i.net==="SIG");

  // 1. A slow board: the new patch is held for the frame already asked for, then shown; no fade.
  let last=patchRegion();H.edit(()=>{v.x+=.7;});await arrival(last);
  assert.ok(PP.tiles.patches.size>=1,"a patch arrived");
  assert.equal(patched(H.doc()),false,"held: the next frame draws the stored copper alone");
  const r0=H.redraws;flush();
  assert.equal(patched(H.doc()),true,"shown from the frame after");
  assert.ok(H.redraws>r0,"the release asks for a frame");
  assert.equal(fades.length,0,"no cross-fade on a slow board");

  // 2. Another edit while that patch is on screen: the new patch shows at once.
  last=patchRegion();H.edit(()=>{v.y+=.4;});await arrival(last);
  assert.equal(patched(H.doc()),true,"earlier patches stay on screen");
  // Once the exact copper is stored, patches still kept show that copper: the next edit holds again.
  await settleFrames();assert.equal(PP.tiles.patches.size,0,"the exact commit drops the patches");

  // 3. No animation frames (a hidden page): the patch shows after 150 ms anyway.
  last=patchRegion();H.edit(()=>{v.x-=.5;});await arrival(last);
  assert.equal(patched(H.doc()),false,"held");
  // (Unless the exact commit lands first and drops the patch.)
  const t0=performance.now();for(let k=0;k<400&&!patched(H.doc())&&PP.tiles.patches.size;k++)await wait(2);
  assert.ok(patched(H.doc())||!PP.tiles.patches.size,"released without frames");
  assert.ok(performance.now()-t0<600,"within about 150 ms");
  await settleFrames();

  // 4. A fast board fades as before (motion.js).
  globalThis.AtriumCanvasFast={lastBoardMs:()=>2};
  last=patchRegion();H.edit(()=>{v.x+=.3;});await arrival(last);
  assert.equal(fades.length,1,"a fast board cross-fades");
  assert.equal(patched(H.doc()),true,"the fading patch is drawn");
  await settleFrames();
  console.log("pour-fade-hold: slow boards hold new patches one frame, earlier patches stay, fast boards fade");
}

async function exactTiles() {
  const {check} = require("../formats/gerber-check.cjs"), F = AtriumFabOutputs;
  function arcsOf(regs){const out=[];for(const r of regs)if(r.arcs)for(let k=0;k<r.arcs.length;k+=5)out.push({region:r,ring:r.arcs[k],i0:r.arcs[k+1],i1:r.arcs[k+2],c:[r.arcs[k+3],r.arcs[k+4]]});return out;}
  const radius=a=>{const ring=PP.rings(a.region)[a.ring],w=a.i0%(ring.length>>1);return Math.hypot(ring[2*w]-a.c[0],ring[2*w+1]-a.c[1]);};
  const strip=rs=>JSON.stringify(rs.map(r=>({layer:r.layer,net:r.net,polygon:r.polygon,count:r.count,data:r.data,arcs:r.arcs||null,links:r.links})));
  function fresh(doc,defs){const copy=JSON.parse(JSON.stringify(doc));return PP.repourAll(copy,defs,{}).regions;}
  function gerberArcs(project,pcb){
    const out=F.build(project,pcb,{date:new Date(2026,10,18)}),top=out.files.find(f=>f.kind==="gerber"&&/Copper,L1,Top/.test(f.content));
    for(const f of out.files.filter(f=>f.kind==="gerber"))assert.deepEqual(check(f.content,{x2:true}).issues,[],f.name);
    return (top.content.slice(top.content.indexOf("G36*")).match(/G0[23]X-?\d+Y-?\d+I-?\d+J-?\d+D01\*/g)||[]).length;
  }

  const id = itemIds("a");
  const makeVia = (x,y,net,diameter) => via(id(),x,y,net,diameter);
  const {H, defs} = await tileEditor("exact", id, {addItems(items) {
    items.push({id:id(),kind:"track",layer:"Top",net:"SIG",width:.25,points:[[2,14],[38,14]]},
      {id:id(),kind:"part",def:"std-r",x:20,y:19,angle:0,ref:"R1",pinNets:{"1":"GND","2":"SIG"}});
  }});
  assert.equal(PP.tiles.state.specs.length,3);
  const arcs0=arcsOf(H.doc().pcbDrawing.pours).length;assert.ok(arcs0>10,"true arcs before ("+arcs0+")");

  // 1. An edit: a tile patch at once (the exact repour waits for it), then the exact commit.
  const v=H.doc().items.find(i=>i.kind==="via"&&i.net==="SIG");
  const before=strip(H.doc().pcbDrawing.pours);
  H.edit(()=>{v.x+=.7;v.y+=.3;});
  await until(() => PP.tiles.patches.size, "the edited tiles receive a patch", {poll:1, attempts:200});
  assert.ok(PP.tiles.patches.size>=1,"a patch shows the changed tiles");
  assert.equal(strip(H.doc().pcbDrawing.pours),before,"the patch is display only: stored copper unchanged until the exact repour");
  const shown=PP.displayPours(H.doc());assert.ok(shown.length>H.doc().pcbDrawing.pours.length&&shown.some(r=>r.patch),"display pours carry the patch region");
  assert.ok(PP.tiles.last.tiles>0&&PP.tiles.last.tiles<40,"only the affected tiles re-solved ("+PP.tiles.last.tiles+")");
  await settle();
  assert.equal(PP.tiles.patches.size,0,"the patch is dropped once the exact copper lands");
  assert.equal(PP.stale(H.doc(),defs).length,0);
  const got=H.doc().pcbDrawing.pours,want=fresh(H.doc(),defs);
  assert.equal(strip(got),strip(want),"committed copper is byte-identical to a full repour (data, links and true arcs)");
  const arcs1=arcsOf(got);assert.ok(arcs1.length>10,"true arcs survive ("+arcs1.length+")");
  const wantArcs=arcsOf(want);assert.equal(arcs1.length,wantArcs.length);
  arcs1.forEach((a,k)=>{assert.ok(Math.abs(radius(a)-radius(wantArcs[k]))<1e-9,"radius "+k);assert.deepEqual(a.c,wantArcs[k].c);});
  assert.ok(gerberArcs(H.project(),H.doc())>10,"Gerber plots the pour arcs as G02/G03");

  // 1b. Imported fill (regions tagged source:"altium") is never patched: it stays until the exact
  //     repour of the first edit that touches the pour replaces it.
  {
    for(const r of H.doc().pcbDrawing.pours)if(r.polygon===H.doc().items.find(i=>i.kind==="polygon").id)r.source="altium";
    const pid=H.doc().items.find(i=>i.kind==="polygon").id;
    H.edit(()=>{v.x-=.2;});
    await until(() => PP.tiles.patches.size, "the edited tiles receive a patch", {poll:1, attempts:200});
    assert.ok(!PP.displayPours(H.doc()).some(r=>r.patch&&r.polygon===pid),"no patch over another tool's fill");
    await settle();
    assert.ok(!H.doc().pcbDrawing.pours.some(r=>r.source),"the exact repour replaced the imported fill");
    assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)));
  }
  // 1c. An in-place change (a point of a track edited inside its array, as some tools do): the quick
  //     pass misses it, the full pass in idle time finds it, and the copper is exact in the end.
  {
    const t=H.doc().items.find(i=>i.kind==="track"),c0=PP.tiles.corrections;
    H.edit(()=>{t.points[0][1]+=.6;});
    await settle();
    assert.ok(PP.tiles.corrections>c0,"the full pass corrected the tiles");
    assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)));
  }
  // 2. Undo and redo: each lands on the full repour of its board.
  H.undo();await settle();assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)),"undo");
  H.redo();await settle();assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)),"redo");

  // 3. A drag: items move in place each frame without an edit; the tiles follow (patches), the drop
  //    commits and repours exactly.
  {
    const part=H.doc().items.find(i=>i.kind==="part"),x0=part.x;
    H.setDrag({kind:"move",before:"snapshot"},[part.id]);
    globalThis.requestAnimationFrame=f=>setTimeout(()=>f(performance.now()),4);
    PP.tiles.schedule([part.id]);
    for(let k=1;k<=5;k++){part.x=x0+k*.4;PP.tiles.schedule([part.id]);await wait(10);}
    for(let k=0;k<200&&PP.tiles.busy;k++)await wait(2);
    assert.ok(PP.tiles.patches.size>=1,"the tiles follow the dragged part");
    assert.ok(PP.tiles.history.some(h=>h.drag),"drag frames diff only the moved items");
    assert.ok(PP.tiles.dragVisible(H.doc()),"pours stay visible while dragging");
    H.setDrag(null,[]);
    H.edit(()=>{part.x=x0+2;});await settle();
    assert.equal(PP.tiles.patches.size,0);
    assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)),"drop repours exactly");
    delete globalThis.requestAnimationFrame;
  }
  // 4. Repour on drop (preference): no drag patches, the pours hide while dragging as before.
  PP.tiles.setPref("drop");assert.equal(PP.tiles.dragVisible(H.doc()),false);PP.tiles.setPref("live");
  // 5. Manual mode: no tiles, no repour.
  PP.live.setMode("manual");const m0=strip(H.doc().pcbDrawing.pours);
  H.edit(()=>{v.x-=.5;});await settle();assert.equal(strip(H.doc().pcbDrawing.pours),m0,"manual mode leaves the copper");
  assert.equal(PP.tiles.patches.size,0);
  PP.live.setMode("live");H.edit(()=>{v.y+=.1;});await settle();
  assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)),"live again");

  // A recorded in-place edit goes straight to the affected tiles and needs no correction scan.
  {
    const track=H.doc().items.find(i=>i.kind==="track");
    let seq=1;
    const changes=(_doc,from)=>({seq,ids:from==null?null:from===seq?new Set():new Set([track.id]),items:new Map([[track.id,track]])});
    PP.reuse.journal({changed:changes,recordedChanges:changes,outer:()=>0});
    await PP.tiles.rebuild();
    const corrections=PP.tiles.corrections;
    const jobs=new Map(),frames=[];
    H.stageEdit=(_phase,key,fn)=>{
      const job={current:()=>jobs.get(key)===job,cancel:()=>{if(job.current())jobs.delete(key);}};
      job.run=()=>fn(job.current);
      jobs.set(key,job);
      return job;
    };
    const raf=globalThis.requestAnimationFrame,motion=globalThis.AtriumMotion;
    globalThis.requestAnimationFrame=fn=>frames.push(fn);
    globalThis.AtriumMotion={level:()=>"reduced",animate(){}};
    H.edit(()=>{track.points[0][1]+=.25;seq++;});
    assert.ok(!PP.displayPours(H.doc()).some(r=>r.patch),"the first edit frame retains the previous fill");
    jobs.get("live-pour-tiles").run();
    await until(() => PP.tiles.patches.size, "the edited tiles receive a patch", {poll:1, attempts:200});
    assert.ok(PP.displayPours(H.doc()).some(r=>r.patch),"post-paint tile output appears in the next available draw");
    assert.equal(frames.length,0,"the patch does not reserve an extra frame");
    globalThis.requestAnimationFrame=raf;
    globalThis.AtriumMotion=motion;
    jobs.get("exact-pour").run();
    delete H.stageEdit;
    await settle();
    assert.equal(PP.tiles.corrections,corrections,"known journal geometry skips the fallback scan");
    assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)),"targeted journal repour equals full copper");
    PP.reuse.journal(null);
  }
  {
    const turns=[];
    const pipeline=AtriumEditPipeline.create({afterFrame:fn=>turns.push(fn)},()=>true,fn=>turns.push(fn));
    H.stageEdit=pipeline.stage;
    const settleSave=pipeline.holdFrom("pours");
    const previous=strip(H.doc().pcbDrawing.pours),track=H.doc().items.find(i=>i.kind==="track");
    H.edit(()=>{track.points[0][1]+=.2;});
    assert.equal(turns.length,0,"a pending save does not schedule the queued pour");
    assert.equal(strip(H.doc().pcbDrawing.pours),previous,"the previously computed copper is retained");
    settleSave();
    for(let k=0;k<4000&&(turns.length||PP.live.busy||PP.tiles.busy);k++){
      turns.shift()?.();
      await wait(1);
    }
    assert.ok(!turns.length&&!PP.live.busy&&!PP.tiles.busy);
    assert.equal(strip(H.doc().pcbDrawing.pours),strip(fresh(H.doc(),defs)),"the queued exact copper matches a full repour after save");
    delete H.stageEdit;
  }
  console.log("pour-tiles-live: patch then exact commit, "+arcs1.length+" true arcs kept, Gerber G02/G03, undo/redo/drag/manual");
}

async function pooled() {
  require("./dense-board.js");
  let seed = 7, gate = null;
  const pool = {size: 4, available: true, jobs: 0, active: 0, peak: 0, run(task) {
    this.jobs++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    return new Promise((ok, no) => {
      const go = () => setTimeout(() => { try { ok(PP._internal.core.solve(task)); } catch (e) { no(e); } finally { this.active--; } }, (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 4);
      if (gate) gate.then(go); else go();
    });
  }, stats: () => ({workerMs: 0})};
  globalThis.AtriumWorkerPool = {get: () => pool, find: () => pool};

  function board() {
    const {d, defs} = makeAtriumBenchmarkBoard(36), p = A.project("Pooled"); p.documents = [d]; p.library = [...defs.values()];
    let k = 0;
    for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 16), "2": "N" + ((k + 1) % 16)}; else if (i.kind !== "track") i.net = "N" + (k % 16); k++; }
    const b = A.bounds(d.outline), w = b[2] - b[0], h = b[3] - b[1];
    const rect = (x0, y0, x1, y1) => [[b[0] + x0 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y1 * h], [b[0] + x0 * w, b[1] + y1 * h]];
    [["Top", "GND", [0, 0, .5, 1]], ["Top", "VCC", [.5, 0, 1, 1]], ["Bottom", "GND", [0, 0, 1, .5]], ["Bottom", "VCC", [0, .5, 1, 1]],
      ...[0, 1, 2, 3].map(j => [j % 2 ? "Top" : "Bottom", "N" + j, [.05 + j * .2, .05, .2 + j * .2, .2]])]
      .forEach(([layer, net, o], j) => d.items.push(PP.make(rect(...o), {layer, net, pourIndex: j, removeDeadCopper: j % 3 === 0})));
    return {p, d, defs};
  }
  const json = d => JSON.stringify(d.pcbDrawing);
  function expected(p) { const q = JSON.parse(JSON.stringify(p)), d = q.documents[0]; PP.apply(d, new Map(q.library.map(x => [x.id, x])), {project: q, reuse: false}); return json(d); }

  // Packed worker inputs must produce the same copper before and after refinement.
  const packedFixture = board(), core = PP._internal.core;
  for (const poly of PP.polygons(packedFixture.d)) {
    const {task, final} = PP._internal.prepare(packedFixture.d, packedFixture.defs, poly, {project:packedFixture.p});
    if (!task) continue;
    for (const input of [task, {...task,...final}]) {
      assert.deepEqual(core.solve(core.pack(input).task).islands,core.solve(input).islands,"packing preserves " + poly.net);
    }
  }
  const {p, defs} = board(), H = editor(p, defs, {emitChanges:false});
  PP.live.reset(); PP.live.setMode("manual"); PP.speculation?.setMode?.("off"); PP.live.attach(H);
  let said = [];
  const repour = () => PP.repour(H.doc(), H.defs(), {project: H.project()}, fn => H.edit(fn), m => said.push(m));
  const vias = () => H.doc().items.filter(i => i.kind === "via");

  const fixtures = [
    {name:"cold Repour All"},
    {name:"current copper",fresh:true},
    {name:"small edit",edit:() => { vias()[3].x += .05; }},
    {name:"large edit",edit:() => { for (const via of vias()) via.x += .01; }}
  ];
  for (const {name, fresh, edit} of fixtures) {
    if (edit) H.edit(edit);
    const jobs = pool.jobs;
    said = [];
    await repour();
    assert.ok(said.includes(fresh ? "Polygon pours are up to date" : "Polygon pours repoured"), said.join("; "));
    assert.equal(json(H.doc()), expected(p), name);
    assert.equal(pool.jobs === jobs, !!fresh, name + ": worker use");
  }

  // Superseding a held solve cancels its own job and does not launch the prepared tail.
  {
    const b = board(), control = {};
    let sent = 0, cancelled = 0;
    const held = {size:1, run() {
      sent++;
      let reject;
      const promise = new Promise((_resolve, no) => { reject = no; });
      return Object.assign(promise, {cancel() { cancelled++; reject(Error("cancelled")); }});
    }};
    const pending = PP.repourParallel(b.d, b.defs, {project:b.p, control}, held);
    await until(() => sent, "a held job reached the pool", {poll:1, attempts:200});
    assert.equal(sent, 1);
    control.stopped = true; control.cancel();
    assert.equal(await pending, null);
    assert.equal(cancelled, 1);
    assert.equal(sent, 1, "cancel never posts the tail of the old pour queue");
  }

  // An edit while the solves are held: the run starts again on the new board.
  PP.reuse?.clear?.();
  let open; gate = new Promise(r => { open = r; });
  H.edit(() => { vias()[5].y += .05; });
  const run = repour();
  await until(() => pool.active, "an old solve is in flight before the next edit");
  H.edit(() => { vias()[9].x -= .05; });
  open(); gate = null;
  await run;
  assert.equal(json(H.doc()), expected(p), "an edit during the run");
  assert.ok(PP.reuse.last.restarts >= 1, "the run restarted: " + JSON.stringify(PP.reuse.last));

  // Live pours on the same pool (repourParallel with only the stale pours): the commit is apply()'s.
  PP.tiles?.enable?.(false); PP.live.setMode("live");
  const jobs0 = pool.jobs;
  for (const [what, fn] of [["a via moved", () => { vias()[7].x += .05; }], ["every via moved", () => { for (const v of vias()) v.y += .01; }]]) {
    H.edit(fn); PP.live.schedule();
    await until(() => !PP.live.busy && !PP.stale(H.doc(),H.defs(),{project:p}).length, "pooled live copper is current");
    assert.equal(json(H.doc()), expected(p), "live pours: " + what);
    assert.ok(PP.live.last?.slices?.some(x => x[0] === "pool"), "live pours ran on the pool: " + JSON.stringify(PP.live.last));
  }
  assert.ok(pool.jobs > jobs0, "solves on the pool");
  let visible = false, changePower;
  globalThis.AtriumPower = {visible: () => visible, efficient: () => true, onChange(fn) { changePower=fn; return () => {}; }};
  PP.live.attach(H);
  const hiddenJobs = pool.jobs;
  H.edit(() => { for (const v of vias()) v.y += .01; });
  PP.live.schedule();
  await wait(10);
  assert.equal(pool.jobs, hiddenJobs, "hidden-window live edits wait");
  pool.peak=0;
  visible=true; changePower({visible,efficient:true});
  await until(() => !PP.live.busy && !PP.stale(H.doc(),H.defs(),{project:p}).length, "pooled live copper is current");
  assert.equal(json(H.doc()), expected(p), "resuming from hidden preserves exact copper");
  assert.equal(pool.peak, 1, "Efficiency admits one live solve at a time");
  console.log("ok - live pours on the pool scheduler store apply()'s pcbDrawing");
  console.log("ok - an edit during the run restarts it; same pcbDrawing");
}

async function idleSolve() {
  const {core:CORE, MAIN} = PP._internal;
  const wasm = !!globalThis.AtriumEngine?.available && engineMode !== "js";
  function board() {
    const d = {kind: "pcb", name: "B", id: "b1", items: [], outline: rect(0, 0, 60, 40), rules};
    for (let k = 0; k < 40; k++) d.items.push(via("v" + k, 3 + (k % 10) * 5.5, 4 + Math.floor(k / 10) * 9, k % 3 ? "GND" : "SIG"));
    d.items.push(PP.make(rect(1, 1, 59, 39), {id: "pgnd", net: "GND", layer: "Top", name: "GND", pourIndex: 0}));
    d.items.push(PP.make(rect(1, 1, 59, 39), {id: "psig", net: "SIG", layer: "Bottom", name: "SIG", pourIndex: 1}));
    return d;
  }
  const defs = new Map();
  const copperOf = (d, id) => JSON.stringify(regionsOf(d, id).map(r => r.data));
  const clean = r => JSON.stringify(r.islands.map(i => [Array.from(i.ring), Array.from(i.tags), Array.from(i.links), i.holes.map(h => [Array.from(h.ring), Array.from(h.tags)])]));
  const taskOf = d => PP._internal.prepare(d, defs, d.items.find(i => i.id === "pgnd"), {}).task;

  // ---- 1. idle callbacks (no scheduler attached): waits for the end of a drag, same answer
  {
    const t = taskOf(board()), want = clean(CORE.solve(t));
    let busy = true, checks = 0;
    const p = PP.mainSolve(t, {interacting: () => { checks++; return busy; }});
    let done = false; p.then(() => { done = true; });
    await until(() => checks > 1, "idle solve checks again during a drag");
    assert.equal(done, false, "no step runs while the user drags");
    busy = false;
    const r = await p;
    assert.equal(clean(r), want, "the same islands as a direct solve");
    console.log("ok - no worker, idle callbacks: waits for the drag to end, then solves (" + (wasm ? "WebAssembly, one step" : "JS core in phases") + ")");
  }
  // ---- 2. the cooperative scheduler (checks.js): an edit's re-plan neither drops nor restarts it
  {
    const S = AtriumChecks.scheduler, handlers = {};
    S.reset();
    S.attach({on: (ev, f) => { (handlers[ev] ||= []).push(f); }, project: () => null});
    globalThis.AtriumNavHost = {drag: () => dragging ? {kind: "move"} : null};
    let dragging = true;
    const t = taskOf(board()), want = clean(CORE.solve(t));
    const p = PP.mainSolve(t);
    let done = false; p.then(() => { done = true; });
    await wait(120);
    assert.equal(done, false, "the editor's drag holds the solve");
    for (const f of handlers.change || []) f();  // an edit: every live check is re-planned
    assert.ok(S.running("pour-solve"), "the edit did not drop the solve");
    dragging = false;
    assert.equal(clean(await p), want);
    assert.ok(S.stats().last["pour-solve"], "it ran as a scheduler client");
    S.reset(); delete globalThis.AtriumNavHost;
    console.log("ok - no worker, check scheduler: held during the drag, kept across an edit, same answer");
  }
  // ---- 3. cancel
  {
    const p = PP.mainSolve(taskOf(board()), {interacting: () => true});
    p.cancel();
    await assert.rejects(p, e => e.cancelled === true);
  }
  // ---- 4. the budget: predicted past it (never started), and (JS core) a phase past it
  {
    const d = board(), rate = MAIN.rate;
    PP.apply(d, defs, {});
    const before = copperOf(d, "pgnd");
    for (const v of d.items) if (v.kind === "via") v.x += .05;
    MAIN.rate = 1e6; // as if the last main-thread solves were slow
    let result;
    try { result = await PP.repourParallel(d, defs, {reuse: false}, null); } finally { MAIN.rate = rate; }
    assert.equal(result.failed.length, 2, JSON.stringify(result.failed));
    assert.match(result.failed[0].reason, /no background worker is available and its solve would take about/);
    PP.apply(d, defs, {result});
    assert.equal(copperOf(d, "pgnd"), before, "the failed pour keeps its copper");
    assert.deepEqual(PP.stale(d, defs, {}).sort(), ["pgnd", "psig"], "and stays stale");
    assert.ok(PP.failures(d).pgnd, "failures() names it (Design Insights pourFailed)");
    const ok = await PP.repourParallel(d, defs, {reuse: false}, null);
    assert.equal(ok.failed.length, 0, "within the budget it pours");
    if (!wasm) {
      const t = taskOf(d);
      await assert.rejects(PP.mainSolve(t, {budgetMs: 1e-6, interacting: () => false}), e => e.budget && e.main && !e.predicted, "a phase past the budget stops the solve");
    }
    console.log("ok - no worker, budget: a predicted overrun fails the pour at once" + (wasm ? "" : ", a JS phase past it stops the solve") + "; old copper kept");
  }

  // ---- 5. real worker crashes (Node: Web Workers on worker_threads)
  let WT = null;
  try { WT = typeof process === "object" && process.versions?.node ? require("node:worker_threads") : null; } catch { WT = null; }
  const {resolveObjectURL} = WT ? require("node:buffer") : {};
  if (!WT || !resolveObjectURL || typeof Blob !== "function" || typeof URL.createObjectURL !== "function") { console.log("skip - real worker crashes need Node worker threads"); return; }
  // A job for the SIG pour makes its worker allocate past the worker's heap limit (a real crash:
  // ERR_WORKER_OUT_OF_MEMORY) while `crashes` > 0; every other job solves normally.
  let crashes = 0, started = 0;
  const sigShapes = new Set();
  const isSig = m => { const t = m && m.task; if (!t) return false; const n = t.packed ? t.nShapes : t.shapes.length; return sigShapes.has(n) && !(t.packed ? t.nAnchors : t.anchors.length); };
  const PRELUDE = 'const {parentPort} = require("node:worker_threads");\n' +
    'globalThis.postMessage = d => parentPort.postMessage(d);\n' +
    'parentPort.on("message", d => { if (d && d.oom) { const hog = []; for (;;) hog.push(new Array(1e6).fill(hog.length)); } globalThis.onmessage && globalThis.onmessage({data: d}); });\n';
  class NodeWebWorker {
    constructor(url) {
      this.onmessage = this.onerror = this.onmessageerror = null; this.queue = []; this.dead = false; started++;
      resolveObjectURL(url).text().then(src => {
        if (this.dead) return;
        this.w = new WT.Worker(PRELUDE + src, {eval: true, resourceLimits: {maxOldGenerationSizeMb: 48}});
        this.w.on("message", data => this.onmessage?.({data}));
        this.w.on("error", e => { if (!this.dead) { this.dead = true; this.onerror?.({message: String(e && e.message || e), preventDefault() {}}); } });
        for (const m of this.queue) this.send(m);
        this.queue = null;
      });
    }
    send(m) { if (crashes > 0 && isSig(m)) { crashes--; this.w.postMessage({oom: true}); } else this.w.postMessage(m); }
    postMessage(m) { if (this.queue) this.queue.push(m); else this.send(m); }
    terminate() { this.dead = true; this.w?.terminate(); }
  }
  globalThis.Worker = NodeWebWorker;
  try {
    const pool = PP._internal.pool();
    const d = board(), ref = board(), sig = () => d.items.find(i => i.id === "psig");
    const target = () => { sigShapes.clear(); sigShapes.add(PP._internal.prepare(d, defs, sig(), {}).task.shapes.length); };
    PP.apply(ref, defs, {reuse: false});
    let r = await PP.repourParallel(d, defs, {reuse: false});
    assert.equal(r.failed.length, 0);
    PP.apply(d, defs, {result: r});
    assert.equal(copperOf(d, "psig"), copperOf(ref, "psig"), "pooled equals serial");
    // One crash, then a fresh worker: the pour is poured, nothing ran on this thread.
    const move = x => { for (const v of x.items) if (v.kind === "via") v.y += .05; };
    move(d); move(ref); PP.apply(ref, defs, {reuse: false}); target();
    crashes = 1;
    r = await PP.repourParallel(d, defs, {reuse: false});
    assert.equal(crashes, 0, "the worker crashed");
    assert.equal(r.failed.length, 0, "a single crash is retried in a fresh worker: " + JSON.stringify(r.failed));
    assert.equal(pool.stats().local, 0, "never solved on this thread");
    PP.apply(d, defs, {result: r});
    assert.equal(copperOf(d, "psig"), copperOf(ref, "psig"));
    assert.equal(copperOf(d, "pgnd"), copperOf(ref, "pgnd"));
    // Two crashes: that pour fails (old copper kept), the other pours; never on this thread.
    const before = copperOf(d, "psig");
    move(d); move(ref); PP.apply(ref, defs, {reuse: false}); target();
    crashes = 2;
    r = await PP.repourParallel(d, defs, {reuse: false});
    assert.equal(crashes, 0, "both workers crashed");
    assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
    assert.equal(r.failed[0].id, "psig");
    assert.match(r.failed[0].reason, /worker crashed/);
    assert.equal(pool.stats().local, 0, "a crashed solve never runs on this thread");
    PP.apply(d, defs, {result: r});
    assert.equal(copperOf(d, "psig"), before, "previous copper kept");
    assert.equal(copperOf(d, "pgnd"), copperOf(ref, "pgnd"), "the other pour is exact");
    assert.ok(PP.failures(d).psig, "pourFailed names it");
    assert.ok(pool.available, "the pool still runs other solves");
    console.log("ok - real worker crashes (out of memory): retried once in a fresh worker; a second crash fails that pour only; never on this thread");
  } finally { delete globalThis.Worker; PP._internal.pool()?.close?.(); }
}

const engineMode = globalThis.ATRIUM_ENGINE ?? globalThis.process?.env?.ATRIUM_ENGINE;
const tileModules = ["zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "rules", "viastack"];
const CASES = {
  incremental: {run: incremental},
  "repour-speculate": {run: speculate, modules:["rules"]},
  "pour-fade-hold": {run: fadeHold, modules:tileModules, engine:true},
  "pour-tiles-live": {run: exactTiles, modules:[...tileModules, "bom", "fab-outputs", "edit-pipeline"], engine:true},
  "repour-pooled": {run: pooled, modules:tileModules, engine:true},
  "pour-idle-solve": {run: idleSolve, modules:[...tileModules, "worker-pool", "checks"], engine:true}
};

async function run(cases = Object.keys(CASES)) {
  const mocked = ["AtriumCanvasFast", "AtriumMotion", "AtriumNavHost", "AtriumPower", "AtriumWorkerPool", "requestAnimationFrame"];
  for (const name of cases) {
    assert.ok(Object.hasOwn(CASES, name), "Unknown live pour case: " + name);
    const {run, modules = [], engine} = CASES[name];
    load(modules);
    if (engine && engineMode !== "js") {
      try { require("../../app/engine-core.js"); } catch { /* Optional WebAssembly engine. */ }
    }
    const original = mocked.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    try {
      await run();
      console.log("live-pours: " + name + " passed");
    } finally {
      PP.live.reset();
      PP.tiles.enable(true);
      PP.tiles.setPref("live");
      PP.speculation.reset();
      PP.speculation.setMode(null);
      PP.reuse.journal(null);
      PP.reuse.clear();
      mocked.forEach((key, i) => {
        if (original[i]) Object.defineProperty(globalThis, key, original[i]);
        else delete globalThis[key];
      });
    }
  }
}

module.exports = run;
if (require.main === module) {
  const selected = process.argv.slice(2);
  globalThis.__testDone = run(selected.length ? selected : undefined);
  if (process.versions?.node) globalThis.__testDone.catch(error => { console.error(error); process.exitCode = 1; });
}
