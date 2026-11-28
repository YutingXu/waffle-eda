"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {F2,F4} = require("../support/a1-geometry.cjs");
require("../../app/core/model.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/pcb/resolved-geometry-curves.js");


const board = {id: "board", kind: "pcb"};
const other = {id: "other", kind: "pcb"};
const canvas = {isConnected: true, parentNode: {}};
const jobs = new Map(), saving = new Set(), paneListeners = new Map();
let next = 0, pendingWrites = 0, contexts = 0, paints = 0, powerChanged, visible = true;
const view = {canvas, cache: {doc: board}, repaint() { paints++; }};
const folder = {
  get pendingWrites() { return pendingWrites; },
  on(listener) { saving.add(listener); return () => saving.delete(listener); },
};
const world = {
  Atrium, AtriumGeometryCurves, AtriumPCBAppearance,
  AtriumCanvasGPUPref: {decision: () => ({use: true})},
  AtriumPower: {visible: () => visible, onChange(run) { powerChanged = run; }},
  AtriumIdle: {
    idle(run) { jobs.set(++next, run); return next; },
    cancel(id) { jobs.delete(id); },
  },
  AtriumNavHost: {
    folderProject: () => folder,
    panes: () => [{canvas, docId: view.cache.doc.id}],
    on(event, listener) { paneListeners.set(event, listener); return () => paneListeners.delete(event); },
  },
  WebGL2RenderingContext() {},
  document: {createElement() {
    return {style: {}, setAttribute() {}, getContext() { contexts++; return null; }};
  }},
};
const file = process.argv[2] || path.join(__dirname, "../../app/canvas/canvas-gpu.js");
const sandbox = vm.createContext(world);
// Expose the production scene updater inside this Node VM only. The idle
// cases still use render(), including its normal GPU preparation path.
const gpuCode = fs.readFileSync(file, "utf8"), sceneExport = "{render, damage, stats,";
assert.ok(gpuCode.includes(sceneExport));
vm.runInContext(gpuCode.replace(sceneExport, "{render, damage, stats, views, update, states, buffer, push, upload, padDetails, coveredPadDetails, paintPadDetails, bandRectangle,"), sandbox);
const gpu = sandbox.AtriumCanvasGPU;
{
  const allocations = [], patches = [];
  const gl = {
    createBuffer:()=>({}), createVertexArray:()=>({}), bindVertexArray(){}, bindBuffer(){},
    enableVertexAttribArray(){}, vertexAttribPointer(){}, vertexAttribDivisor(){},
    bufferData(target, data){ allocations.push(data.length); },
    bufferSubData(target, offset, data, first, count){ patches.push([offset, first, count]); }
  };
  const st = {gl}, b = gpu.buffer("seg"), stroke = [0,0,1,0,.2,1,1,0];
  const append = () => gpu.push(b, stroke, board, 0);
  for (let i = 0; i < 1025; i++) append();
  const coldBytes = gpu.upload(st, b), initial = b.glCap;
  assert.ok(initial > b.n && initial <= b.n + 64, "a new mesh uploads live slots plus bounded edit room");
  assert.deepEqual(allocations, [initial * 8, initial * 2]);
  assert.equal(coldBytes, initial * 40);
  assert.equal(gpu.upload(st, b), 0, "a second draw reuses the same geometry and state buffers");
  append();
  assert.equal(gpu.upload(st, b), 40);
  assert.deepEqual(patches, [[1025*32, 1025*8, 8], [1025*8, 1025*2, 2]]);
  while (b.n <= initial) append();
  const grownBytes = gpu.upload(st, b);
  assert.equal(b.glCap, b.cap, "continued insertion gets the usual geometric growth");
  assert.equal(grownBytes, b.glCap * 40);
  assert.deepEqual(allocations.slice(2), [b.glCap * 8, b.glCap * 2]);
}
{
  const width = 100, height = 80;
  const context = (a=1,b=0,c=0,d=1,e=0,f=0) => ({getTransform:() => ({a,b,c,d,e,f})});
  const band = gpu.bandRectangle(width,height);
  // The first and last glyphs fall on opposite sides of the backing. Their union crosses the screen.
  band.include(context(),-20,2,-3,10);
  band.include(context(0,1,-1,0,114,63),0,0,7,10);
  assert.equal(band.rect(),null,"disjoint offscreen ink leaves a fresh texture empty");
  band.include(context(-1,0,0,1,53,27),3,0,8,9);
  assert.deepEqual(Array.from(band.rect()),[43,25,52,38],"only the visible transformed ink needs upload");
  band.include(context(),-6,50,-1.2,54);
  assert.deepEqual(Array.from(band.rect()),[0,25,52,56],"a subpixel edge inside the antialiasing fringe stays visible");
  band.include(context(),Infinity,50,Infinity,54);
  assert.equal(band.rect(),undefined,"unknown ink still requests the full band");
}
{
  let copiedPixels = 0, outlines = 0, partBoxes = 0;
  const local = vm.createContext({Atrium, AtriumPCBAppearance, copyCanvas(c) {
    copiedPixels += c.width*c.height;
    return {width:c.width,height:c.height};
  }});
  vm.runInContext(gpuCode.replace("  return Object.freeze(" + sceneExport,
    "  copyCanvas = globalThis.copyCanvas;\n  return Object.freeze({render, damage, stats, overlayWorld,"), local);
  const items = [{id:"track",kind:"track",layer:"Top"}, {id:"via",kind:"via",layer:"Multi",x:2,y:1,diameter:.8,drill:.4},
    {id:"part",kind:"part"}];
  const canvas = {width:842,height:717}, ctx = {canvas, setTransform() {}, clearRect() {}, beginPath() {},
    rect() {}, save() {}, restore() {}, stroke() {outlines++;}};
  const I = {canvas,ctx,boardTransform() {},drawBoard(g,parts,doc,defs,scale,opts) {
    assert.ok(opts.partBoxesOnly); partBoxes += parts.length;
  }};
  const st = {scene:{cache:{all:items}}}, area = canvas.width*canvas.height;
  function select(id, selectedIds) {
    local.AtriumCanvasGPU.overlayWorld(I,st,board,new Map(),{layer:"Top",selected:id,selectedIds},
      [0,0,1],{active:"Top",viewport:[0,0,4,4]});
  }
  select("track");
  assert.equal(copiedPixels,0,"a selected track already drawn with copper needs no extra canvas");
  select("via");
  assert.deepEqual([copiedPixels,outlines], [area,1], "a via keeps its selection outline");
  const previous = st.overlayWorld;
  select("track",new Set(["track","missing"]));
  assert.deepEqual([copiedPixels,st.overlayWorld,previous.width,previous.height], [area,null,1,1],
    "returning to a track releases the prior outline without copying transparent pixels");
  select("part");
  assert.deepEqual([copiedPixels,partBoxes], [2*area,1], "a component keeps its selection box");
}
function draw(queued = 1) {
  assert.equal(gpu.render(view, view.cache.doc, new Map(), {reuseBase: true}), false);
  assert.equal(jobs.size, queued);
}
function runIdle(didTimeout) {
  assert.equal(jobs.size, 1);
  const [id, run] = jobs.entries().next().value;
  jobs.delete(id);
  run({didTimeout});
}
function changeWriters(count) {
  pendingWrites = count;
  for (const listener of saving) listener("saving");
}
// Drive each stage from a real render, idle callback, or host signal.
const preparation = [
  ["An overdue idle callback yields to input", () => { draw(); draw(); runIdle(true); }, {contexts:0}],
  ["Save parks preparation instead of requeueing", () => { pendingWrites=2; runIdle(false); }, {jobs:0,saves:1}],
  ["Repeated draws and partial writes stay parked", () => {
    for (let i=0; i<100; i++) draw(0);
    changeWriters(1);
  }, {jobs:0,saves:1,contexts:0}],
  ["The last write queues preparation once", () => changeWriters(0), {jobs:1,saves:0}],
  ["Replacing a pane drops its old Save listener", () => {
    changeWriters(1); runIdle(false);
    assert.equal(saving.size,1);
    view.cache.doc=other; paneListeners.get("document")();
  }, {jobs:0,saves:0,panes:0}],
  ["Hiding the pane cancels the wait", () => {
    draw(); runIdle(false);
    assert.equal(saving.size,1);
    visible=false; powerChanged({visible});
  }, {saves:0,panes:0}],
  ["The final write does not wake the hidden pane", () => changeWriters(0), {jobs:0}],
  ["Detaching a view cancels preparation", () => {
    visible=true; powerChanged({visible}); draw(); canvas.isConnected=false; runIdle(false);
  }, {jobs:0,contexts:0}],
  ["The connected pane prepares once", () => {
    canvas.isConnected=true; draw(); runIdle(false);
  }, {jobs:0,contexts:1,paints:1}]
];
for (const [description, step, expected] of preparation) {
  step();
  const actual = {jobs:jobs.size,saves:saving.size,panes:paneListeners.size,contexts,paints};
  for (const [key, count] of Object.entries(expected)) assert.equal(actual[key],count,description + ": " + key);
}
console.log("GPU preparation yields to input and waits once for the final folder Save");

{
  // This is an editor's committed geometry read. Deliberately give its ink a
  // different width and endpoint from the authored renderer input.
  const track = {id: "t", kind: "track", layer: "Top", width: .9, points: [[0,0],[1,0]]};
  const owner = {kind: "item", id: track.id, documentId: board.id, instancePath: []};
  const state = {stats: {}, parked: new Map(), gl: {}};
  const cache = {doc: board, rev: 1, all: [track], byId: new Map([[track.id,track]]), boxes: new Map([[track, [0,0,1,0]]])};
  let reads = 0, details = 0, diffs = 0, nextView;
  world.AtriumResolvedGeometry = {};
  world.AtriumNavHost.boardGeometry = doc => { assert.equal(doc,board); reads++; return nextView; };
  const content = (layer, x, width) => ({layer,x,width, bounds:[x-.25,-.25,x+2.25,.25]});
  const before = content("Top",0,.4), after = content("Bottom",5,.6);
  function publish(ink, prior) {
    const old = nextView?.revision, revision = Object.freeze({});
    nextView = {revision, changes(since) {
      assert.equal(since,old); diffs++;
      return {kind:"incremental",owners:[owner],layers:[prior.layer,ink.layer],bounds:[prior.bounds,ink.bounds]};
    }, owner(key) {
      assert.equal(JSON.stringify(key),JSON.stringify({documentId:board.id,instancePath:[],kind:"item",id:track.id}));
      details++;
      return {features:[{key:{layer:ink.layer,role:"track"},ink:{kind:"stroke",width:ink.width,
        centerline:[{kind:"line",a:[ink.x,0],b:[ink.x+2,0]}]}}]};
    }};
    if (prior) {
      const from = cache.rev++;
      cache.delta = {from,to:cache.rev,changed:[],removed:[],appendOnly:true,known:true,box:null};
    }
  }
  function drawTrack(ink) {
    const scene = gpu.update(state,cache,"Top");
    const [[buffer,slot,count]] = scene.recs.get(track.id);
    assert.equal(count,1);
    assert.ok(scene.layers.has(ink.layer),"the physical delta updates the committed layer");
    assert.equal(scene.layers.get(ink.layer).seg,buffer);
    const at = slot * buffer.stride;
    assert.deepEqual(Array.from(buffer.f.subarray(at,at+4)),[ink.x,0,ink.x+2,0]);
    assert.ok(Math.abs(buffer.f[at+4]-ink.width)<1e-6,"GPU paints the committed stroke width");
    return scene;
  }
  publish(before);
  const retained = drawTrack(before);
  for(let frame=0;frame<10;frame++)assert.equal(drawTrack(before),retained);
  assert.deepEqual([reads,details,diffs],[1,1,0],"camera frames never request geometry or update the scene");
  for(const [prior,ink] of [[before,after],[after,before],[before,after]]) {
    publish(ink,prior);
    const scene=drawTrack(ink);
    assert.equal(scene,retained);
    assert.deepEqual(Array.from(scene.damage.layers),[prior.layer,ink.layer]);
    assert.deepEqual(Array.from(scene.damage.box),[-.25,-.25,7.25,.25],"dirty extents include old and new ink");
    assert.equal(scene.layers.get(prior.layer).seg.dead,1,"removing or undoing the layer move clears the old slot");
  }
  assert.deepEqual([reads,details,diffs],[4,4,3]);
}
console.log("GPU scene consumes committed strokes and uses directional geometry deltas without work on camera frames");

{
  const track = {...F2.track,id:"curved",layer:"Top"};
  const curves = world.AtriumGeometryCurves, clock = Object.freeze({});
  const layer = "Top mask", width = 1.2;
  function capture(item, film = layer) {
    const c = {doc:board,rev:1,all:[item],byId:new Map([[item.id,item]])};
    const scene = gpu.update({stats:{},parked:new Map(),gl:{}},c,"Top");
    const {f,stride,n,arcCount} = scene.layers.get(film).seg;
    return {arcCount:arcCount || 0, slots:Array.from({length:n},(_,i)=>Array.from(f.subarray(i*stride,(i+1)*stride)))};
  }
  delete world.AtriumNavHost.boardGeometry;
  const cold = capture(track);
  assert.equal(cold.arcCount,1,"a supported circular film is one analytic GPU instance");
  assert.equal(cold.slots.length,1);
  const centerline = curves.pathEdges(track);
  world.AtriumNavHost.boardGeometry = () => ({revision:clock,owner:() =>
    ({features:[{key:{role:"mask",layer},ink:{kind:"stroke",centerline,width}}]})});
  assert.deepEqual(cold,capture(track),"cold and committed GPU strokes have identical arc geometry");
  delete world.AtriumNavHost.boardGeometry;

  // Independent projection in board coordinates. The proxy's position is its
  // radial midpoint, while the nearest endpoints own the two round caps.
  const [x,y,angle,half,r,w,kind,marker] = cold.slots[0];
  const cx=x-r*Math.cos(angle),cy=y-r*Math.sin(angle);
  const near=(p,q,epsilon=1e-5)=>p.every((v,i)=>Math.abs(v-q[i])<epsilon);
  assert.ok(near([cx,cy,r,w,kind,marker],[0,0,6,width,0,-1]));
  assert.ok(near([x,y,half],[0,-6,Math.PI/2]));
  function onFilm([px,py]) {
    const theta=Math.atan2(py-cy,px-cx)-angle;
    const delta=Math.atan2(Math.sin(theta),Math.cos(theta));
    const closest=angle+Math.max(-half,Math.min(half,delta));
    return Math.hypot(px-cx-r*Math.cos(closest),py-cy-r*Math.sin(closest)) < w/2;
  }
  assert.equal(onFilm(F2.inside),true,"the mask occupies the true arc");
  assert.equal(onFilm(F2.outside),false,"the old sampled chord remains empty");
  for(const side of [-1,1]){
    assert.ok(onFilm([side*6,.45]),"both end caps round past their tangent seam");
    assert.ok(!onFilm([side*6,.8]),"the cap does not bridge farther than its radius");
  }
  const reversed={...track,points:track.points.slice().reverse(),arc:{...track.arc,start:180,end:0,ccw:false}};
  assert.deepEqual(capture(reversed),cold,"reversing the source sweep preserves the same GPU coverage");
  const stale={...track,arc:{...track.arc,end:90}};
  const staleRender=capture(stale);
  assert.equal(staleRender.arcCount,0,"old authored points take precedence over stale circular metadata");
  assert.deepEqual(staleRender.slots.map(slot=>slot.slice(0,4)),[[6,0,0,-6],[0,-6,-6,0]]);
  const paste=capture(track,"Top paste");
  assert.equal(paste.arcCount,0,"a thin semicircle retains subdivision to bound shaded area");
  assert.ok(paste.slots.length>1);
  for (const [start,end,radius,w,analytic] of [[350,20,.7,.2,1],[0,270,1,.6,0],[0,360,1,.8,0],[0,50,50,.1,0]]) {
    const arc={kind:"arc",c:[2,5],r:radius,start,end,ccw:true};
    const t={kind:"track",id:"case",layer:"Top",width:w,arc,points:Atrium.arcProjection(arc)};
    const sample=capture(t,"Top");
    assert.equal(sample.arcCount,analytic,"safe curvature uses the sector, other strokes retain chords");
    if(analytic) assert.equal(sample.slots[0][6],1,"copper tracks preserve track opacity and tint kind");
    else assert.ok(sample.slots.length>1);
  }
  const narrowCases=[
    {r:500,start:91,end:93,c:[5000,5000]},
    {r:1e-7,start:0,end:150,c:[0,0]},
    {r:700,start:0,end:1e-7,c:[0,0]}
  ];
  for(const source of narrowCases){
    const arc={...source,kind:"arc",ccw:true};
    const item={kind:"track",id:"bounded-fallback",layer:"Top",width:.17,arc,points:Atrium.arcProjection(arc)};
    assert.ok(Atrium.pathArc(item),"the source really owns a circle");
    const result=capture(item,"Top");
    assert.equal(result.arcCount,0,"unsafe far-origin and visually co-located endpoints use stock subdivision");
    assert.ok(result.slots.length>=1,"the fallback keeps the authored stroke");
  }
}
// The HTML renderers use the same authored arc for all three film widths.
{
  const {appFile}=require("../support/app-source-paths.cjs");
  for(const name of ["spatial","path-record","canvas","canvas-board-batches","pdf","print"])require(appFile(name+".js"));
  const board=Atrium.sheet("pcb","F2"), track={...F2.track,id:"trace",layer:"Top"};
  board.items=[track];
  function paint(batch){
    const rec=AtriumPDF.recorder(460,360), view=AtriumCanvas.create(rec.canvas);
    view.restoreCamera({cx:3.5,cy:-3.5,scale:60,referenceScale:60});
    view.internals().lodForce=batch;
    view.render(board,new Map(),{grid:false,origin:false,noReuse:true,recordLayer:name=>rec.setLayer(name?{id:name,name}:null)});
    if(batch)assert.ok(view.internals().cache.lod.info.has(track),"F2 must use the real batched path");
    return rec.list.filter(op=>op.k==="p" && !op.fill && op.layer?.name?.startsWith("Top")).map(op=>[op.layer.name,op.w,op.d]);
  }
  const exact=paint(false);
  assert.equal(exact.length,3);
  assert.deepEqual(paint(true),exact);
}
console.log("F2 ordinary and batched Canvas and cold and committed GPU keep the analytic arc");

// The GPU fill of an exact region leaves its cutouts open, as the 2D even-odd fill does,
// for a board graphic and for a footprint shape.
{
  require(require("../support/app-source-paths.cjs").appFile("board-shape-core.js"));
  const S = AtriumBoardShape;
  sandbox.AtriumBoardShape = S;
  const disk = {version:1, contour:[S.arc([0,0],5,0,180,true), S.line([-5,0],[5,0])], cutouts:[[S.arc([0,-2],.8,0,0,true)]]};
  const points = S.flattenContour(disk.contour), regionShape = {...disk, sig:S.signature(points)};
  const region = {id:"disk", kind:"graphic", layer:"Top", fill:true, closed:true, width:0, points, regionShape};
  const def = {id:"logo", footprint:{pads:[], shapes:[{kind:"path", layer:"Top", fill:true, closed:true, width:0, points, regionShape}]}};
  const part = {id:"u", kind:"part", def:def.id, ref:"U1", x:20, y:0, layer:"Top"};
  const covered = (tri, p) => {
    for (let s = 0; s + 2 < tri.n; s += 3) {
      const [a, b, c] = [0, 1, 2].map(k => [tri.f[(s + k) * tri.stride], tri.f[(s + k) * tri.stride + 1]]);
      const d = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
      const x = d(a, b, p), y = d(b, c, p), z = d(c, a, p);
      if ((x >= 0 && y >= 0 && z >= 0) || (x <= 0 && y <= 0 && z <= 0)) return true;
    }
    return false;
  };
  const doc = Atrium.sheet("pcb", "Region hole");
  doc.items = [region, part];
  const c = {doc, rev:1, all:doc.items, byId:new Map(doc.items.map(i => [i.id, i])), defs:new Map([[def.id, def]])};
  const scene = gpu.update({stats:{}, parked:new Map(), gl:{}}, c, "Top"), {tri, ptri} = scene.layers.get("Top");
  assert.ok(covered(tri, [0,-4]) && covered(tri, [3,-1]), "copper in the semicircle");
  assert.equal(covered(tri, [0,-2]), false, "the GPU leaves the region cutout open");
  assert.ok(covered(ptri, [20,-4]), "footprint copper in the semicircle");
  assert.equal(covered(ptri, [20,-2]), false, "the GPU leaves the footprint region cutout open");
}
console.log("GPU region fills keep their cutouts open");

{
  require("../../app/history/undo-store.js");
  const U=AtriumUndoStore, project=Atrium.project("Mutable analytic tracks");
  const doc=project.documents.find(d=>d.kind==="pcb");
  const straight=(id,x)=>({id,kind:"track",layer:"Top",net:"guard",width:.8,points:[[x,-5],[x,5]]});
  const arc={...F2.track,id:"arc",layer:"Top",net:"signal",points:F2.track.points.map(p=>p.slice())};
  doc.items=[straight("before",-7),arc,straight("after",7)];
  const view=AtriumCanvas.create({getContext:()=>({})}), I=view.internals(), defs=new Map();
  const st={stats:{},parked:new Map(),gl:{}}, history=[], future=[];
  function render(transient) {
    const cache=I.sync(doc,defs), scene=gpu.update(st,cache,"Top",transient);
    const b=scene.layers.get("Top").seg;
    const active=b.own.filter(Boolean).map(i=>i.id);
    return {scene,b,active};
  }
  U.reset(project);
  try {
    U.record(project);
    const first=render(false);
    assert.equal(first.b.arcCount,1);
    assert.deepEqual(Array.from(first.active),["before","arc","after"],"analytic and plain tracks keep authored slot order");
    gpu.states(first.scene,{selected:arc.id},{key:"tints",byNet:new Map([["signal",2]])});
    assert.deepEqual(Array.from(first.b.st.subarray(2,4)),[1,2],"analytic slot shares selected state and net tint");
    gpu.states(first.scene,{routePreview:{hidden:[arc.id]}},{key:"tints",byNet:null});
    assert.equal(first.b.st[2],-1,"the routing preview hides the ordinary physical owner");
    U.checkpoint(history,future,U.mark(project),"Use one authored chord");
    arc.points=[[6,0],[-5,0]];
    U.record(project,{doc,items:[arc]});AtriumCanvas.edited(false);
    const single=render(true);
    assert.equal(single.b,first.b,"the in-place chord keeps the same allocated lane");
    assert.equal(single.b.arcCount,0,"retiring the last arc switches back to the straight shader without compaction");
    U.jump(history,future,U.mark(project),-1);AtriumCanvas.edited(false);render(false);
    const mark=U.mark(project);
    U.checkpoint(history,future,mark,"Change a projected vertex");
    arc.points[1]=[0,-5];
    U.record(project,{doc,items:[arc]});AtriumCanvas.edited(false);
    const edit=render(true);
    assert.equal(edit.scene,first.scene,"the live edit retains the same scene");
    assert.equal(edit.b.arcCount,0,"stale circular metadata falls back and releases mixed shader admission");
    assert.deepEqual(Array.from(edit.active),["before","arc","arc","after"],
      "growing a chord run inserts it at the original physical layer position");
    U.jump(history,future,U.mark(project),-1);AtriumCanvas.edited(false);
    const undo=render(false);
    assert.equal(undo.b.arcCount,1,"Undo restores the analytic instance");
    assert.deepEqual(Array.from(undo.active),["before","arc","after"]);
    assert.ok(undo.b.own.includes(arc),"the retained analytic stroke still names the authored object");
    U.jump(history,future,U.mark(project),1);AtriumCanvas.edited(false);
    const redo=render(false);
    assert.equal(redo.b.arcCount,0,"Redo returns to the stale-metadata path");
    assert.deepEqual(Array.from(redo.active),["before","arc","arc","after"]);
  } finally { U.reset(); }
}

{
  const {appFile} = require("../support/app-source-paths.cjs");
  for (const name of ["pcb-text","stackup","viastack","board-shape","pcb-pours","panel","undo-store"]) require(appFile(name+".js"));
  for (const name of ["mask-openings","geometry-material","resolved-geometry"]) require("../../app/pcb/"+name+".js");
  const U = AtriumUndoStore, R = AtriumResolvedGeometry;
  const project = Atrium.project("Repeated panel sources",[]), source = project.documents.find(d=>d.kind==="pcb");
  source.outline = [[0,0],[24,0],[24,16],[0,16]];
  const component = {id:"q4", kind:"part", def:"package", ref:"Q4", x:4, y:2, sourceRecord:"components6/data#0"};
  const annotation = {field:"ref", at:[-1,2], angle:45, upright:true, size:1.1, width:.11, layer:"Silk"};
  source.pcbDrawing = {annotations:{[component.sourceRecord]:[annotation]}};
  const trace = {id:"trace",kind:"track",layer:"Top",width:.5,points:[[8,9],[14,9]]};
  source.items = [component,trace];
  const third = Atrium.sheet("pcb","Other panel source");
  third.outline = structuredClone(source.outline);
  third.items = [{...trace,points:[[3,3],[5,3]]}];
  project.documents.push(third);
  const def = {id:"package",footprint:{pads:[{number:"1",x:1,y:1,w:1,h:1,shape:"rect",layer:"Top"},
    {number:"1",x:2,y:1,w:1,h:1,shape:"rect",layer:"Top"}],shapes:[]}};
  project.library.push(def);
  const panel = AtriumPanel.create(project,{board:source.id,rows:1,cols:3,spacing:2,
    cells:{"0,1":{rotation:180,mirror:true},"0,2":{board:third.id}},
    rails:{top:false,bottom:false,left:false,right:false},text:{enabled:false},tooling:{enabled:false},fiducials:{enabled:false}});
  project.documents.push(panel);
  U.record(project);
  const defs = () => new Map(project.library.map(d=>[d.id,d]));
  let revision = 1, reads = 0, definitions = defs(), prepared = false;
  const paneCanvas = {isConnected:true,parentNode:{}};
  const host = {project:()=>project,revision:()=>revision,boardGeometry(doc) {
    assert.equal(doc,panel,"only the actual document root may be resolved");
    reads++;
    return prepared ? R.readEditor(project,doc) : null;
  }, panes:()=>[{canvas:paneCanvas,docId:panel.id}]};
  globalThis.AtriumNavHost = host;
  const panelGlobals={AtriumPanel,AtriumResolvedGeometry:R,AtriumNavHost:host};
  Object.assign(sandbox,panelGlobals);
  const rec = AtriumPDF.recorder(600,220), view = AtriumCanvas.create(rec.canvas);
  const opts = {layerMode:"all",grid:false,origin:false,noReuse:true,recordLayer:name=>rec.setLayer(name?{id:name,name}:null)};
  const state = {stats:{},parked:new Map(),gl:{}};
  const owner = (doc,id,cell) => ({kind:"item",documentId:doc.id,id,instancePath:[cell]});
  function fitForPaint() {
    view.restoreCamera({cx:36,cy:8,scale:7,referenceScale:7});
    const start=rec.list.length;
    view.render(panel,definitions,opts);
    return rec.list.slice(start).filter(op=>op.k==="p").map(op=>[op.layer?.name,op.d,op.fill]);
  }
  require("../../app/checks/diagnostics.js");
  rec.canvas.isConnected = true; opts.editorPane = true;
  const recording = AtriumDiagnostics.startPerformance();
  const initialInk = fitForPaint(), flat = view.internals().cache.doc, projection = AtriumPanel.projectionOf(flat);
  const measured = AtriumDiagnostics.performanceSnapshot().rows;
  recording.stop();
  assert.deepEqual(measured.map(({component,operation,counts}) => [component,operation,counts.visible]), [["panel","draw",1]],
    "a projected panel is reported by its source view, not as a PCB");
  assert.equal(projection.geometry,null,"the first editable frame can precede the shared receipt");
  const pane = {canvas:paneCanvas,cache:view.internals().cache,repaint(){}};
  const coldWorld=vm.createContext({...world,...panelGlobals});
  vm.runInContext(gpuCode,coldWorld);
  assert.equal(coldWorld.AtriumCanvasGPU.render(pane,flat,definitions,{reuseBase:true}),false);
  const contextCount=contexts;
  runIdle(false);
  assert.equal(contexts,contextCount+1,"GPU activation matches the root id in the pane registry");
  prepared=true;
  AtriumPanel.bindGeometry(panel,R.readEditor(project,panel));
  assert.deepEqual(fitForPaint(),initialInk,"receiving the committed view leaves the first frame unchanged");
  const cache = view.internals().cache;
  assert.equal(cache.doc,flat,"publishing a warm provider's receipt reuses the first projection");
  assert.equal(reads,1);
  const initialScene = gpu.update(state,cache,"Top"), initialToken = projection.revision;
  const retained = projection.geometry.owner(owner(third,"trace","0,2"));
  const thirdItem = cache.byId.get("P3:trace");
  const mirrored = projection.geometry.owner(owner(source,component.id,"0,1"));
  assert.equal(mirrored.nominalLands.length,2);
  assert.equal(new Set(mirrored.nominalLands.map(p=>JSON.stringify(p.member))).size,2);
  for (const [index,layer,mirror] of [[1,"Silk",false],[2,"Bottom silk",true]]) {
    const item = cache.byId.get("P"+index+":q4");
    const row = [...AtriumPCBAppearance.partText(cache.doc,item,cache.defs.get(item.def))][0];
    const physical = projection.geometry.owner(owner(source,component.id,"0,"+(index-1))).features.find(f=>f.text);
    assert.equal(row.kind,"annotation");
    assert.deepEqual([row.text.layer,row.text.mirrored,row.text.x,row.text.y],[layer,mirror,...physical.text.origin]);
    assert.equal(((row.text.angle+180)%360+360)%360-180,physical.text.clockwiseDegrees);
    assert.equal(row.text.justify,physical.text.justification);
  }
  function hitProbe(wider) {
    view.restoreCamera({cx:18,cy:8,scale:100,referenceScale:100});
    for (const [x,y,id] of [[4.36,3,"P1:q4"],[30.36,13,"P2:q4"]])
      assert.equal(view.hit(panel,definitions,[x,y],{kinds:["part"]})?.id,wider?id:undefined);
  }
  hitProbe(false);
  const history=[], future=[], prior=U.mark(project,{current:panel.id});
  def.footprint.pads[0].w=1.4;
  trace.points=[[8,11],[14,11]];
  trace.layer="Bottom";
  U.checkpoint(history,future,prior,"Change a shared land and move the trace");
  U.record(project,[{doc:source,items:[trace]},{library:true}]);
  let token = initialToken;
  function checkFrame(wider) {
    revision++;
    definitions=defs();
    const ink = fitForPaint();
    assert.equal(JSON.stringify(ink)===JSON.stringify(initialInk),!wider,"undo restores normal canvas ink");
    assert.equal(view.internals().cache,cache,"source edits retain the projected Canvas cache");
    assert.equal(projection.geometry.owner(owner(third,"trace","0,2")),retained);
    assert.equal(cache.byId.get(thirdItem.id),thirdItem);
    const delta = AtriumPanel.projectedChanges(projection,token);
    assert.deepEqual(delta.owners.map(o=>AtriumPanel.projectedItem(projection,o)).sort(),["P1:q4","P1:trace","P2:q4","P2:trace"]);
    token=projection.revision;
    hitProbe(wider);
    const scene = gpu.update(state,cache,"Top");
    assert.equal(scene,initialScene,"source edits retain GPU buffers");
    const [[thirdBuffer,thirdSlot]] = scene.recs.get(thirdItem.id);
    assert.equal(thirdBuffer.own[thirdSlot],thirdItem);
    assert.ok(scene.damage.layers.includes("Top") && scene.damage.layers.includes("Bottom"));
    for (const [index,expected] of [[1,wider?11:9],[2,wider?5:7]]) {
      const [[buffer,slot]] = scene.recs.get("P"+index+":trace");
      assert.equal(buffer.f[slot*buffer.stride+1],expected,"track follows the occurrence transform");
      assert.ok(scene.damage.box[0]<5 && scene.damage.box[2]>39,"dirty extents cover both source occurrences");
    }
  }
  checkFrame(true);
  U.jump(history,future,U.mark(project),-1);
  checkFrame(false);
  U.jump(history,future,U.mark(project),1);
  checkFrame(true);
  const readCount=reads, inactive = AtriumCanvas.create(AtriumPDF.recorder(600,220).canvas);
  inactive.render(panel,definitions,{noReuse:true});
  for(let i=0;i<5;i++){
    view.restoreCamera({cx:36+i,cy:8,scale:7,referenceScale:7});
    view.render(panel,definitions,opts);
    assert.equal(gpu.update(state,cache,"Top"),initialScene);
    inactive.restoreCamera({cx:36-i,cy:8,scale:7,referenceScale:7});
    inactive.render(panel,definitions,{noReuse:true});
  }
  assert.equal(reads,readCount,"camera updates in either pane do not resolve geometry or reproject");
}
console.log("Repeated and mirrored panel occurrences update Canvas hits and GPU damage through source edit, Undo and Redo");

// Compare both real caption painters to a glyph placed independently at the authored row centre.
{
  Object.assign(sandbox,{AtriumResolvedLand,AtriumSpatial});
  const scale=40, width=800, height=600, {x,y,angle}=F4.part, a=angle*Math.PI/180;
  const shifted={x:2.5,angle:-30,w:1.1}, normal=F4.pad;
  const cases=[
    {name:"ordinary", local:normal, size:39.6},
    {name:"shifted Top row", row:shifted, local:{...normal,...shifted}, size:25.2},
    {name:"mirrored shifted row", row:shifted, local:{...normal,...shifted}, mirror:true, size:19.8},
    {name:"mirrored shifted row, board flipped", row:shifted, local:{...normal,...shifted}, mirror:true, flipped:true, size:19.8}
  ];
  const glyph=rec=>rec.list.find(op=>op.k==="t"&&op.u==="1")?.m;
  const rounded=matrix=>matrix?.map(n=>Math.round(n*1e6)||0);
  for(const {name,row,local,mirror=false,flipped=false,size} of cases){
    const layer=mirror?"Bottom":"Top", board=Atrium.sheet("pcb","F4 captions");
    const pad={...normal,number:"1",layer:"Multi",...(row?{stackMode:"full",padStack:{[layer]:row}}:{})};
    const part={...F4.part,id:"F4",kind:"part",def:"pad",layer,mirror,showRef:false};
    const defs=new Map([[part.def,{id:part.def,footprint:{pads:[pad],shapes:[]}}]]);
    board.items=[part];
    const exact=AtriumPDF.recorder(width,height), band=AtriumPDF.recorder(width,height), expected=AtriumPDF.recorder(width,height);
    const view=AtriumCanvas.create(exact.canvas), I=view.internals();
    const opts={layer,layerMode:"single",grid:false,origin:false,noReuse:true,netNames:false,flipped,hidden:new Set(["Board"])};
    view.restoreCamera({cx:0,cy:0,scale,referenceScale:scale,flipped});view.render(board,defs,opts);
    const rows=gpu.padDetails(board.items,defs,scale,opts,board), sx=flipped?-scale:scale;
    const u=mirror?-local.x:local.x, v=local.y;
    const cx=x+u*Math.cos(a)-v*Math.sin(a), cy=y+u*Math.sin(a)+v*Math.cos(a);
    let box;
    const covered=gpu.coveredPadDetails({query(doc,library,rect){box=rect;return I.query(doc,library,rect);}},board,defs,rows);
    assert.equal(covered.size,0,name+" exercises the retained GPU caption band");
    band.ctx.setTransform(sx,0,0,scale,width/2,height/2);
    for(const [key,entries] of rows)gpu.paintPadDetails(I,band.ctx,entries,key,scale,opts);
    const ref=expected.ctx;
    ref.font="600 "+size+"px monospace";ref.textAlign="center";ref.textBaseline="alphabetic";
    ref.fillText("1",width/2+sx*cx,height/2+scale*cy+size*.37);
    assert.deepEqual(rounded(glyph(exact)),rounded(glyph(expected)),name+" exact Canvas caption");
    assert.deepEqual(rounded(glyph(band)),rounded(glyph(expected)),name+" retained GPU caption");
    assert.deepEqual(rounded([(box[0]+box[2])/2,(box[1]+box[3])/2]),rounded([cx,cy]),name+" caption occlusion query");
  }
  console.log("F4 ordinary and retained GPU captions use the resolved row, with upright mirrored and flipped controls");
}

// The unfinished pick grid can answer a large batch from one temporary ordered index.
{
  const spatial=AtriumSpatial, defs=new Map();
  let localItems=[];
  const localSpatial={...spatial,create(items,getBox,pitch) {
    localItems.push(items.map(item=>item.id));
    return spatial.create(items,getBox,pitch);
  }};
  const local=vm.createContext({AtriumResolvedLand,AtriumPCBAppearance,AtriumSpatial:localSpatial});
  vm.runInContext(gpuCode.replace(sceneExport,"{render, damage, stats, coveredPadDetails,"),local);
  const {coveredPadDetails}=local.AtriumCanvasGPU;
  const pads=Array.from({length:8},(_,n)=>({id:"pad"+n,kind:"pad",layer:"Top",x:n*4,y:0}));
  const earlier={id:"earlier",kind:"track",layer:"Top"}, cover={id:"outside",kind:"track",layer:"Top"},
    unrelated={id:"unrelated",kind:"track",layer:"Top"};
  const edge=[28.25,-.2,28.4,.2], boxes=new Map([[earlier,edge],[cover,edge],[unrelated,[12,1.3,14,1.8]]]);
  for (const p of pads) boxes.set(p,[p.x-.5,-.5,p.x+.5,.5]);
  const doc={kind:"pcb",items:[earlier,...pads,unrelated,cover]}, cache={doc,boxes,rev:1};
  const viewport=[-2,-2,28.15,2];
  assert.equal(spatial.overlaps(boxes.get(cover),viewport),false,"the viewport misses the later copper");
  assert.equal(spatial.overlaps(boxes.get(cover),boxes.get(pads.at(-1))),true,"the edge caption can still overlap it");
  function check(count,pending=true) {
    cache.preparation=pending?{}:null; localItems=[];
    const queries=[];
    const I={cache,query(_doc,_defs,box) {
      queries.push(box);
      return doc.items.filter(item=>spatial.overlaps(boxes.get(item),box));
    }};
    const groups=new Map([["Top",pads.slice(0,count).map(p=>({p,parent:null,g:{x:p.x,y:p.y,w:1,h:1,angle:0}}))]]);
    return {covered:[...coveredPadDetails(I,doc,defs,groups)],queries,local:localItems};
  }
  const seven=check(7), eight=check(8), ready=check(8,false);
  assert.deepEqual([seven.queries.length,seven.local],[7,[]],"seven queries stay on the ordinary path");
  assert.deepEqual(eight.covered,["Top"],"the later occluder outside the viewport still makes copper ordered");
  assert.equal(eight.queries.length,8);
  assert.deepEqual(Array.from(eight.queries.at(-1)),[-.5,-.5,28.5,.5],"the eighth query covers the caption union");
  assert.deepEqual(eight.local,[["earlier",...pads.map(item=>item.id),"outside"]],"index the authoritative items in document order");
  assert.deepEqual([ready.covered,ready.queries.length,ready.local],[["Top"],8,[]],"the complete grid stays on the normal path");
  boxes.set(cover,[30,3,31,4]); cache.rev++;
  assert.deepEqual(check(8).covered,[],"after the later track moves, the preceding track cannot cover the caption");
  console.log("Pending GPU caption queries preserve document order and outside-viewport occluders");
}

// A ready board grid shares its broad query only across dense placed captions.
{
  const U=AtriumUndoStore, spatial=AtriumSpatial, builds=[], queries=[], admissions=[];
  const pad=(x,n)=>({...F4.pad,x,y:0,w:.5,h:.5,angle:0,drill:0,number:String(n),layer:"Bottom"});
  const part=(id,def,x)=>({...F4.part,kind:"part",id,def,x,y:0,angle:0,mirror:true,layer:"Bottom",showRef:false});
  const host=part("many","many",0), first=part("first","custom",.34), last=part("last","custom",20);
  const remote=part("remote","custom",1600);
  const pkg={id:"many",footprint:{pads:Array.from({length:70},(_,n)=>({...pad((69-n)*.8,n+1),w:n===69?.75:.5})),shapes:[]}};
  const custom={id:"custom",footprint:{pads:[{...pad(0,1),w:.22,h:.22,poly:[[-.11,-.11],[.11,-.11],[0,.11]]}],shapes:[]}};
  const copper={id:"track",kind:"track",layer:"Bottom",width:.05,points:[[0,-.2],[0,.2]]};
  const loose={...pad(-3,1),id:"loose",kind:"pad",layer:"Top",net:"loose",y:10};
  const looseCover={id:"loose-cover",kind:"track",layer:"Top",width:.1,points:[[-3,9.9],[-3,10.1]]};
  const board=Atrium.sheet("pcb","Ready caption grid");
  board.items=[first,host,copper,last,remote,loose,looseCover];
  const project={documents:[board],library:[pkg,custom]}, history=[], future=[];
  const definitions=()=>new Map(project.library.map(def=>[def.id,def]));
  const opts={layer:"Bottom",netNames:true};
  const I=AtriumCanvas.create(AtriumPDF.recorder(800,600).canvas).internals();
  const wrap=ready=>({
    get cache(){return ready?I.cache:null;},
    query(doc,defs,rect,keep){
      queries.push(Array.from(rect));
      const items=I.query(doc,defs,rect,keep);
      if(keep)admissions.push(items.map(item=>item.kind));
      return items;
    }
  });
  const byId=id=>board.items.find(item=>item.id===id);
  const viewport=[-70,-3,.1,3];
  const probe=(name,expected,{sparse=false,spread=false,standalone=false}={})=>{
    const defs=definitions(), parts=[byId("many")];
    if(spread)parts.push(byId("remote"));
    if(standalone)parts.push(byId("loose"));
    I.query(board,defs,viewport);
    assert.ok(I.cache.index && !I.cache.preparation);
    const groups=gpu.padDetails(parts,defs,80,opts,board);
    assert.equal(groups.get("Bottom").length,spread?71:70);
    if(sparse)groups.get("Bottom").length=63;
    const linear=Array.from(gpu.coveredPadDetails(wrap(false),board,defs,groups));
    builds.length=0; queries.length=0; admissions.length=0;
    sandbox.AtriumSpatial={...spatial,create(items,getBox,pitch) {
      if(pitch===4)builds.push(items.map(item=>item.id));
      return spatial.create(items,getBox,pitch);
    }};
    try {
      const indexed=Array.from(gpu.coveredPadDetails(wrap(true),board,defs,groups));
      assert.deepEqual(indexed,linear,name+" preserves the authoritative grid result");
      assert.deepEqual(indexed,expected,name);
      if(sparse || spread) {
        assert.equal(builds.length,0,name+" does not build a second index");
        assert.equal(queries.length,sparse?63:71);
      } else {
        assert.equal(builds.length,1,name+" uses one local index");
        assert.equal(admissions.length,1,name+" filters the broad ordered query before allocating its rows");
        assert.ok(admissions[0].length && admissions[0].every(kind=>kind==="part"));
        assert.ok(builds[0].includes("many") && !builds[0].includes("track"));
        if(standalone)assert.equal(queries.length,65,"a loose pad still uses the authoritative document query");
        else assert.equal(queries.length,64,"dense placed captions share one document query");
      }
    } finally { sandbox.AtriumSpatial=spatial; }
  };

  U.record(project);
  probe("Earlier cross-footprint copper and later nonpart copper do not cover a placed caption",[]);
  probe("Sparse placed captions",[],{sparse:true});
  probe("Spread-out caption union",[],{spread:true});
  probe("Later copper still covers a loose caption",["Top"],{standalone:true});

  const mark=U.mark(project);
  last.x=.34;
  U.checkpoint(history,future,mark,"Move custom copper beside the mirrored package");
  U.record(project,[{doc:board,items:[last]}]);
  I.query(board,definitions(),viewport);
  assert.ok(!spatial.overlaps(I.cache.boxes.get(last),viewport),"custom footprint starts outside the viewport");
  probe("Later custom copper beyond the viewport covers the mirrored edge caption",["Bottom"]);
  assert.deepEqual(builds[0],["first","many","last"],"the scoped part index follows authoritative document order");
  U.jump(history,future,U.mark(project),-1);
  probe("Undo restores the exact earlier-only overlap",[]);
  U.jump(history,future,U.mark(project),1);
  probe("Redo restores the later outside-viewport occluder",["Bottom"]);
  U.reset();
  console.log("Ready placed-caption queries share dense bounds and preserve mirrored order through Undo and Redo");
}

// Large footprint indices must give the same occlusion result in authored order.
{
  const spatial = AtriumSpatial, builds = [];
  const pad = (x, extra = {}) => ({...F4.pad, x, y:0, w:.5, h:.5, drill:0, layer:"Top", ...extra});
  const filler = Array.from({length:65}, (_,n)=>pad(20+n*2));
  const test=(label, prefix, suffix, expected, options={})=>{
    const target=pad(0,options.land), pads=[...prefix,target,...filler,...suffix];
    const component={kind:"part",id:"C1",def:"shared",layer:"Top",x:15,y:12,angle:options.angular?-58:90};
    const other={...component,id:"C2",x:options.coincident?15:400,angle:options.angular?90:-58,mirror:true};
    const definitions=new Map([["shared",{id:"shared",footprint:{pads,shapes:[]}}]]);
    if (options.duplicate) pads.push(target);
    const board=Atrium.sheet("pcb","Large-pad occlusion");
    board.items=[component,other];
    const captions = options.only===1?[component]:options.only===2?[other]:board.items;
    const groups = new Map([["Top",captions.flatMap(parent =>
      Array.from({length:options.few?2:65},()=>({p:target,parent,g:AtriumPCBAppearance.padGeometry(target,"Top","Top")})))]]);
    const I={query(_doc,_defs,box) {
      return board.items.filter(({x,y})=>spatial.overlaps(box,[x-1,y-1,x+1,y+1]));
    }};
    sandbox.AtriumSpatial={overlaps:spatial.overlaps};
    const linear = Array.from(gpu.coveredPadDetails(I,board,definitions,groups));
    builds.length=0;
    sandbox.AtriumSpatial={...spatial,create(rows,getBox,pitch) {
      builds.push(rows.map(getBox));
      return spatial.create(rows,getBox,pitch);
    }};
    try {
      const indexed = Array.from(gpu.coveredPadDetails(I,board,definitions,groups));
      assert.deepEqual(indexed,linear,label+" preserves the linear result");
      assert.deepEqual(indexed,expected,label);
      if (options.few) assert.equal(builds.length,0,"sparse captions do not build a grid for a large footprint");
      else if (!expected.length && !options.only) {
        assert.equal(builds.length,2,"each placement builds one grid");
        assert.notDeepEqual(builds[0][0],builds[1][0],"shared geometry keeps each placement's own world bounds");
      }
    } finally { sandbox.AtriumSpatial=spatial; }
  };
  test("Only the mirrored occurrence has a later sibling overlap",
    [],[pad(.9,{w:.08,h:.08})],["Top"],{land:{w:2,h:.2},angular:true});
  test("Earlier sibling overlap and earlier unbounded stack do not promote",
    [pad(.1),pad(-100,{padStack:{Top:{}}})],[],[]);
  test("Later sibling overlap promotes",[pad(-2)],[pad(.1)],["Top"]);
  test("A later stack conservatively promotes without a geometric hit",[],[pad(500,{padStack:{Top:{}}})],["Top"]);
  test("A later custom pad conservatively promotes without a geometric hit",[],[pad(500,{poly:[[0,0],[1,0],[0,1]]})],["Top"]);
  test("Repeated pad identity retains the first authored occurrence",[],[],["Top"],{duplicate:true});
  test("Mirrored placement sharing its definition does not reuse the first transform",[],[],[]);
  test("A large footprint with few eligible pads stays linear",[],[],[],{few:true});
  test("Coincident earlier placement does not cover the later caption",[],[],[],{coincident:true,only:2});
  test("Coincident later placement covers the earlier caption",[],[],["Top"],{coincident:true,only:1});
  test("A non-finite outline follows the legacy predicate",[],[pad(500,{w:Infinity})],["Top"]);
}
console.log("Large sibling pads preserve earlier/later order, unbounded pads, and distinct mirrored placements");

// A retained pan still collects captions for newly exposed layers. Ordered copper paints its own.
{
  const measured=[], layers=new Set(["Top","Multi"]);
  const appearance={...AtriumPCBAppearance,padGeometry(p,active,layer) {
    measured.push(layer); return AtriumPCBAppearance.padGeometry(p,active,layer);
  }};
  const world=vm.createContext({AtriumCanvas,AtriumPCBAppearance:appearance});
  vm.runInContext(gpuCode.replace(sceneExport,"{scrollText, render, damage, stats,"),world);
  const doc=Atrium.sheet("pcb","Caption layers"), defs=new Map();
  const free={...F4.pad,kind:"pad",layer:"Top",drill:0,net:"TOP"};
  const via={...free,kind:"via",layer:"Multi",drill:.3,net:"VIA"};
  const part={kind:"part",id:"P",def:"footprint",layer:"Top",x:0,y:0};
  defs.set(part.def,{footprint:{shapes:[],pads:[{...F4.pad,number:"1",layer:"Top"},{...F4.pad,number:"2",layer:"Bottom"}]}});
  const rec=AtriumPDF.recorder(24,24), I=AtriumCanvas.create(rec.canvas).internals();
  I.query=()=>[free,via,part];
  const st={gl:{bindTexture(){},texSubImage2D(){}},scene:{cache:{boxes:new Map()}},stats:{acc:{text:0}}};
  let received;
  const P={need:[Infinity],cam:[0,0,80,false,24,24,1],o2:{layer:"Top",netNames:true},exact:layers,padDetails:true,
    paintBand(g,band,items,found,details){received=Array.from(details,([name,rows])=>[name,rows.length]);}};
  const T={w:24,h:24,bands:[{tex:{}}],valid:[0,0],strip:P};
  world.document={createElement:()=>AtriumPDF.recorder(1,1).canvas};
  assert.ok(world.AtriumCanvasGPU.scrollText(I,st,doc,defs,P.o2,T,-1,0));
  assert.deepEqual(measured,["Bottom"],"ordered free, via and footprint lands need no second geometry lookup");
  assert.deepEqual(received,[["Bottom",1]],"the entering footprint pad on the other layer still has its caption");
  layers.clear(); measured.length=0;
  assert.ok(world.AtriumCanvasGPU.scrollText(I,st,doc,defs,P.o2,T,-2,0));
  assert.deepEqual(received,[["Top",2],["Multi",1],["Bottom",1]],"without ordered copper the separate painter receives every caption");
}

// WebGL2 reserves the largest unsigned index for primitive restart. The four
// cover vertices are drawn separately and never enter the index buffer.
{
  const context=vm.createContext({AtriumPCBAppearance});
  vm.runInContext(gpuCode.replace(sceneExport,"{fanOf,render, damage, stats,"),context);
  let vertices, indices;
  const gl={ARRAY_BUFFER:1,ELEMENT_ARRAY_BUFFER:2,UNSIGNED_SHORT:5123,UNSIGNED_INT:5125,
    createVertexArray(){},createBuffer(){},bindVertexArray(){},bindBuffer(){},
    enableVertexAttribArray(){},vertexAttribPointer(){},
    bufferData(target,data){if(target===this.ARRAY_BUFFER) vertices=data; else indices=data;}};
  for(const [count,bytes] of [[6,2],[65535,2],[65536,4],[65537,4]]) {
    const outer=new Float32Array((count-3)*2), hole=[0,0,1,0,0,1];
    const mesh=context.AtriumCanvasGPU.fanOf(gl,[outer,hole]);
    assert.equal(indices.BYTES_PER_ELEMENT,bytes,"choose the index width from the combined rings");
    assert.equal(mesh.indexType,bytes===2?gl.UNSIGNED_SHORT:gl.UNSIGNED_INT);
    assert.deepEqual(Array.from(indices.slice(-3)),[count-3,count-2,count-1],"last ring keeps its distinct indices");
    assert.equal(mesh.count,indices.length);
    assert.equal(mesh.bytes,vertices.byteLength+indices.byteLength);
  }

  // In the invert stencil, paired interior edges disappear. The remaining
  // directed edges must trace each authored ring, including holes and islands.
  function checkBoundary(rings) {
    const mesh=context.AtriumCanvasGPU.fanOf(gl,rings), edges=new Map();
    function edge(a,b,dir) {
      const key=Math.min(a,b)+"/"+Math.max(a,b);
      const count=(edges.get(key)||0)+Math.sign(b-a)*dir;
      if (count) edges.set(key,count); else edges.delete(key);
    }
    for (let i=0;i<mesh.count;i+=3) {
      const [a,b,c]=indices.subarray(i,i+3);
      edge(a,b,1); edge(b,c,1); edge(c,a,1);
    }
    let base=0, triangles=0;
    for (const ring of rings) {
      const n=ring.length/2;
      if (n>=3) for (let i=0;i<n;i++) edge(base+i,base+(i+1)%n,-1);
      triangles+=Math.max(0,n-2); base+=n;
    }
    assert.equal(mesh.count,triangles*3);
    assert.equal(edges.size,0,"triangle boundaries reproduce the authored copper rings");
  }
  const side=Array.from({length:129},(_,i)=>[i,16*Math.sin(i*.33)]);
  const ribbon=[...side,...side.slice().reverse().map(([x,y])=>[x,y+1.5])].flat();
  checkBoundary([ribbon]);
  const area=(a,b,c)=>Math.abs((vertices[2*b]-vertices[2*a])*(vertices[2*c+1]-vertices[2*a+1])
    -(vertices[2*b+1]-vertices[2*a+1])*(vertices[2*c]-vertices[2*a]));
  let submitted=0, firstVertexFan=0;
  for (let k=0;k<indices.length;k+=3) submitted+=area(indices[k],indices[k+1],indices[k+2]);
  for (let i=1;i+1<ribbon.length/2;i++) firstVertexFan+=area(0,i,i+1);
  assert.ok(submitted<firstVertexFan/2,"a winding copper ribbon shades less than half the original triangle area");
  for (const n of [3,31,32,33,64,65,127]) {
    const corners=side.slice(0,n);
    checkBoundary([ribbon,corners.slice().reverse().flat(),corners.flat(),[4,4]]);
  }
  // Non-finite coordinates in the actual float upload retain the old
  // clipping behaviour even when the source number is a finite double.
  for (const bad of [NaN,1e50]) {
    const broken=ribbon.slice(); broken[0]=bad;
    context.AtriumCanvasGPU.fanOf(gl,[broken]);
    assert.ok(!Number.isFinite(vertices[0]));
    for (let i=0;i<indices.length;i+=3) assert.equal(indices[i],0);
  }
}

// Reuse unchanged coverage regions and keep the old snapshot for in-place edits.
{
  const W=47,H=31, reads=[], region={data:"body",count:2,layer:"Top",net:"GND",bounds:[8,9,15,13]};
  const rings=[[8,9,15,9,15,13,8,13],[9,10,9.1,10,9.1,10.1]];
  let inkChecks=0, paints=0, failing=false;
  const context=vm.createContext({
    navigator:{userAgent:"AppleWebKit"},
    AtriumPCBAppearance:{...AtriumPCBAppearance,ink(...args){inkChecks++;return AtriumPCBAppearance.ink(...args);}},
    AtriumPCBPours:{contours:()=>rings}
  });
  vm.runInContext(gpuCode.replace(sceneExport,"{pourCoverage, render, damage, stats,"),context);
  const ctx={setTransform(){},clearRect(){},getImageData(...rect){reads.push(rect);return {};}};
  const canvas={width:W,height:H,getContext:()=>ctx};
  const gl={RGBA:2,createTexture:()=>({}),bindTexture(){},deleteTexture(){},texStorage2D(){},texParameteri(){},pixelStorei(){},texSubImage2D(){}};
  const st={gl,canvas,alphaTextures:false,parked:new Map(),stats:{pourBytes:0,coverageUpload:0}};
  const I={canvas,ctx,worldToScreen:point=>point,boardTransform(){},drawBoard(){paints++;if(failing)throw Error("coverage painter failed");}};
  const list=[region], doc={pcbDrawing:{pours:list}}, defs=new Map(), c={pourSig:[]};
  const opts={layer:"Top"}, view={o2:opts,viewport:[0,0,W,H]};
  const cover=x=>context.AtriumCanvasGPU.pourCoverage(I,st,doc,defs,opts,[x,0,1,false,W,H,1],view,list,null,c).get("Top");
  const prior=cover(0).regions[0];
  assert.equal(cover(1).regions[0],prior,"moving the camera reuses the same geometry record");
  assert.equal(inkChecks,0,"RGBA fallback does not inspect mask colours");
  assert.deepEqual(reads,[[6,7,11,8],[6,7,11,8]],"the two camera keys retain a nonzero cropped readback");
  region.net="CHANGED";c.pourSig=[];
  const edited=cover(1).regions[0];
  assert.notEqual(edited,prior,"an in-place edit produces a new coverage record");
  assert.equal(prior.net,"GND");
  assert.equal(edited.net,"CHANGED");
  assert.equal(edited.bounds,prior.bounds,"a net change does not traverse the contour again");
  assert.equal(paints,3,"an in-place net change still paints the dirty texture");
  region.data="changed contours at the same camera";c.pourSig=[];
  failing=true;
  assert.throws(()=>cover(1),/coverage painter failed/);
  const beforeRetry=paints;
  failing=false;
  cover(1);
  assert.equal(paints,beforeRetry+1,"retry must paint the same camera after the provisional region failed to upload");
}

// Retrying coverage after a failed camera move must remove ink at the old pose.
{
  const W=47,H=31, deleted=new Set(), backing=new Uint8Array(W*H);
  const region={data:"coverage",count:2,layer:"Top",bounds:[8,9,15,13]};
  const rings=[[8,9,15,9,15,13,8,13],[9,10,9.1,10,9.1,10.1]];
  const list=[region], doc={pcbDrawing:{pours:list}}, defs=new Map(), c={pourSig:[]};
  const opts={layer:"Top"}, view={o2:opts,viewport:[0,0,W,H]};
  const context=vm.createContext({navigator:{userAgent:"AppleWebKit"},AtriumPCBAppearance,
    AtriumPCBPours:{contours:()=>rings}});
  vm.runInContext(gpuCode.replace(sceneExport,"{pourCoverage, render, damage, stats,"),context);
  let selectedTexture, shift=0, uploadFails=false, onPaint, paints=0;
  const ctx={setTransform(){},clearRect(x,y,w,h){
    for(let row=y;row<y+h;row++)backing.fill(0,row*W+x,row*W+x+w);
  },getImageData(x,y,w,h){
    const data=new Uint8Array(w*h);
    for(let row=0;row<h;row++)data.set(backing.subarray((row+y)*W+x,(row+y)*W+x+w),row*w);
    return data;
  }};
  const canvas={width:W,height:H,getContext:()=>ctx};
  const gl={RGBA:2,createTexture:()=>({pixels:new Uint8Array(W*H)}),
    bindTexture(target,tex){selectedTexture=tex;},texStorage2D(){},texParameteri(){},pixelStorei(){},
    deleteTexture(tex){deleted.add(tex);},
    texSubImage2D(target,level,x,bottom,w,h,format,type,data){
      const y=H-bottom-h;
      for(let row=0;row<h;row++){
        selectedTexture.pixels.set(data.subarray(row*w,(row+1)*w),(row+y)*W+x);
        if(uploadFails)throw Error("coverage upload failed after a partial write");
      }
    }};
  const st={gl,canvas,alphaTextures:false,parked:new Map(),stats:{pourBytes:0,coverageUpload:0}};
  const I={canvas,ctx,worldToScreen:([x,y])=>[x-shift,y],boardTransform(){},
    drawBoard(){
      paints++;
      for(let y=9;y<13;y++)backing.fill(255,y*W+8-shift,y*W+15-shift);
      onPaint?.();
    }};
  const cover=x=>{
    shift=x;
    return context.AtriumCanvasGPU.pourCoverage(I,st,doc,defs,opts,[x,0,1,false,W,H,1],view,list,null,c).get("Top");
  };
  const expected=x=>{
    const pixels=new Uint8Array(W*H);
    for(let y=9;y<13;y++)pixels.fill(255,y*W+8-x,y*W+15-x);
    return pixels;
  };
  const old=cover(0).tex;
  assert.deepEqual(old.pixels,expected(0));
  uploadFails=true;
  assert.throws(()=>cover(-20),/coverage upload failed/);
  uploadFails=false;
  const moved=cover(-20).tex;
  assert.deepEqual(moved.pixels,expected(-20),"a failed camera move cannot leave old ink outside the new upload");
  assert.ok(deleted.has(old));
  assert.notEqual(moved,old);

  // A reentrant successful paint takes ownership of the same layer before the
  // older paint throws. Its already-valid texture must survive that old catch.
  let successor;
  onPaint=()=>{
    onPaint=null;
    successor=cover(-10);
    throw Error("stale paint lost to a newer successful render");
  };
  assert.throws(()=>cover(-5),/stale paint lost/);
  const winner=successor.tex;
  assert.ok(!deleted.has(winner),"the older failure must not discard a newer successful mask");
  assert.deepEqual(winner.pixels,expected(-10));
  const before=paints;
  assert.equal(cover(-10),successor);
  assert.equal(paints,before,"the successful reentrant coverage remains a cache hit");
}

// Cold text bands visit each part once and preserve the same glyphs and late fallback artwork.
{
  const {appFile}=require("../support/app-source-paths.cjs");
  let definitions=0, layerReads=0, orderedCopper=false;
  const context=vm.createContext({AtriumUUID,AtriumResolvedLand,AtriumPCBText:{draw(g,shape){g.fillText(shape.text);}}});
  vm.runInContext(fs.readFileSync(appFile("model.js"),"utf8"),context);
  vm.runInContext(fs.readFileSync(appFile("undo-store.js"),"utf8"),context);
  vm.runInContext(fs.readFileSync(appFile("pcb-appearance.js"),"utf8"),context);
  const appearance=context.AtriumPCBAppearance;
  context.AtriumPCBAppearance={...appearance,readDefinition(...args){
    definitions++;return appearance.readDefinition(...args);
  },partTextLayers(...args){
    layerReads++;return appearance.partTextLayers(...args);
  },layerAlpha(layer){return orderedCopper && layer==="Top" ? .5 : 1;}};
  vm.runInContext(fs.readFileSync(appFile("canvas.js"),"utf8"),context);
  vm.runInContext(gpuCode.replace(sceneExport,"{textLayer, render, damage, stats,"),context);
  const ink=[], uploaded=[], W=96, H=64;
  const ctx=new Proxy({clearRect(){ink.length=0;},fillText(text){ink.push(text);},
    moveTo(x,y){
      if(x===9.5)ink.push("cutout");
      if(x===1)ink.push(y===0?"near copper":"far copper");
    }},
    {get(o,key){return o[key]??(()=>{});}});
  const canvas={width:W,height:H,getContext:()=>ctx};ctx.canvas=canvas;
  const I=context.AtriumCanvas.create(canvas).internals();
  I.worldToScreen=([x,y])=>[48+x*10,32+y*10];
  let bound;
  const gl={bindTexture(_,tex){bound=tex;},createTexture:()=>new Map(),deleteTexture(){},texStorage2D(){},texParameteri(){},pixelStorei(){},
    texSubImage2D(_,level,x,y){const drawn=[...ink];uploaded.push(drawn);bound.set(y,drawn);}};
  const layer=(name,text)=>({id:text,kind:"label",layer:name,text,x:0,y:0,size:1});
  const front=layer("Silk","front"), back=layer("Bottom silk","back"), hidden=layer("Hidden note","hidden");
  const part={id:"U",kind:"part",def:"fo",x:0,y:0,layer:"Top",showRef:false};
  const items=[front,part,back,hidden], doc=context.Atrium.sheet("pcb","Layer plan");
  doc.items=items;
  doc.pcbDrawing=vm.runInContext("({annotations:{}})",context);
  const shapes=[{kind:"path",points:[[9.5,0],[10,0],[9.5,1]],layer:"Mechanical 2",cutout:true}];
  const defs=new Map([["fo",{footprint:{shapes,pads:[]}}]]);
  const names=["Mechanical 2","Mechanical 3","Silk","Multi","Bottom silk","Top"];
  const layers=new Map(names.map(layer=>[layer,{layer,seg:{n:1},tri:{n:0},blob:{n:0},pblob:{n:0}}]));
  const scene={layers,order:new Map(names.map((name,n)=>[name,n+1])),cache:{},textRev:1,padRev:1};
  scene.order.set("Hidden note",90);
  const st={scene,gl,canvas,text:{},stats:{acc:{board:0,text:0}}};
  const opts={layer:"Top",hidden:new Set(["Hidden note"])}, cam=[0,0,10,false,W,H,1], viewport=[-15,-15,15,15];
  const V={active:"Top",items,o2:opts,viewport};
  const text=context.AtriumCanvasGPU.textLayer(I,st,doc,defs,opts,cam,V,null);
  assert.deepEqual(uploaded,[["front"],["back"],["cutout"]],"band order and the unlisted cutout match the ordinary painter");
  assert.equal(definitions,2,"one definition in the band plan and one during shared drawing setup");
  ink.length=0;
  const newStrip=layer("Silk","entering strip");
  text.strip.paintBand(ctx,4,[newStrip],null,null,list=>list,viewport);
  assert.deepEqual(ink,["entering strip"],"pan repair uses its current objects");

  // Texture storage may stay warm for a temporary empty camera. It belongs to
  // the current document and must be given back when that document loses its ink.
  const held = {}, vacant = {...V, items:[]}, farCam = [100, ...cam.slice(1)], freed = [];
  gl.deleteTexture = texture => { if (texture) freed.push(texture); };
  const renderHeld = (at, scope) => context.AtriumCanvasGPU.textLayer(I,st,doc,defs,opts,at,scope,null,held);
  renderHeld(cam,V);
  const allocated = Array.from(held.bands, b=>b.tex);
  assert.ok(allocated.length>1 && allocated.every(Boolean));
  assert.equal(renderHeld(farCam,vacant),null);
  assert.equal(held.strip,null,"an empty camera releases its old pan painter");
  assert.deepEqual(freed,[],"crossing the board edge can reuse its texture storage");
  assert.equal(renderHeld(cam,V),held);
  assert.deepEqual(Array.from(held.bands,b=>b.tex),allocated);
  scene.rev = 1; scene.textRev++;
  assert.equal(renderHeld(cam,vacant),null);
  assert.deepEqual(freed,allocated,"removing the final text returns every allocated band");
  assert.equal(renderHeld(cam,vacant),null);
  assert.deepEqual(freed,allocated,"a second empty frame cannot free the same textures twice");
  scene.rev++; scene.textRev++;
  uploaded.length=0; renderHeld(cam,V);
  assert.deepEqual(uploaded,[["front"],["back"],["cutout"]],"restoring the edit rebuilds the same band contents");
  assert.ok(Array.from(held.bands,b=>b.tex).every(t=>!allocated.includes(t)));

  // The camera retains both candidate lists, but ordinary slices use the text candidates only.
  const track=y=>({kind:"track",layer:"Top",width:.2,points:[[1,y],[2,y]]});
  const near=track(0), far=track(9), area=[0,28,W,8];
  let allScans=0;
  V.all=new Proxy([...items,near,far],{get(rows,key){
    if(key==="filter")allScans++;
    return rows[key];
  }});
  scene.cache.boxes=new Map([[near,[1,0,2,0]],[far,[1,9,2,9]]]);
  I.lodFor=()=>null;
  const slice=()=>{
    uploaded.length=0;
    context.AtriumCanvasGPU.textLayer(I,st,doc,defs,opts,cam,V,null,text,area);
    return uploaded.flat();
  };
  const ordinary=slice();
  assert.ok(ordinary.includes("front") && ordinary.includes("back"),"ordinary slices paint their visible glyphs");
  assert.equal(allScans,0,"ordinary slices do not filter the unused full viewport");
  orderedCopper=true;
  const copper=slice();
  assert.equal(allScans,1,"an ordered copper layer still filters its full candidate list");
  assert.ok(copper.includes("near copper") && !copper.includes("far copper"),"ordered copper uses the current row bounds");
  near.points=far.points;
  scene.cache.boxes.set(near,scene.cache.boxes.get(far));
  assert.equal(slice().includes("near copper"),false,"the next slice reads edits from the current bounds");

  orderedCopper=false;
  const pad={kind:"pad",x:0,y:0,w:2,h:2,number:"caption",net:"VCC",layer:"Multi"};
  V.padDetails=true; V.all=[...items,pad];
  I.query=()=>[pad];
  I.padText=(g,p)=>g.fillText(p.number);
  for(const item of V.all)scene.cache.boxes.set(item, [0,-.25,1,.25]);
  const allRows=owner=>{
    const target={key:null};
    const counter=owner==="wideText"?"wideSliceUploadBytes":"textSliceUploadBytes";
    const previous=st.stats.textUpload, before=st.stats[counter] || 0;
    uploaded.length=0;
    if(owner)st[owner]={T:target};
    for(let y=0;y<H;y+=8)context.AtriumCanvasGPU.textLayer(I,st,doc,defs,opts,cam,V,null,target,[0,y,W,8]);
    if(owner)st[owner]=null;
    if(owner) {
      assert.equal(st.stats.textUpload,previous,"offscreen preparation cannot change the displayed frame's byte count");
      assert.equal(st.stats[counter]-before,uploaded.length*W*8*4,"count the texture bytes in the owning slice job");
    }
    const images=Array.from(target.bands,b=>Array.from({length:H/8},(_,y)=>b.tex?.get(y*8)??[]));
    return {images,calls:uploaded.length,target};
  };
  const explicit=allRows(), fresh=allRows("textJob"), wide=allRows("wideText");
  assert.deepEqual(fresh.images,explicit.images,"untouched texture rows match explicitly uploaded transparent rows");
  assert.ok(fresh.calls<explicit.calls,"fresh slices do not submit empty band rows");
  assert.deepEqual(wide.images,explicit.images,"the same rows match during wide preparation");
  assert.equal(wide.calls,fresh.calls);
  const captions=fresh.images.find(rows=>rows.some(row=>row.includes("caption")));
  assert.ok(captions?.[3].includes("caption") && captions[4].includes("caption"),
    "a caption-only band crosses the boundary between two slices");

  // The active slice may reuse the viewport's layer scan, but not across drafts,
  // library replacement, late designator loading or a different viewport list.
  const U=context.AtriumUndoStore, project=context.Atrium.project("Layer scan test"), history=[], future=[];
  project.documents=[doc];
  project.library=[{...defs.get("fo"),id:"fo"}];
  defs.set("fo",project.library[0]);
  const target={key:null};
  st.textJob={T:target,V};
  const render=(scope=V,T=target,board=doc)=>{
    context.AtriumCanvasGPU.textLayer(I,st,board,defs,opts,cam,scope,null,T,area);
    return Array.from(T.bands,b=>b.next);
  };
  const scans=(expected, reason, board=doc)=>{
    const before=layerReads;
    render(V,target,board); render(V,target,board);
    assert.equal(layerReads-before,expected,reason);
  };

  U.reset(project);
  assert.equal(U.documentVersions(doc),null);
  assert.ok(U.verifiedDocumentVersion(doc)!=null);
  scans(1,"two rows reuse a verified native snapshot before the first Undo mark");
  assert.equal(U.root(),null);
  assert.equal(U.stats().records,0);
  st.textJob=null;
  scans(2,"a collapsed or cancelled job leaves no verified plan for a direct render");
  st.textJob={T:target,V};
  scans(1,"replacement jobs resolve a fresh verified layer set");
  U.duringEdit(()=>{
    assert.equal(U.verifiedDocumentVersion(doc),null);
    scans(2,"a live draft never uses a prior verified snapshot");
  });
  scans(1,"the first verified row after a draft rebuilds the cleared snapshot");

  const page=context.Atrium.sheet("pcb","Page loaded later");
  scans(2,"a foreign page cannot borrow the verified document snapshot",page);
  scans(1,"the original verified page can cache again");
  const beforePage=U.verifiedDocumentVersion(doc), beforePageLibrary=U.libraryVersion();
  U.reconcile(project,()=>project.documents.push(page),{structureChanged:true});
  assert.equal(U.documentVersions(doc),null);
  assert.ok(U.verifiedDocumentVersion(doc)>beforePage);
  assert.equal(U.libraryVersion(),beforePageLibrary);
  scans(1,"lazy document adoption advances the verified floor without changing the library");
  scans(1,"the newly adopted page uses its own verified snapshot",page);
  scans(1,"returning to the original page builds its snapshot");

  U.reconcile(project,()=>{
    project.library[0].footprint.shapes=[...shapes,{kind:"text",layer:"Mechanical 3",text:"disk glyph",x:0,y:0,size:1}];
  },{doc,library:true});
  uploaded.length=0;
  scans(1,"disk adoption refreshes the cached footprint text layers");
  assert.ok(uploaded.flat().includes("disk glyph"));
  U.touch(project,{doc,items:[part]});
  assert.equal(U.verifiedDocumentVersion(doc),null);
  scans(2,"an unrecorded item change invalidates cold layer reuse immediately");

  U.reset(project);
  scans(1,"a verified reset starts a fresh layer scan");
  U.reset();
  scans(2,"a reset without verification cannot inherit the previous scan");
  U.reset(project);
  context.AtriumUndoStore={...U,verifiedDocumentVersion:board=>board===doc?0:null};
  scans(1,"a verified floor of zero qualifies");
  context.AtriumUndoStore=U;
  scans(1,"returning to the native store starts a new verified snapshot");
  const beforeMark=U.verifiedDocumentVersion(doc), mark=U.mark(project);
  assert.equal(U.verifiedDocumentVersion(doc),null);
  assert.equal(U.documentVersions(doc).floor,beforeMark,"a first mark keeps the existing disk floor");
  scans(1,"the first Undo mark starts a separate committed snapshot at the same floor");
  const beforeLibrary=layerReads;
  project.library[0].footprint.shapes=[...shapes,{kind:"text",layer:"Mechanical 3",text:"new footprint glyph",x:0,y:0,size:1}];
  U.checkpoint(history,future,mark,"Add footprint text");
  U.record(project,[{library:true}]);
  uploaded.length=0;
  const editedBands=render();
  assert.equal(layerReads-beforeLibrary,1,"new definitions invalidate the previous band scan");
  assert.ok(uploaded.flat().includes("new footprint glyph"),"a new library revision paints its authored glyph");
  assert.deepEqual(editedBands,render(V,{key:null}),"the edited band order matches a fresh read");
  U.jump(history,future,U.mark(project),-1);
  uploaded.length=0; render();
  assert.ok(!uploaded.flat().includes("new footprint glyph"),"Undo restores the pre-edit band content");
  U.jump(history,future,U.mark(project),1);
  uploaded.length=0; render();
  assert.ok(uploaded.flat().includes("new footprint glyph"),"Redo restores the authored footprint text");
  const beforeRevision=U.documentVersions(doc);
  const beforeItemEdit=layerReads;
  part.designator={x:0,y:0}; part.showRef=true; part.ref="U1";
  U.record(project,[{doc,items:[part]}]);
  assert.ok(U.documentVersions(doc).items>beforeRevision.items,"the journal records the authored item edit");
  render();
  assert.equal(layerReads-beforeItemEdit,1,"a committed item edit invalidates the scan before the viewport list changes");
  const oldItems=V.items; V.items=V.items.filter(item=>item!==front);
  const withoutDesignators=render(), beforeDesignators=layerReads;
  vm.runInContext(fs.readFileSync(appFile("designator-place.js"),"utf8"),context);
  uploaded.length=0;
  const withDesignators=render();
  assert.equal(layerReads-beforeDesignators,1,"late designator availability invalidates a committed layer scan");
  assert.notDeepEqual(withDesignators,withoutDesignators,"the new silk designator adds its layer to the band plan");
  assert.ok(uploaded.flat().includes("U1"),"the new band paints the authored designator");
  assert.deepEqual(withDesignators,render(V,{key:null}),"the loaded designator uses the fresh band order");
  delete part.designator;
  part.sourceRecord="components6/data#0";
  U.record(project,{doc,items:[part]});
  render();
  const beforeAnnotations=U.documentVersions(doc), beforeAnnotationScan=layerReads;
  doc.pcbDrawing.annotations={"components6/data#0":[{field:"ref",at:[0,0],angle:0,size:1,layer:"Silk"}]};
  U.record(project,{doc});
  assert.equal(U.documentVersions(doc).seq,beforeAnnotations.seq,"annotation metadata does not advance the item journal");
  assert.ok(U.documentVersions(doc).outer>beforeAnnotations.outer);
  uploaded.length=0; render();
  assert.equal(layerReads-beforeAnnotationScan,1,"imported annotation metadata invalidates the owned scan");
  assert.ok(uploaded.flat().includes("U1"),"the updated imported annotation is painted");
  const replacement=context.Atrium.project("Same document in a replacement project");
  replacement.documents=[doc]; replacement.library=project.library;
  const beforeReplacement=U.documentVersions(doc), beforeReplacementScan=layerReads;
  U.mark(replacement);
  assert.ok(U.documentVersions(doc).floor>beforeReplacement.floor,"project replacement moves the journal floor");
  render();
  assert.equal(layerReads-beforeReplacementScan,1,"the same doc and definitions may not retain a scan across project replacement");
  const beforeList=layerReads;
  V.items=V.items.slice();
  render();
  assert.equal(layerReads-beforeList,1,"a different viewport list cannot borrow the scan");
  V.items=oldItems;
  const beforeDraft=layerReads;
  U.duringEdit(()=>{
    assert.equal(U.documentVersions(doc),null);
    render(); render();
  });
  assert.equal(layerReads-beforeDraft,2,"uncommitted rows always resolve live part layers");
  U.reset();
  st.textJob=null;

  for(const item of V.all){
    item.y=9;
    scene.cache.boxes.set(item,[0,9,1,9.5]);
  }
  uploaded.length=0;
  st.textJob={T:{key:null}};
  context.AtriumCanvasGPU.textLayer(I,st,doc,defs,opts,cam,V,null,fresh.target,[0,24,W,8]);
  st.textJob=null;
  assert.ok(uploaded.length && uploaded.every(row=>!row.length),"a reused band explicitly clears stale rows");
  assert.ok(fresh.target.bands.every(b=>!b.tex?.get(32)?.length));
}

// Only a complete, single-colour coverage mask takes the direct WebKitGTK transfer.
{
  const W=47,H=31, gtk={platform:"Linux aarch64",userAgent:"AppleWebKit/605.1 Safari/605.1"};
  for (const [navigator, direct] of [[gtk,true],[{...gtk,platform:"MacIntel"},false],
    [{...gtk,userAgent:"Android AppleWebKit/605.1"},false],[{userAgent:gtk.userAgent},false]]) {
    const context=vm.createContext({AtriumPCBAppearance,navigator});
    vm.runInContext(gpuCode.replace(sceneExport,"{uploadCanvas, render, damage, stats,"),context);
    const area=[], transfers=[], stores=new Map(), data={};
    const canvas={width:W,height:H,getContext:()=>({getImageData(...rect){area.push(rect);return data;}})};
    const gl={ALPHA:1,RGBA:2,UNPACK_ALIGNMENT:3,UNPACK_FLIP_Y_WEBGL:4,bindTexture(){},
      pixelStorei(key,value){stores.set(key,value);},texSubImage2D(...args){transfers.push(args);}};
    const upload=(...args)=>context.AtriumCanvasGPU.uploadCanvas(gl,{},canvas,...args);
    upload(0,0,W,H,gl.ALPHA);
    assert.equal(transfers.at(-1).at(-1),direct?canvas:data,"full mask texture source");
    upload(2,4,7,9,gl.ALPHA);
    assert.equal(transfers.at(-1).at(-1),data,"read just the changed mask area");
    assert.deepEqual(transfers.at(-1).slice(2,6),[2,H-4-9,7,9],"bottom-origin upload of the same rectangle");
    upload(0,0,W,H,gl.RGBA);
    assert.equal(transfers.at(-1).at(-1),data,"colour bands preserve their RGBA readback");
    assert.deepEqual(area,direct?[[2,4,7,9],[0,0,W,H]]:[[0,0,W,H],[2,4,7,9],[0,0,W,H]]);
    assert.equal(stores.get(gl.UNPACK_ALIGNMENT),4);
    assert.equal(stores.get(gl.UNPACK_FLIP_Y_WEBGL),false);
    data.data=new Uint8ClampedArray(4*8);
    if (direct) {
      let count=transfers.length;
      assert.equal(upload(3,5,4,2,gl.RGBA,undefined,true),false,"zero RGBA can stay untouched on a brand-new stripe");
      assert.equal(transfers.length,count);
      assert.equal(stores.get(gl.UNPACK_FLIP_Y_WEBGL),false,"empty transfer restores the unpack setting");
      upload(3,5,4,2,gl.RGBA);
      assert.equal(transfers.length,++count,"a reused stripe still needs an explicit transparent clear");
      data.data[7]=1;
      upload(3,5,4,2,gl.RGBA,undefined,true);
      assert.equal(transfers.length,++count,"even the faintest nonempty pixel is written");
      data.data[7]=0;
      data.data[12]=1;
      upload(3,5,4,2,gl.RGBA,undefined,true);
      assert.equal(transfers.length,++count,"zero-alpha pixels with nonzero colour bytes are still written");
      data.data.fill(0);
      assert.equal(upload(3,5,4,2,gl.ALPHA,undefined,true),true,"a partial mask still uses the normal transfer");
      assert.equal(stores.get(gl.UNPACK_ALIGNMENT),4);
    } else {
      assert.equal(upload(3,5,4,2,gl.RGBA,undefined,true),true,"other platforms keep their usual transfer");
    }
  }
}

{
  const vmLayerOrder = vm.createContext({AtriumPCBAppearance, AtriumSpatial});
  vm.runInContext(gpuCode.replace(sceneExport,"{scope, layerPlan, drawPasses, render, damage, stats,"),vmLayerOrder);
  const {scope,layerPlan,drawPasses}=vmLayerOrder.AtriumCanvasGPU;
  const visible = ["Top", "Bottom", "Multi", "Mechanical 1", "Mechanical 2", "Silk"];
  const layers = new Map(visible.map(layer=>[layer,{layer,rep:{kind:"via",fromLayer:"Top",toLayer:"Bottom"}}]));
  const board = Atrium.sheet("pcb","Single layer ordering"), defs = new Map();
  const st = {scene:{layers,cache:{bounds:[-200,-100,200,100],rev:1,all:[]}},stats:{}};
  const order = ["Mechanical 2","Mechanical 1","Bottom","Silk","Multi","Top"];
  let calls = 0;
  const I = {query:()=>[],paintOrder(){calls++;return order;}};
  const cam = [0,0,8,true,400,320,2];
  const active = {layer:"Top"}, multi = layers.get("Multi").rep;
  assert.ok(AtriumPCBAppearance.visible("Multi",multi,{...active,layerMode:"single"}));
  assert.ok(!AtriumPCBAppearance.visible("Multi",{...multi,fromLayer:"Inner 1"},{...active,layerMode:"single"}));
  const stored = {layer:"Top",bounds:[-1,-1,2,2]};
  board.pcbDrawing = {pours:[stored]};
  const preview = [stored,{layer:"Mechanical 2",bounds:[-2,-2,2,2]}];
  for (const layerMode of ["all","single","dim"]) {
    const opts = {...active,layerMode,ghost:{kind:"track",layer:"Mechanical 2",width:.2,points:[[0,0],[2,0]]}};
    const V = scope(I,st,board,defs,opts,cam,preview);
    const plan=layerPlan(st,opts,true), pass=drawPasses(st,plan,st.scene.order,new Map());
    const layersInOrder=Array.from(pass,x=>x.layer);
    if (layerMode==="single") {
      assert.equal(st.scene.order,null,"visible single-layer ranks need no viewport tie scan");
      assert.equal(calls,1,"the hidden mechanical pair never triggers single-layer order collection");
      assert.deepEqual(layersInOrder,["Multi","Top"],"spanning copper and the active layer keep their physical order");
      assert.equal(V.liveLayers,null,"a hidden preview pour cannot add a visible band");
      assert.ok(!AtriumPCBAppearance.visible(opts.ghost.layer,opts.ghost,opts),"the ghost uses the same single-layer visibility");
    } else {
      assert.equal(calls,layerMode==="all"?1:2,"tied visible layers still consult the reference painter");
      assert.ok(layersInOrder.indexOf("Mechanical 2")<layersInOrder.indexOf("Mechanical 1"),
        "equal-ranked mechanics still use the order from the live viewport");
    }
  }
  // A prospective visible layer can be pour-only. It still reserves its band
  // and composes above Multi without needing the arbitrary hidden ties.
  layers.delete("Top");
  board.pcbDrawing.pours=[];
  const only = {layer:"Top",bounds:[-2,-2,2,2]}, opts={...active,layerMode:"single"};
  const V=scope(I,st,board,defs,opts,cam,[only]);
  assert.deepEqual(Array.from(V.liveLayers),["Top"]);
  const passes=drawPasses(st,layerPlan(st,opts,true),st.scene.order,new Map([["Top",[only]]]));
  assert.deepEqual(Array.from(passes,p=>p.layer),["Multi","Top"]);
  assert.equal(calls,2,"preview-only copper does not start tie ordering in single mode");
  console.log("Single-layer GPU order ignores hidden ties and keeps the active and spanning physical passes");
}

// Keep the full pixel result when a band's new footprint is smaller or moves away.
{
  require("../../app/pcb/pcb-draw.js");
  const webKit=vm.createContext({AtriumPCBAppearance,AtriumResolvedLand,AtriumSpatial,navigator:{userAgent:"AppleWebKit"}});
  vm.runInContext(gpuCode.replace(sceneExport,"{textLayer, L, render, damage, stats,"),webKit);
  const {textLayer,L}=webKit.AtriumCanvasGPU;
  let W=144,H=96;
  const doc=Atrium.sheet("pcb","Text band uploads"),defs=new Map();
  const label={id:"legend",kind:"label",layer:"Silk",text:"jÉ",size:.08,width:.002,x:0,y:0,angle:37,italic:true};
  const pad={...F4.pad,id:"land",kind:"pad",layer:"Top",net:"LONG_NET_NAME",x:0,y:0,w:6,h:3,drill:0};
  const line={id:"path",kind:"label",text:"Imported annotation",size:1.1,width:.2,layer:"Silk",x:1,y:1,
    points:[[-5,-4],[5,-4]]};
  const rec=AtriumPDF.recorder(W,H), view=AtriumCanvas.create(rec.canvas);
  let scratch=new Uint8Array(W*H);
  const reads=[];
  let bound, drawCaption=false;
  rec.ctx.clearRect=()=>scratch.fill(0);
  rec.ctx.fillRect=(x,y,w,h)=>{
    const {a,b,c,d,e,f}=rec.ctx.getTransform();
    const points=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]];
    const xs=points.map(([u,v])=>a*u+c*v+e), ys=points.map(([u,v])=>b*u+d*v+f);
    for(let row=Math.floor(Math.min(...ys));row<Math.ceil(Math.max(...ys));row++)
      scratch.fill(1,row*W+Math.floor(Math.min(...xs)),row*W+Math.ceil(Math.max(...xs)));
  };
  rec.ctx.fillText=value=>{ if(value===pad.net)drawCaption=true; };
  let pathY;
  const moveTo=rec.ctx.moveTo.bind(rec.ctx);
  rec.ctx.moveTo=(x,y)=>{ if(y===-4)pathY=y; moveTo(x,y); };
  rec.ctx.getImageData=(x,y,w,h)=>{ reads.push([x,y,w,h]); return scratch; };
  const gl={RGBA:1,createTexture:()=>new Uint8Array(W*H),bindTexture(_,t){bound=t;},
    texStorage2D(){},texParameteri(){},pixelStorei(){},deleteTexture(){},
    texSubImage2D(_,level,x,bottom,w,h,format,type,pixels){
      for(let row=H-bottom-h;row<H-bottom;row++) {
        if(pixels===scratch) bound.set(pixels.subarray(row*W+x,row*W+x+w),row*W+x);
        else {
          const start=(row-(H-bottom-h))*w*4;
          assert.ok(pixels.length>=w*h*4 && !pixels.subarray(start,start+w*4).some(Boolean),"blank RGBA strip");
          bound.fill(0,row*W+x,row*W+x+w);
        }
      }
    }};
  function paint(st,items,cx,flipped,dpr,scale,hidden,useLOD=false,hooks) {
    doc.items=items;
    const layer="Top",opts={layer,layerMode:"all",flipped,hidden,...hooks};
    const I={...view.internals(),ctx:rec.ctx,worldToScreen:()=>[W/(2*dpr)+(flipped?cx:-cx)*scale,H/(2*dpr)],query:()=>items};
    if (useLOD) { view.internals().sync(doc,defs); view.internals().lodForce=true; }
    const V={items:items.filter(i=>i.kind==="label" || i.kind==="part" || i.keepout),all:items,active:layer,o2:opts,padDetails:items.includes(pad),viewport:[-20,-20,20,20]};
    return textLayer(I,st,doc,defs,opts,[cx,0,scale,flipped,W/dpr,H/dpr,dpr],V,null);
  }
  const state=()=>({gl,canvas:rec.canvas,text:{},stats:{acc:{board:0,text:0}},scene:{
    id:1,rev:1,textRev:1,layers:new Map(),byId:new Map(),cache:{boxes:new Map([[label,[-.25,-.25,.25,.25]]])}}});
  for(const [flipped,dpr] of [[false,1],[true,2]]) {
    const st=state();
    paint(st,[label],-2,flipped,dpr,6);
    const [x,y,w,h]=reads.at(-1);
    assert.ok(w*h<W*H/4,"a low-detail glyph reads only its occupied area");
    assert.ok(scratch.includes(1),"the rotated low-detail label painted");
    const first=scratch.indexOf(1);
    assert.ok(x<=first%W && first%W<x+w && y<=Math.floor(first/W) && Math.floor(first/W)<y+h);
    paint(st,[label],2,flipped,dpr,6);
    assert.equal(scratch[first],0,"the old and new label poses are disjoint");
    assert.deepEqual(st.text.bands[0].tex,scratch,"upload both new and previous ink with the flipped/DPR transform");
    paint(st,[label],1,flipped,dpr,6);
    assert.deepEqual(st.text.bands[0].tex,scratch,"the next crop has exactly the current glyph");
    const [left,,width]=reads.at(-1);
    assert.ok(first%W<left || first%W>=left+width,"drop the first ink extent once it has been cleared");
  }
  for(const [flipped,dpr] of [[false,1],[true,2]]) {
    const st=state(), before={...label,x:-10,y:-6}, after={...label,x:10,y:6};
    paint(st,[before],0,flipped,dpr,6/dpr);
    const oldPixel=scratch.indexOf(1), readStart=reads.length;
    assert.ok(oldPixel>=0,"the first camera drew visible ink");
    paint(st,[after],.125,flipped,dpr,6/dpr);
    assert.ok(scratch.includes(1) && !scratch[oldPixel],"the new ink is far from the old");
    assert.deepEqual(st.text.bands[0].tex,scratch,"the previous ink was erased");
    const readPixels=reads.slice(readStart).reduce((sum,[,,w,h])=>sum+w*h,0);
    assert.ok(readPixels<512,`separated ink should not read the empty gap (${readPixels} pixels)`);
  }
  const measure=rec.ctx.measureText;
  try {
    rec.ctx.measureText=undefined;
    paint(state(),[pad],0,false,1,19);
    assert.equal(drawCaption,true,"the real native-font pad caption was painted");
    assert.deepEqual(reads.at(-1),[0,0,W,H],"unknown caption bounds require a full band transfer");
    let measured=0;
    rec.ctx.measureText=function(text){
      assert.equal(text,pad.net);assert.equal(this.textAlign,"center");assert.equal(this.textBaseline,"alphabetic");
      measured++;return {actualBoundingBoxLeft:11,actualBoundingBoxRight:13,actualBoundingBoxAscent:8,actualBoundingBoxDescent:3};
    };
    const retained=state();
    paint(retained,[pad],0,false,1,19);
    assert.equal(measured,1,"measure just the caption that was drawn, at its real font and alignment");
    const [x,y,w,h]=reads.at(-1);
    assert.ok(x<=W/2-11 && x+w>=W/2+13 && w<32 && h<20,"read only the native ink and its antialiasing margin");
    paint(retained,[pad],8,false,1,19);
    assert.deepEqual(reads.at(-1),[x,y,w,h],"a fully offscreen caption only clears the previous ink");
    const offscreen=state();
    paint(offscreen,[pad],8,false,1,19);
    assert.equal(offscreen.text.bands[0].tex,null,"an initially offscreen caption needs no backing");
    paint(offscreen,[pad],0,false,1,19);
    assert.ok(offscreen.text.bands[0].tex,"the same band acquires its backing when the caption enters");
    rec.ctx.measureText=()=>({actualBoundingBoxLeft:NaN});
    paint(state(),[pad],0,false,1,19);
    assert.deepEqual(reads.at(-1),[0,0,W,H],"incomplete native metrics retain the full transfer");
  } finally {rec.ctx.measureText=measure;}
  // The clipped WebKit slice uses real padText with a raster oracle for the platform glyph bounds.
  {
    const U=AtriumUndoStore, project=Atrium.project("Caption slices");
    project.documents=[doc];
    const parent={id:"P",kind:"part",def:"slices",x:0,y:0,angle:180,mirror:true,layer:"Bottom",showRef:false};
    defs.set(parent.def,{id:parent.def,footprint:{shapes:[],pads:[
      {...pad,number:"short",net:"N",x:1,y:1.5,w:3,h:1.4,angle:90},
      {...pad,number:"tall",net:"",x:-1,y:0,w:3,h:1.4,angle:90},
      {...pad,number:"µ?",net:"",x:0,y:-1,w:3,h:1.4,angle:90}
    ]}});
    project.library=[...defs.values()];
    doc.items=[parent];
    U.reset(project);
    webKit.AtriumUndoStore=U;
    const fonts={status:"loaded",ready:{},size:1};
    rec.canvas.ownerDocument={fonts};
    const previousPaint=rec.ctx.fillText;
    let fills=[], metrics=[], flipped=true, tall=17;
    const glyph=text=>({actualBoundingBoxLeft:3,actualBoundingBoxRight:4,
      actualBoundingBoxAscent:text==="tall"?tall:3,actualBoundingBoxDescent:2});
    rec.ctx.measureText=text=>{metrics.push(text);return text==="µ?"?null:glyph(text);};
    rec.ctx.fillText=(text,x,y)=>{
      fills.push(text);
      const m=glyph(text), {a,b,c,d,e,f}=rec.ctx.getTransform();
      const corners=[];
      for(const px of [x-m.actualBoundingBoxLeft,x+m.actualBoundingBoxRight])
        for(const py of [y-m.actualBoundingBoxAscent,y+m.actualBoundingBoxDescent])corners.push([a*px+c*py+e,b*px+d*py+f]);
      const xs=corners.map(q=>q[0]),ys=corners.map(q=>q[1]);
      const x0=Math.max(0,Math.floor(Math.min(...xs))),x1=Math.min(W,Math.ceil(Math.max(...xs)));
      if(x0>=x1)return;
      for(let row=Math.max(0,Math.floor(Math.min(...ys)));row<Math.min(H,Math.ceil(Math.max(...ys)));row++)
        scratch.fill(1,row*W+x0,row*W+x1);
    };
    try {
      function rows(owned) {
        const st=state(), T={}, dpr=2, scale=18, opts={layer:"Bottom",flipped,selected:parent.id};
        const V={items:[parent],all:[parent],active:opts.layer,o2:opts,padDetails:true,viewport:[-8,-8,8,8]};
        const I={...view.internals(),ctx:rec.ctx,worldToScreen:([x,y])=>[W/4+(flipped?-x:x)*scale,H/4+y*scale],query:()=>[]};
        if(owned) st.textJob={T,V};
        return {st,T,draw(y){textLayer(I,st,doc,defs,opts,[0,0,scale,flipped,W/dpr,H/dpr,dpr],V,null,T,[0,y,W,8]);}};
      }
      for(const mirrorView of [true,false]){
        flipped=mirrorView;
        const expected=rows(false), sliced=rows(true);
        const render=job=>{
          fills=[];metrics=[];
          job.draw(0);
          assert.equal(metrics.length,0,"the first slice does not measure captions");
          for(let y=8;y<H;y+=8)job.draw(y);
          return {fills:[...fills],metrics:[...metrics],ink:Array.from(job.T.bands,b=>b.tex)};
        };
        const control=render(expected), result=render(sliced);
        assert.deepEqual(result.ink,control.ink,"exact captured glyph coverage keeps mirrored, selected, dual and oversized caption pixels");
        assert.ok(result.ink.some(pixels=>pixels?.some(Boolean)),"the caption tiles include real overlapping rows");
        assert.ok(result.fills.length<control.fills.length,"owned clipped rows skip captions using their measured ink");
        assert.equal(result.fills.filter(text=>text==="µ?").length,12,"missing font metrics retain every draw");
        assert.ok(result.metrics.length>0 && new Set(result.metrics).size===result.metrics.length,"measure each glyph once");
      }

      tall=8;
      const changing=rows(true);
      fills=[];metrics=[];
      changing.draw(0);changing.draw(8);
      fills=[];metrics=[];
      changing.draw(16);
      assert.ok(!fills.includes("tall"));
      fonts.status="loading";
      fills=[];metrics=[];
      changing.draw(24);
      assert.ok(fills.includes("tall") && !metrics.length,"loading fonts bypass the measurements");
      fonts.status="loaded";fonts.ready={};changing.draw(32);
      fonts.ready={};tall=40;
      fills=[];metrics=[];
      changing.draw(40);
      assert.ok(metrics.includes("tall"),"new font readiness discards all previously measured bounds");
      fonts.size++;
      fills=[];metrics=[];
      changing.draw(48);
      assert.ok(metrics.includes("tall"),"adding an already loaded face invalidates the prior bounds");
      rec.canvas.ownerDocument.fonts={...fonts};
      fills=[];metrics=[];
      changing.draw(56);
      assert.ok(metrics.includes("tall"),"a new font set cannot inherit the previous bounds");
      fills=[];metrics=[];
      U.duringEdit(()=>changing.draw(64));
      assert.ok(fills.includes("tall") && !metrics.length,"a live draft draws with no retained metrics");
      fills=[];metrics=[];
      changing.draw(72);
      assert.ok(metrics.includes("tall"),"the verified job resolves again after draft invalidation");
      delete changing.st.textJob;
      fills=[];metrics=[];
      changing.draw(80);
      assert.ok(fills.includes("short")&&!metrics.length,"a retired job cannot expose its caption map to direct or strip paint");
    } finally {
      U.reset();
      delete webKit.AtriumUndoStore;
      delete rec.canvas.ownerDocument;
      rec.ctx.fillText=previousPaint;
      rec.ctx.measureText=measure;
      defs.delete(parent.def);
    }
  }
  paint(state(),[label,line],0,false,1,9);
  assert.equal(pathY,-4,"a label record with points took the path painter");
  assert.deepEqual(reads.at(-1),[0,0,W,H],"artwork from the path branch falls back despite the label kind");
  const part={id:"P1",kind:"part",def:"legend",ref:"U1",refAt:[0,1],x:0,y:0,layer:"Top"};
  const shapes=[40,0,3,6].map((x,i)=>({kind:"text",layer:"Silk",text:"L"+i,x,y:0,size:.25}));
  defs.set(part.def,{id:part.def,footprint:{pads:[],shapes}});
  const probed=[], drawn=[], {paintBox,draw}=AtriumPCBText;
  try {
    AtriumPCBText.paintBox=(item,...args)=>{probed.push(item.text);return paintBox(item,...args);};
    AtriumPCBText.draw=(ctx,item,...args)=>{drawn.push(item.text);return draw(ctx,item,...args);};
    paint(state(),[part],0,false,1,6);
    assert.deepEqual(drawn,["L0","L1","L2","L3","U1"],"every glyph still reaches the band painter");
    assert.deepEqual(probed,["L0","L1"],"an offscreen glyph is insufficient, but the first visible glyph proves occupancy for the whole band");
  } finally { Object.assign(AtriumPCBText,{paintBox,draw}); }
  const keepout={id:"hatch",kind:"graphic",layer:"Silk",keepout:true,fill:true,closed:true,
    points:[[-1.3,-3],[1.2,-2.9],[1,-1.2],[-1.2,-1.1]]};
  const stroke=rec.ctx.stroke;
  let boundary, wideCap;
  try {
    rec.ctx.stroke=function(...args) {
      stroke.apply(this,args);
      // Stamp the emitted dashed path in the fake backing independently of its upload bounds.
      const op=rec.list.at(-1);
      if (!op?.dash?.length && !(op?.w > 4)) return;
      const x=Math.floor(op.d[1]-(op.dash?.length ? 0 : op.w/2-.25)), y=Math.floor(op.d[2]);
      if (x>=0 && y>=0 && x<W && y<H) {
        const pixel=y*W+x;
        if (op.dash?.length) boundary=pixel;
        else {
          assert.equal(op.join,"round"); assert.equal(op.cap,"round");
          wideCap=pixel;
        }
        scratch[pixel]=2;
      }
    };
    const st=state();
    paint(st,[label,keepout],-3,true,1.5,6);
    const first=boundary, [, , w,h]=reads.at(-1);
    assert.ok(w*h<W*H/4,"the actual hatched keepout narrows the upload");
    assert.equal(scratch[first],2,"a visible boundary reached the backing");
    assert.deepEqual(st.text.bands[0].tex,scratch,"first transfer keeps the keepout");
    paint(st,[label,keepout],3,true,1.5,6);
    const second=boundary;
    assert.notEqual(second,first,"the new camera moves the keepout boundary");
    assert.equal(st.text.bands[0].tex[first],0,"a crop clears the prior keepout location");
    assert.deepEqual(st.text.bands[0].tex,scratch,"the new location and surrounding blank agree");
    paint(st,[label,keepout],2,true,1.5,6,new Set(["Silk"]));
    assert.ok(!st.text.bands[0]?.tex,"hiding the band removes its backing from composition");
    paint(st,[label,keepout],3,true,1.5,6);
    assert.equal(st.text.bands[0].tex[boundary],2,"the visible band repaints");
    st.scene.rev++; st.scene.textRev++;
    paint(st,[label],3,true,1.5,6);
    assert.deepEqual(st.text.bands[0].tex,scratch,"deleting the keepout clears its prior ink");
    assert.ok(!scratch.includes(2));
    const thick={...keepout,fill:false,closed:false,width:2};
    const lineState=state();
    paint(lineState,[label,thick],0,false,1,6);
    assert.ok(reads.at(-1)[2]*reads.at(-1)[3]<W*H/4,"the thick open keepout narrows the upload");
    const originalCap=wideCap;
    assert.equal(scratch[originalCap],2,"the wide round cap extends beyond its dashed spine");
    assert.deepEqual(lineState.text.bands[0].tex,scratch,"the crop retains the outer stroke");
    paint(lineState,[label,{...thick,closed:true}],-3,true,1.5,6);
    assert.equal(lineState.text.bands[0].tex[originalCap],0,"the flipped move erases the old cap");
    assert.deepEqual(lineState.text.bands[0].tex,scratch);
    lineState.scene.rev++; lineState.scene.textRev++;
    const empty={...thick,points:[thick.points[0]]};
    paint(lineState,[label,empty],-3,true,1.5,6);
    assert.ok(!scratch.includes(2),"a one-vertex path draws no keepout ink");
    assert.deepEqual(lineState.text.bands[0].tex,scratch,"a degenerate edit clears the prior stroke");
    const unknown={...thick,width:Infinity}, unknownState=state();
    paint(unknownState,[label,unknown],0,false,1,6);
    assert.deepEqual(reads.at(-1),[0,0,W,H],"an invalid pen width retains the unknown ink fallback");
    paint(unknownState,[label,thick],1,false,1,6);
    assert.deepEqual(reads.at(-1),[0,0,W,H],"unknown prior ink must be cleared with a full transfer");
    const mounted={...part,def:"keepout-part",showRef:false,x:1,y:1,angle:30,mirror:true};
    const fp=shape=>({id:mounted.def,footprint:{pads:[],shapes:[shape]}});
    defs.set(mounted.def,fp({...thick,kind:"path"}));
    const mountedState=state();
    for(const [camera,flip] of [[-3,false],[3,true],[-3,false]]) {
      paint(mountedState,[mounted],camera,flip,1.5,6);
      const [,,w,h]=reads.at(-1);
      assert.ok(w*h<W*H/2,"the placed keepout supplies its transformed paint bounds");
      assert.ok(scratch.includes(2),"the footprint keepout is visible");
      assert.deepEqual(mountedState.text.bands[0].tex,scratch,"the cropped upload includes the placed dashes and wide caps");
    }
    defs.set(mounted.def,fp({...thick,kind:"path",width:Infinity}));
    paint(state(),[mounted],0,false,1,6);
    assert.deepEqual(reads.at(-1),[0,0,W,H],"an unknown footprint pen retains the full upload");
    defs.delete(mounted.def);
  } finally { rec.ctx.stroke=stroke; }
  // Widely separated glyphs leave large transparent gaps in one ordered band.
  W=1024; H=640; rec.canvas.width=W; rec.canvas.height=H; scratch=new Uint8Array(W*H);
  for(const [flip,dpr] of [[false,1],[true,1.25]]) {
    const st=state(), glyph=(x,y)=>({...label,id:x+","+y,x,y}), pixels=()=>reads.reduce((n,[,,w,h])=>n+w*h,0);
    const first=[glyph(-68,-41),glyph(-43,.1),glyph(64,38)], second=[first[1],glyph(-64,39),glyph(68,-40)];
    reads.length=0;
    paint(st,first,0,flip,dpr,6/dpr);
    assert.ok(scratch.includes(1),"some of the separated glyphs painted");
    assert.deepEqual(st.text.bands[0].tex,scratch,"sparse upload includes every visible glyph");
    const before=scratch.slice();
    paint(st,second,.25,flip,dpr,6/dpr);
    assert.ok(before.some((v,i)=>v!==scratch[i]),"the edit places and removes visible ink");
    assert.deepEqual(st.text.bands[0].tex,scratch,"moving across upload regions clears old ink and retains the boundary glyph");
    assert.ok(pixels()<W*H/4,"separated glyphs do not read the transparent space between them");
    const band=st.text.bands[0];
    band.tex[10*W+20]=1;
    band.inkRect=[0,0,W,H];
    paint(st,second,.4,flip,dpr,6/dpr);
    assert.deepEqual(band.tex,scratch,"a later strip write invalidates previous sparse bounds");
    st.text.bands[0].inkRect=undefined;
    reads.length=0;
    paint(st,first,.5,flip,dpr,6/dpr);
    assert.deepEqual(reads,[[0,0,W,H]],"an unknown previous texture requires a full read");
    assert.deepEqual(st.text.bands[0].tex,scratch,"the fallback clears every previous texel");
  }
  // A real ordered Bottom layer requires batch fallback. An independent Silk
  // band can still crop its authored label and erase a moved or hidden inscription.
  {
    const U=AtriumUndoStore, project=Atrium.project("Independent LOD bands");
    const silk={...label,x:-4}, bottom={...label,id:"bottom-label",layer:"Bottom",x:0,y:3};
    const track={id:"track",kind:"track",layer:"Bottom",points:[[-4,0],[4,0]],width:.3};
    const items=doc.items=[silk,bottom,track], history=[], future=[], st=state();
    project.documents=[doc];
    const alpha=AtriumPCBAppearance.layerAlpha("Bottom");
    try {
      AtriumPCBAppearance.setLayerOpacity("Bottom",.5);
      L(st.scene,"Bottom"); L(st.scene,"Top");
      const show=(hidden)=>paint(st,items,0,true,1.25,6,hidden,true);
      const render=()=>{reads.length=0;show();return Array.from(st.text.bands,b=>b.tex);};
      const initial=render();
      assert.ok(view.internals().cache.lod.info.has(track),"the Bottom copper uses the real batched path");
      assert.deepEqual(Array.from(st.text.exact),["Bottom"]);
      assert.equal(initial.length,2);
      assert.deepEqual(reads[0],[0,0,W,H],"the ordered LOD band still uploads its full backing");
      assert.ok(reads.length===2 && reads[1][2]*reads[1][3]<W*H/4,
        "a separate glyph band remains tightly bounded under ordered copper LOD");
      assert.ok(initial[0].some(Boolean) && initial[1].some(Boolean),"both real layers produce ink");
      const original=initial[1].slice();
      U.reset(project);
      U.checkpoint(history,future,U.mark(project),"Move Silk label");
      silk.x=4; U.record(project,{doc,items:[silk]}); st.scene.rev++; st.scene.textRev++;
      const moved=render()[1];
      assert.ok(moved.some(Boolean) && moved.some((v,i)=>v!==original[i]),"the edit paints at the new position");
      assert.ok(original.some((v,i)=>v && !moved[i]),"the old ink is cleared");
      U.jump(history,future,U.mark(project),-1); st.scene.rev++; st.scene.textRev++;
      assert.deepEqual(render()[1],original,"Undo restores all original glyph pixels and clears the edited location");
      const band=st.text.bands[1];
      band.tex[0]=1; band.inkRect=undefined;
      silk.x=-4.1; st.scene.rev++; st.scene.textRev++;
      assert.equal(render()[1][0],0,"unknown prior contents are cleared");
      assert.deepEqual(reads[1],[0,0,W,H],"unknown prior ink still requires a complete transfer");
      show(new Set(["Silk"]));
      assert.ok(!st.text.bands[1]?.tex?.some(Boolean),"the hidden label no longer contributes pixels");
      assert.ok(st.text.bands[0].tex.some(Boolean),"the ordered layer remains visible");

      const recording=state(), recorded=[], clipped=[];
      L(recording.scene,"Bottom"); L(recording.scene,"Top");
      reads.length=0;
      paint(recording,items,0,true,1.25,6,undefined,true,{
        recordLayer:layer=>recorded.push(layer), clipLayer:layer=>{clipped.push(layer); return null;}
      });
      assert.equal(recorded.filter(layer=>layer==="Bottom").length,2,"custom record hooks retain the original LOD visits");
      assert.deepEqual(clipped,recorded.filter(Boolean),"custom clipping hooks see those same visits");
      assert.deepEqual(reads,[[0,0,W,H],[0,0,W,H]],"custom hooks retain the conservative LOD upload");
    } finally {
      view.internals().lodForce=undefined;
      AtriumPCBAppearance.setLayerOpacity("Bottom",alpha);
      U.reset();
    }
  }
  console.log("WebKit text crops preserve old/new glyph pixels and fall back for native captions and mixed label/path records");
}

{
  const angle = 33, location = [20,11], disk = [3,-2], pad = [2,4], ellipse = [4,-6];
  const polygon = [[-.7,-.4],[.9,-.4],[.1,.65]], padAngle = 26;
  const arc = {kind:"arc",c:[-2,7],r:1.1,start:15,end:100,ccw:true};
  const detail = t => {
    const a = t*Math.PI/180;
    return [arc.c[0]+arc.r*Math.cos(a),arc.c[1]-arc.r*Math.sin(a)];
  };
  const rotate = ([x,y],a) => [x*Math.cos(a)-y*Math.sin(a), x*Math.sin(a)+y*Math.cos(a)];
  const worldAt = ([x,y],mirror) => rotate([mirror?-x:x,y],angle*Math.PI/180).map((v,i)=>v+location[i]);
  const padVertex = p => rotate(p,padAngle*Math.PI/180).map((v,i)=>v+pad[i]);
  const round = p => Array.from(p,n=>Math.round(n*1e4)/1e4);
  const equalPoint = (a,b) => a && b && Math.hypot(a[0]-b[0],a[1]-b[1]) < .00008;
  for (const [layer, mirror] of [["Bottom",true],["Top",true],["Bottom",false]]) {
    const part={id:"pose",kind:"part",def:"pose-lib",ref:"",value:"",layer,x:location[0],y:location[1],angle,mirror};
    const points = [detail(15),detail(100)];
    const def={id:part.def,name:"Asymmetric pad footprint",footprint:{shapes:[
      {kind:"circle",layer,x:disk[0],y:disk[1],r:1,fill:true},
      {kind:"path",layer,points,arc,width:.13}
    ],pads:[
      {number:"1",layer,x:pad[0],y:pad[1],angle:padAngle,w:1.8,h:1.1,drill:0,shape:"custom",poly:polygon},
      {number:"2",layer,x:ellipse[0],y:ellipse[1],angle:padAngle,w:1.7,h:.8,drill:0,shape:"ellipse"}
    ]}};
    const project=Atrium.project("Raw reflected footprint",[def]), board=project.documents.find(d=>d.kind==="pcb");
    board.items=[part]; board.outline=[[10,0],[32,0],[32,23],[10,23]];
    const defs=new Map([[def.id,def]]);
    const diskAt=worldAt(disk,mirror), ellipseAt=worldAt(ellipse,mirror);
    const padPolygon=polygon.map(p=>round(worldAt(padVertex(p),mirror))).sort();
    const [arcStart,arcEnd]=points.map(world=>worldAt(world,mirror));
    const sceneInput={doc:board,defs,rev:1,all:board.items,byId:new Map([[part.id,part]])};
    const state={stats:{},parked:new Map(),gl:{}};
    delete sandbox.AtriumNavHost.boardGeometry;
    const scene=gpu.update(state,sceneInput,layer), buffers=scene.layers.get(layer);
    const vertices=({f,stride,n})=>Array.from({length:n},(_,i)=>Array.from(f.subarray(i*stride,(i+1)*stride)));
    const triangle=vertices(buffers.ptri).map(p=>round(p.slice(0,2))).sort();
    assert.deepEqual(triangle,padPolygon,"GPU custom land has the physical handedness and local pad rotation");
    const blobs=vertices(buffers.pblob);
    assert.ok(blobs.some(p=>equalPoint(p,diskAt)),"GPU emits the physical disk center");
    const ellipseBlob=blobs.find(p=>equalPoint(p,ellipseAt));
    assert.ok(ellipseBlob,"GPU emits the physical ellipse center");
    assert.ok(Math.abs(ellipseBlob[4]-(angle+(mirror?-padAngle:padAngle))*Math.PI/180)<1e-6,"GPU ellipse uses the reflected local rotation");
    assert.ok(vertices(buffers.pseg).some(p=>equalPoint(p,arcStart)&&equalPoint(p.slice(2),arcEnd)),"GPU poses the authored arc samples");
    for(let camera=0;camera<5;camera++)assert.equal(gpu.update(state,sceneInput,layer),scene,"camera-only work reuses GPU pose buffers");

    const readPath = (view,commands) => {
      const points=[], curve=[];
      for(let i=0;i<commands.length;){
        const op=commands[i++], n=op===2?6:op===3?0:2;
        if(n){const p=view.screenToWorld(commands.slice(i+n-2,i+n));points.push(p);if(op===2)curve.push(p);}
        i+=n;
      }
      return {points,curve};
    };
    for(const batch of [false,true]) for(const flipped of [false,true]){
      const rec=AtriumPDF.recorder(500,390), view=AtriumCanvas.create(rec.canvas);
      const ctx=rec.canvas.getContext("2d"), captions=[];
      const fillText=ctx.fillText.bind(ctx);
      ctx.fillText=(text,...args)=>{
        if(text==="1" || text==="2")captions.push(ctx.getTransform());
        fillText(text,...args);
      };
      view.restoreCamera({cx:20,cy:11,scale:12,referenceScale:12,flipped});
      view.internals().lodForce=batch;
      const opts={layer,layerMode:"single",flipped,grid:false,origin:false,showUnrouted:false,noReuse:true,
        recordLayer:name=>rec.setLayer(name?{id:name,name}:null)};
      view.render(board,defs,opts);
      if(batch)assert.ok(view.internals().cache.lod.info.has(part),"raw mirrored art remains batchable");
      const paths=rec.list.filter(op=>op.k==="p"&&op.layer?.name===layer)
        .map(op=>({...readPath(view,op.d),fill:op.fill}));
      const center=({curve})=>curve[0]?.map((v,i)=>(v+curve[2][i])/2);
      assert.ok(paths.some(p=>p.fill&&p.curve.length===4&&equalPoint(center(p),diskAt)),"Canvas paints the physical circle");
      assert.ok(paths.some(p=>p.fill&&p.curve.length===4&&equalPoint(center(p),ellipseAt)),"Canvas paints the physical ellipse");
      assert.ok(paths.some(p=>p.fill&&padPolygon.every(v=>p.points.some(w=>equalPoint(v,w)))),"Canvas paints the asymmetric land vertices");
      assert.ok(paths.some(p=>!p.fill&&p.curve.length&&equalPoint(p.points[0],arcStart)&&equalPoint(p.points.at(-1),arcEnd)),"Canvas keeps the exact posed arc");
      assert.equal(view.hit(board,defs,diskAt,opts),part,"Canvas picking uses the painted disk");
      if(mirror)assert.equal(view.hit(board,defs,worldAt(disk,false),opts),null,"the unreflected disk position is empty");
      if(!batch){
        view.restoreCamera({cx:20,cy:11,scale:20,referenceScale:20,flipped});
        view.render(board,defs,opts);
        assert.equal(captions.length,2);
        assert.ok(captions.every(({a,b,c,d})=>a>0&&d>0&&Math.abs(b)+Math.abs(c)<1e-9),"pad captions stay upright with either footprint or view reflection");
      }
    }
  }
  console.log("Footprint disk, arc, asymmetric land and ellipse align on raw, batched and GPU paths from either side");
}

{
  const layer="Bottom silk", angle=33, [x,y]=[4,2], a=angle*Math.PI/180;
  const text={kind:"text",text:"F",layer,x,y,size:1.4,angle:17,mirrored:false};
  const lib={id:"text",footprint:{shapes:[text],pads:[]}}, defs=new Map([[lib.id,lib]]);
  const part={id:"A",kind:"part",def:lib.id,x:12,y:10,angle,mirror:true,layer:"Bottom"};
  const label={...text,id:"F",kind:"label",x:part.x-x*Math.cos(a)-y*Math.sin(a),y:part.y-x*Math.sin(a)+y*Math.cos(a),angle:50};
  function strokes(item,flipped) {
    const doc=Atrium.sheet("pcb","Footprint text pose");
    doc.items=[item];
    const rec=AtriumPDF.recorder(400,300), view=AtriumCanvas.create(rec.canvas);
    view.restoreCamera({cx:10,cy:9,scale:26,referenceScale:26,flipped});
    view.render(doc,defs,{layer,layerMode:"single",grid:false,origin:false,showUnrouted:false,noReuse:true,
      recordLayer:name=>rec.setLayer(name?{id:name,name}:null)});
    return rec.list.filter(op=>op.k==="p"&&op.layer?.name===layer).map(op=>op.d.map(n=>Math.round(n*1e5)/1e5));
  }
  for(const flipped of [false,true]){
    const expected=strokes(label,flipped);
    assert.ok(expected.length,"the direct glyph was painted");
    assert.deepEqual(strokes(part,flipped),expected,"footprint reflects the text anchor and keeps its authored glyph orientation");
  }
}

{
  const strips = AtriumCanvas.create(AtriumPDF.recorder(100, 80).canvas).internals().exposedPanStrips;
  const fresh = (W, H, cx, cy) => {
    const rw = Math.max(0, Math.min(W, W + cx) - Math.max(0, cx));
    const rh = Math.max(0, Math.min(H, H + cy) - Math.max(0, cy));
    return W * H - rw * rh;
  };
  const cover = (rects, dpr) => {
    const W = 100 * dpr, H = 80 * dpr, grid = new Uint8Array(W * H);
    let n = 0;
    for (const [x0, y0, x1, y1] of rects) {
      for (let y = y0 * dpr; y < y1 * dpr; y++) for (let x = x0 * dpr; x < x1 * dpr; x++) {
        assert.equal(grid[y * W + x], 0, "pan strips overlap");
        assert.ok(x >= 0 && y >= 0 && x < W && y < H, "pan strip leaves the viewport");
        grid[y * W + x] = 1;
        n++;
      }
    }
    return n;
  };
  for (const dpr of [1, 2]) for (const [dx, dy] of [[1, -1], [1, 1], [-1, 1], [-1, -1], [3, -5], [3, 5], [-3, 5], [-3, -5], [4, -6], [-4, 6]]) {
    assert.equal(cover(strips(100, 80, dx / dpr, dy / dpr), dpr), fresh(100 * dpr, 80 * dpr, dx, dy));
  }
  const band = strips(200, 160, -3, 5).map(([x0, y0, x1, y1]) => [1000 + x0, -40 + y0, x1 - x0, y1 - y0]);
  assert.ok(band.some(([x, , w]) => x + w > 200), "unwrapped device strips stay outside the texture origin");
  console.log("Diagonal pan strips match a fresh repaint at DPR 1 and 2");
}

{
  const W=192,H=128, made=[], uploads=[], view=AtriumCanvas.create(AtriumPDF.recorder(W,H).canvas);
  view.resized({width:W,height:H});
  const I=view.internals(), opts={layer:"Top"}, defs=new Map(), label={kind:"label"};
  I.query=()=>[label];
  const live=()=>made.filter(c=>c.width>1 || c.height>1);
  const area=()=>live().reduce((n,c)=>n+c.width*c.height,0);
  let peak=0, deleted=0, time=0, resizes=0;
  const webKit=vm.createContext({AtriumPCBAppearance,AtriumCanvas,navigator:{userAgent:"AppleWebKit"},performance:{now:()=>time},
    setTimeout:()=>1,clearTimeout(){},requestAnimationFrame:()=>2,cancelAnimationFrame(){},
    document:{createElement(){
      const {ctx}=AtriumPDF.recorder(1,1);
      let width=1,height=1;
      const c={
        get width(){return width;}, set width(w){width=w;resizes++;peak=Math.max(peak,area());},
        get height(){return height;}, set height(h){height=h;resizes++;peak=Math.max(peak,area());},
        getContext:()=>ctx
      };
      ctx.getImageData=(x,y,w,h)=>{
        assert.ok(x===0 && y===0 && w<=c.width && h<=c.height,"readback fits its strip backing");
        return {w,h};
      };
      made.push(c);
      return c;
    }}
  });
  vm.runInContext(gpuCode.replace(sceneExport,"{scrollText, afterMove, freeViewport, place, listen, views, render, damage, stats,"),webKit);
  const {scrollText,afterMove,freeViewport,place,listen,views}=webKit.AtriumCanvasGPU;
  const gl={RGBA:1,bindTexture(){},pixelStorei(){},deleteTexture(){deleted++;},
    texSubImage2D(_,level,x,bottom,w,h,format,type,ink){
      assert.deepEqual([ink.w,ink.h],[w,h],"the painted strip is uploaded");
      uploads.push([x,bottom,w,h]);
    }};
  const T={w:W,h:H,valid:[0,0],bands:[{tex:{}}],strip:{
    need:[Infinity],cam:I.cam(),paintBand(ctx,next,items,all,details,entries,box,painted){painted(label);}
  }};
  const state={gl,canvas:I.canvas,text:T,stats:{textUpload:0,acc:{text:0}},scene:{cache:{boxes:new Map()}}};
  const pan=(x,y)=>assert.ok(scrollText(I,state,board,defs,opts,T,x,y));
  pan(7,-4); pan(-9,8);
  assert.ok(uploads.some(([, , w,h])=>w>h) && uploads.some(([, , w,h])=>h>w),"the pan uploads both strip orientations");
  assert.ok(peak<=W*H/4,"two thin crossing strips never hold a viewport-sized backing");
  const count=uploads.length;
  pan(-9,8);
  assert.equal(uploads.length,count,"the same pose does not repaint its strips");

  pan(W,H);
  assert.deepEqual(uploads.at(-1),[0,0,W,H],"a viewport-length jump repaints the entire texture");
  assert.equal(area(),W*H,"the large fallback releases both thin backings first");
  assert.equal(peak,W*H,"the large fallback never coexists with the thin backings");
  const broad=live()[0];
  afterMove(I,state,board,defs,opts,null,false,true);
  pan(W+3,H-4);
  assert.deepEqual(live(),[broad],"one backing covers continued pan after a large jump");
  afterMove(I,state,board,defs,opts,null,true,false);
  assert.ok(state.textJob,"normal settle queues exact text");
  assert.equal(area(),0,"settling releases the large backing before exact text");
  pan(W+6,H-7);
  assert.ok(area()>0,"a later pan reacquires scratch");
  freeViewport(state);
  assert.equal(area(),0,"viewport teardown releases the remaining pan scratch");
  assert.equal(deleted,1,"viewport teardown deletes the retained texture");

  T.valid=[0,0]; state.text=T;
  pan(W,H);
  const full=state.stripLarge, initial=made.length;
  let x=W,y=H;
  // Genuine large jumps interspersed with thin frames keep the same canvas.
  for(let n=0;n<24;n++){
    time+=16; x+=n%2 ? W : 3; y-=n%2 ? 0 : 4;
    pan(x,y);
    afterMove(I,state,board,defs,opts,null,false,true);
    assert.equal(state.stripLarge,full);
  }
  assert.equal(made.length,initial,"alternating rapid pans reuse one large surface");
  // Every camera frame continues to rearm settle; only strip demand turns thin.
  for(let n=0;n<15;n++){
    time+=16; x+=3; y-=4;
    pan(x,y);
    afterMove(I,state,board,defs,opts,null,false,true);
    assert.equal(state.stripLarge,full,"short gaps in large demand reuse the surface");
  }
  time+=16; x+=3; y-=4;
  pan(x,y);
  afterMove(I,state,board,defs,opts,null,false,true);
  assert.ok(state.idle && !state.settling,"the continuous pan has not settled");
  assert.equal(state.stripLarge,null,"sustained thin motion releases the broad backing");
  assert.deepEqual([full.width,full.height],[1,1],"release gives the backing store back");
  assert.ok(area()>0 && area()<=W*H/4,"only thin strip backing remains");
  const thinResizes=resizes;
  for(let n=0;n<20;n++){
    time+=16; x+=3; y-=4;
    pan(x,y);
  }
  assert.equal(resizes,thinResizes,"wrapped strips do not grow the thin long axes a few pixels at a time");
  assert.equal(made.length,initial+2,"the rest of the thin motion only reuses its two canvases");
  time+=16; x+=W;
  pan(x,y);
  assert.ok(state.stripLarge && !state.stripWide && !state.stripTall,"a later jump releases thin backings before regrowth");
  assert.equal(made.length,initial+3);
  const events=new Map();
  state.canvas={width:W+32,height:H+32,style:{},addEventListener:(name,run)=>events.set(name,run)};
  state.place=(W+32)+"x"+(H+32)+"/"+W+"x"+H;
  state.overlayCopy={width:W,height:H}; state.ovAt=[x,y];
  gl.drawingBufferWidth=state.canvas.width; gl.drawingBufferHeight=state.canvas.height;
  I.canvas.width=W+1; I.canvas.height=H; I.canvas.style={};
  const retained=state.stripLarge;
  assert.ok(place(I,state,W+1,H,true),"the resized view draws inside its retained backing");
  assert.deepEqual([state.canvas.width,state.canvas.height],[W+32,H+32],"the resize reuses the larger framebuffer");
  assert.equal(state.stripLarge,retained,"viewport placement retains the pan scratch");
  assert.equal(state.overlayCopy,null,"the changed view size releases the copied top layer");
  assert.equal(state.ovAt,null);
  afterMove(I,state,board,defs,opts,null,true,false);
  assert.equal(area(),0,"the exact text pass releases the large pan backing");
  T.valid=[0,0]; state.text=T; pan(W,H);
  views.set(I,state);
  listen(I,state);
  let prevented=false;
  events.get("webglcontextlost")({preventDefault(){prevented=true;}});
  assert.ok(prevented && state.lost && !state.idle);
  assert.equal(area(),0,"context loss cancels the gesture and releases its large backing");
  console.log("GPU pan scratch stays bounded during alternating jumps and releases its broad backing during continuous thin motion");
}

{
  // Simulate physical texture writes and check every texel against the unwrapped
  // artwork. Test both a measured ink bound and a texture with unknown contents.
  for (const dpr of [1, 2]) for (const known of [true, false]) {
    const W = 24*dpr, H = 18*dpr, uploads = [];
    const view = AtriumCanvas.create(AtriumPDF.recorder(24,18).canvas);
    view.resized({width:24,height:18});
    view.setFlipped(dpr === 2);
    const I = view.internals(), cam = I.cam(), origin = I.worldToScreen([0,0]);
    cam[6] = dpr;
    const label = {kind:"label"};
    I.query = () => [label];
    function ink(x,y) {
      x /= dpr; y /= dpr;
      return x >= 8 && x < 15 && y >= 3 && y < 10 ||
             x >= 38 && x < 46 && y >= 1 && y < 9 ||
             x >= -5 && x < -1 && y >= -9 && y < 4;
    }
    const texels = new Uint8Array(W*H);
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) texels[y*W+x] = ink(x,y) ? 255 : 0;
    const sandbox = vm.createContext({AtriumPCBAppearance,AtriumCanvas,
      navigator:{userAgent:dpr === 1 ? "AppleWebKit" : "Chrome/140"},
      document:{createElement(){
        let top, left, width, height, data;
        const ctx = {
          globalAlpha:1, save(){},restore(){},beginPath(){},rect(){},clip(){},
          setTransform(a,b,c,d,e,f) { left = Math.round(dpr*origin[0]-e); top = Math.round(dpr*origin[1]-f); },
          clearRect(x,y,w,h) { width=w; height=h; data=new Uint8Array(w*h*4); },
          getImageData() { return {data}; },
          paint(painted) {
            let drawn=false;
            for (let y=0;y<height;y++) for (let x=0;x<width;x++) if (ink(left+x,top+y)) {
              data[(y*width+x)*4+3] = 255;
              drawn=true;
            }
            if (drawn) painted(label);
          }
        };
        return {width:1,height:1,getContext:()=>ctx};
      }}
    });
    vm.runInContext(gpuCode.replace(sceneExport,"{scrollText, render, damage, stats,"),sandbox);
    const gl = {RGBA:1,bindTexture(){},pixelStorei(){},
      texSubImage2D(target,level,x,bottom,w,h,format,type,source) {
        const y=H-bottom-h, data=source.data;
        assert.ok(x>=0 && y>=0 && x+w<=W && y+h<=H);
        assert.ok(data || source.length>=w*h*4,"every clear has enough zero texels");
        uploads.push([x,y,w,h,!!data]);
        for (let j=0;j<h;j++) for (let k=0;k<w;k++) texels[(y+j)*W+x+k]=data?.[(j*w+k)*4+3] || 0;
      }};
    const T = {w:W,h:H,valid:[0,0],bands:[{tex:{},inkRect:known?[8*dpr,3*dpr,15*dpr,10*dpr]:undefined}],
      strip:{need:[Infinity],cam,paintBand(g,next,items,found,details,filter,box,painted){g.paint(painted);}}};
    const state={gl,stats:{textUpload:0,acc:{text:0}},scene:{cache:{boxes:new Map()}}};
    const mod = (v,n)=>(v%n+n)%n;
    function pan(x,y) {
      uploads.length=0;
      const before=state.stats.textUpload;
      const nx=x*dpr, ny=y*dpr;
      assert.ok(sandbox.AtriumCanvasGPU.scrollText(I,state,board,new Map(),{layer:"Top"},T,-nx,-ny));
      for (let j=0;j<H;j++) for(let k=0;k<W;k++)
        assert.equal(texels[mod(ny+j,H)*W+mod(nx+k,W)],ink(nx+k,ny+j)?255:0,
          `physical texture matches authored pixels at DPR ${dpr}, ${x}/${y}, pixel ${k}/${j}`);
      assert.equal(state.stats.textUpload-before,uploads.reduce((n,[,,w,h])=>n+w*h*4,0));
      return uploads.slice();
    }
    const empty = pan(4,0);
    assert.deepEqual(empty,known?[]:[[0,0,4*dpr,H,false]],
      "skip only where a known bound excludes old ink");
    const clears = pan(12,0);
    assert.deepEqual(clears,known?[[8*dpr,3*dpr,4*dpr,7*dpr,false]]:[[4*dpr,0,8*dpr,H,false]],
      "a real clear covers the old wrapped ink, and clips to the known possible ink");
    assert.ok(pan(9,0).some(a=>a[4]),"reverse direction restores ink outside the shortened bound");
    assert.ok(pan(12,0).some(a=>!a[4]),"leaving that ink again still clears it");
    for (const [x,y] of [[17,4],[14,-6],[-5,-11],[36,24],[0,0]]) pan(x,y);
  }
  console.log("GPU pan zero uploads preserve ink, cropped clears, diagonal wrap and re-entry at DPR 1 and 2");
}

{
  // Drive the real memory accounting and probe scheduler on a 120 Hz clock.
  let time = 0, sequence = 0, paused = false, onPower, state, status, sync = true, invalid = false, createSync = true;
  const tasks = new Map(), live = new Set(), submitted = [], queries = [];
  let waits = 0, flushes = 0, wakeups = 0;
  const schedule = (run, delay) => { tasks.set(++sequence, {at:time + delay, run}); return sequence; };
  const cancel = id => tasks.delete(id);
  function tick(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...tasks].sort((a,b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      tasks.delete(next[0]); time = next[1].at; wakeups++;
      next[1].run();
    }
    time = end;
  }
  const screen = {width:360,height:260,style:{},isConnected:true}, listeners = new Map();
  const input = {canvas:screen,cache:{doc:board},repaint() {}};
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE:1, ALREADY_SIGNALED:2, CONDITION_SATISFIED:3, TIMEOUT_EXPIRED:4, WAIT_FAILED:5,
    NO_ERROR:0, INVALID_OPERATION:6, OUT_OF_MEMORY:7, CONTEXT_LOST_WEBGL:8,
    isContextLost:() => state.lost,
    fenceSync() {
      if (!createSync) return null;
      const fence = {command:state.commandEpoch, memory:state.driverMemoryEpoch};
      submitted.push(fence); live.add(fence);
      assert.equal(live.size,1,"one fence at a time");
      return fence;
    },
    flush() { flushes++; },
    deleteSync(fence) { assert.ok(live.delete(fence),"each fence is deleted exactly once"); },
    clientWaitSync(fence, flags, timeout) {
      assert.ok(live.has(fence)); assert.equal(flags,0); assert.equal(timeout,0);
      waits++;
      if (!sync) return this.TIMEOUT_EXPIRED;
      if (invalid) return this.WAIT_FAILED;
      status = fence;
      return this.CONDITION_SATISFIED;
    },
    getError() {
      queries.push({command:state.commandEpoch, fence:status?.command, memory:state.driverMemoryEpoch, covered:status?.memory});
      return errors.shift() ?? this.NO_ERROR;
    }
  };
  const errors = [], env = {
    AtriumPCBAppearance, performance:{now:() => time}, setTimeout:schedule, clearTimeout:cancel,
    requestAnimationFrame:callback => schedule(callback,8), cancelAnimationFrame:cancel,
    AtriumCanvas:{resizeBacking(canvas,width,height) { Object.assign(canvas,{width,height}); }},
    AtriumCanvasGPUPref:{decision:() => ({use:true})},
    AtriumPower:{visible:() => !paused,onChange(callback) { onPower = callback; }},
    AtriumIdle:{idle(callback) { return schedule(() => callback({didTimeout:false}),1); }, cancel,
      sampleFrame(callback) { return schedule(callback,8); }, cancelSample:cancel}
  };
  const vmMemory = vm.createContext(env);
  vm.runInContext(gpuCode.replace(sceneExport,
    "{render, damage, stats, views, memory, queueDriverMemoryProbe, listen,"),vmMemory);
  const memoryGPU = vmMemory.AtriumCanvasGPU;
  function newState() {
    state = {shown:true,lost:false,losses:0,checkMemory:false,driverMemoryEpoch:0,commandEpoch:0,
      canvas:{width:360,height:260,style:{},addEventListener(name,handler) { listeners.set(name,handler); }},
      gl, parked:new Map(), pours:new Map(), stats:{pourBytes:0,driverMemoryChecks:0,driverMemoryCheckMs:0,driverFenceSubmissions:0}};
    memoryGPU.views.set(input,state);
    memoryGPU.listen(input,state);
  }
  function paint(allocation = false) {
    state.commandEpoch++;
    if (allocation) { state.checkMemory = true; memoryGPU.memory(input,state,board); }
    memoryGPU.queueDriverMemoryProbe(input,state,board);
  }

  newState();
  const coldBand = {}, freedBands = [];
  gl.deleteTexture = tex => freedBands.push(tex);
  state.text = {key:"empty",empty:true,w:360,h:260,bands:[{tex:coldBand}]};
  state.checkMemory = true;
  vmMemory.__atriumGpuCapMB = .5;
  assert.ok(memoryGPU.memory(input,state,board),"a camera with no artwork gives up its warm texture before GPU fallback");
  assert.deepEqual(freedBands,[coldBand]);
  assert.equal(state.over,undefined);
  delete vmMemory.__atriumGpuCapMB;

  newState();
  sync = false;
  paint(true); tick(40);
  assert.equal(submitted.length,1,"the initial allocation submits a fence");
  const early = waits;
  for (let frame=0;frame<24;frame++) { paint(frame===12); tick(8); }
  assert.deepEqual([submitted.length,flushes,queries.length],[1,1,0],"uninterrupted camera draws and a newer allocation retain the in-flight fence");
  assert.ok(waits-early<=7,"a stale in-flight fence backs off during continuous drawing");
  sync = true;
  for (let frame=0;frame<24;frame++) { paint(); tick(8); }
  assert.deepEqual([submitted.length,queries.length],[1,0],"busy frames neither replace the fence nor read stale errors");
  for (let frame=0;frame<4;frame++) { paint(); tick(80); }
  assert.deepEqual([submitted.length,queries.length,state.stats.driverMemoryChecks],[2,1,1],"ongoing input with gaps checks the later allocation");
  assert.equal(queries[0].memory,2);
  assert.equal(state.stats.driverFenceSubmissions,2);
  const settled = wakeups;
  tick(200); assert.equal(wakeups,settled,"healthy completed checks stop the scheduler");

  paint(true); sync = false; tick(40);
  assert.equal(live.size,1);
  paused = true; onPower({visible:false});
  const hidden = [submitted.length,queries.length,wakeups];
  tick(160);
  assert.equal(live.size,0);
  assert.deepEqual([submitted.length,queries.length,wakeups],hidden,"hidden views do no probe work");
  paused = false; onPower({visible:true});
  sync = true; errors.push(gl.INVALID_OPERATION,gl.OUT_OF_MEMORY);
  for (let frame=0;frame<4;frame++) { paint(); tick(80); }
  assert.equal(state.over?.reason,"the GPU ran out of memory");
  assert.equal(state.stats.driverMemoryChecks,2,"uncovering checks the pending allocation and drains both errors");
  assert.equal(queries.length,3);
  for (const q of queries) assert.deepEqual([q.command,q.memory],[q.fence,q.covered],"getError never waits for a later draw or allocation");
  const finished = wakeups;
  tick(200); assert.equal(wakeups,finished,"finished checks do not wake the idle scheduler");

  newState(); sync = false; paint(true); tick(40);
  listeners.get("webglcontextlost")({preventDefault() {}});
  assert.equal(live.size,0);
  const lost = [queries.length,wakeups];
  tick(200); assert.deepEqual([queries.length,wakeups],lost,"context loss cancels the pending fence and callbacks");
  listeners.get("webglcontextrestored")();
  assert.equal(state.restoring,true);
  newState(); sync = true; paint(true); tick(80);
  assert.equal(state.stats.driverMemoryChecks,1,"the replacement context checks its own allocations");

  newState();
  paint(true); tick(34);
  state.checkMemory = true; state.commandEpoch++; state.textJob = {};
  tick(64);
  assert.equal(state.stats.driverMemoryChecks,0,"a partial texture slice blocks the old fence from authorizing getError");
  state.textJob = null; tick(128);
  assert.equal(state.stats.driverMemoryChecks,1,"a cancelled slice still accounts for submitted allocations");
  assert.equal(queries.at(-1).memory,2);
  assert.deepEqual([queries.at(-1).command,queries.at(-1).memory],[queries.at(-1).fence,queries.at(-1).covered]);

  invalid = true;
  paint(true); tick(80);
  assert.equal(state.over?.reason,"the GPU could not complete its memory check");
  assert.equal(state.stats.driverMemoryChecks,1,"a failed fence never authorizes getError");

  newState(); createSync = false; paint(true); tick(80);
  assert.equal(state.over?.reason,"the GPU could not complete its memory check");
  assert.equal(state.stats.driverMemoryChecks,0,"a missing fence never authorizes getError");

  newState(); vmMemory.__atriumGpuCapMB = .000001;
  paint(true);
  assert.match(state.over?.reason,/GPU memory \(limit/,"the estimated cap rejects synchronously");
  assert.equal(tasks.size,0);
  assert.equal(flushes,submitted.length);
  console.log("GPU memory fences coalesce busy draws, wait for current work, and cancel on hide or context loss");
}

for (const [hz, posted] of [[60,false],[120,false],[60,true],[120,true]]) {
  // Run production textSlices on a virtual display clock with deterministic raster costs.
  // Replace the raster leaves with a per-row witness so the scheduling test needs no WebGL driver.
  const period = 1000 / hz, tasks = new Map(), perFrame = new Map(), order = [], worked = [];
  let running, displayDelay=0, messageDelay=.25, channels=0, staleMessage, clockReads=0;
  const scratch = [], drawn = [], shownOverlays = [];
  let time = 0, next = 0, hidden = false, efficient = false, backingSizes = 0, fullBackings = 0, onPower;
  function task(run, at, kind, depth = 0) {
    tasks.set(++next, {run, at, kind, depth, exact:0, wide:0, fromDisplay:running?.kind==="display"});
    return next;
  }
  function runNext() {
    const [id, job] = [...tasks].sort((a,b) => a[1].at - b[1].at)[0];
    tasks.delete(id);
    time = Math.max(time, job.at);
    const started=time;
    running=job;
    try { job.run(); }
    finally {
      if(job.exact || job.wide)worked.push({exact:job.exact,wide:job.wide,ms:time-started,fromDisplay:job.fromDisplay});
      running=null;
    }
  }
  function drain() {
    for (let i = 0; tasks.size; i++) {
      assert.ok(i < 100, "text slices settle and stop scheduling refreshes");
      runNext();
    }
  }
  function work(I, ms) {
    const frame = Math.floor(time / period + .00001);
    if(I.wide || !posted)perFrame.set(frame, (perFrame.get(frame) || 0) + ms);
    running[I.wide?"wide":"exact"]++;
    time += ms;
    order.push(I.name);
  }
  const fixture = {
    AtriumPCBAppearance, performance:{now() { clockReads++; return time; }},
    AtriumCanvasGPUPref:{decision:() => ({use:true})},
    setTimeout(run,delay) {
      const depth=running?.kind==="timer" ? running.depth+1 : 0;
      return task(run,time+Math.max(depth>=5?4:.25,delay),"timer",depth);
    },
    clearTimeout:id => tasks.delete(id),
    MessageChannel:function() {
      channels++;
      const ids=new Set(), port1=this.port1={close() {
        if (!ids.closed) { ids.closed=true; channels--; }
        for(const id of ids)tasks.delete(id);
      }};
      this.port2={postMessage(data) {
        const receive=port1.onmessage;
        staleMessage=()=>receive({data});
        const id=task(()=>{ids.delete(id);receive({data});},time+messageDelay,"message");
        ids.add(id);
      },close(){}};
    },

    AtriumIdle:{sampleFrame:run => task(() => run(time), Math.max(time+displayDelay,period*(1+Math.floor(time/period+.00001))), "display"),
      cancelSample:id => tasks.delete(id)},
    AtriumPower:{visible:() => !hidden, efficient:() => efficient, onChange:run => { onPower = run; }},
    AtriumCanvas:{resizeBacking(c,w,h) {
      backingSizes++;
      if (c.width!==w || c.height!==h) fullBackings++;
      if (c.height>h) c.height=h;
      if (c.width!==w) c.width=w;
      if (c.height!==h) c.height=h;
    }},
    document:{createElement() {
      let width = 300;
      const c = {height:150, get width() { return width; }, set width(value) { width = value; c.ink = null; }};
      const ctx = {canvas:c, setTransform() {}, clearRect() { c.ink = null; }};
      c.getContext = () => ctx;
      scratch.push(c);
      return c;
    }},
    draw(_I, _st, _doc, _defs, _opts, _cam, _scene, text) { drawn.push(text); },
    scope(I, ...args) {
      if (I.scopeWitness) return I.scopeWitness(I, ...args);
      work(I, I.scopeWork ?? .75); I.onScope?.(); return {viewport:[0,0,4,4],o2:{}};
    },
    textLayer(I, st, doc, defs, opts, cam, V, pours, T, [, y, , h], timing) {
      if (!h) {
        T.key = "painted"; T.bands = [{tex:I.name}]; T.pixels = new Uint8Array(st.canvas.height);
        T.exact = new Set(["Top"]); T.pours = pours;
        T.canvas = I.ctx.canvas; T.ctx = I.ctx; T.strip = {paintBand: () => T.canvas};
      }
      else if (I.fail) throw new Error("raster failed");
      T.pixels.fill(1, y, y + h);
      if (h) { T.canvas = I.ctx.canvas; T.ctx = I.ctx; I.onRows?.(y,h); }
      const rowMs = h * (I.workPerRow ?? .125);
      st.stats.acc.board += rowMs / 2;
      if (timing) { timing.upload += rowMs / 4; timing.readback += rowMs / 8; }
      work(I, h ? rowMs : .75);
      return T;
    },
    pourCoverage:I => work(I, .75),
    copyCanvas(c, prior) { return Object.assign(prior || {}, {width:c.width,height:c.height,ink:c.ink}); }
  };
  if (!posted) delete fixture.MessageChannel;
  const sliceVM = vm.createContext(fixture);
  vm.runInContext(gpuCode.replace("  return Object.freeze(" + sceneExport,
    "  const realScope = scope; ({scope, textLayer, pourCoverage, copyCanvas, draw} = globalThis);\n" +
    "  const settleAfterMove = afterMove; place = memory = () => true; update = afterMove = queueDriverMemoryProbe = () => {};\n" +
    "  return Object.freeze({render, damage, stats, views, textSlices, wideLayers, scheduleWide, wideFits, freeWide, releaseCanvas, covers, settleAfterMove, realScope,"), sliceVM);
  const slices = sliceVM.AtriumCanvasGPU;
  function viewForSlices(name, wide = false, height = 80) {
    const cam = [0, 0, 1, false, 200, height, 1], canvas = {width:200,height,isConnected:true}, deleted = [];
    const ctx = {canvas, save() {}, restore() {}, setTransform() {}, drawImage(overlay) { shownOverlays.push(overlay); }};
    canvas.getContext = () => ctx;
    const I = {name, wide, canvas, ctx, cam:() => cam, cache:{doc:board,rev:1}, withCamera(x,y,s,fn) { fn(); },
      sync() { return this.cache; }, repaint() { this.repaints = (this.repaints || 0) + 1; },
      boardTransform() {}, paintTop() {}, drawBoard(ctx, parts) { ctx.canvas.ink = parts[0].id; this.onOverlay?.(); }};
    const st = {canvas, shown:true, strict:true, powerPreference:"low-power",
      scene:{rev:1,cache:{all:[{id:"selected",kind:"part"}]}}, commandEpoch:0, gl:{deleteTexture:tex => deleted.push(tex)},
      stats:{acc:{n:0,gesture:0,board:0}, textSliceRows:0, wideSliceRows:0, textSliceWorkMs:0, wideSliceWorkMs:0}};
    slices.views.set(I, st);
    const target = wide ? {getContext:() => ctx} : canvas;
    let completed;
    return {I, st, cam, deleted, get completed() { return completed; }, start() {
      slices.textSlices(I, st, board, new Map(), {}, [], wide ? "wideText" : "textJob", cam, target,
        T => { assert.ok(T.pixels.every(p => p === 1)); completed = time; });
    }};
  }

  const stageRows = [];
  sliceVM.AtriumDiagnostics = {performance:{rendererStages:true, rendererStageEpoch:1, renderStage(name, ms) { stageRows.push([name,ms]); }}};
  const wide = viewForSlices("wide", true), exact = viewForSlices("exact");
  wide.start(); exact.start();
  assert.equal(tasks.size, 1, "views subscribe to one display clock");
  drain();
  // Each 80-row paint costs 0.125 ms per row. Setup, waits and coverage have their own lifetimes.
  for (const stage of ["stationary-text-rows", "wide-text-rows"]) {
    const samples = stageRows.filter(([name]) => name === stage);
    assert.ok(samples.length > 1 && samples.every(([,ms]) => ms > 0));
    assert.equal(samples.reduce((sum,[,ms]) => sum + ms, 0), 10);
  }
  sliceVM.AtriumDiagnostics.performance.rendererStages = false;
  sliceVM.AtriumDiagnostics.performance.rendererStageEpoch = 0;
  sliceVM.AtriumDiagnostics.performance.renderStage = () => assert.fail("ordinary operation must skip detailed row recording");
  const peak = Math.max(...perFrame.values());
  const foreground=worked.filter(task=>task.exact);
  const maxTask=Math.max(...foreground.map(task=>task.ms));
  const deliveries=stageRows.filter(([name])=>name==="stationary-text-dispatch").map(([,ms])=>ms);
  assert.deepEqual(deliveries,posted?foreground.map(()=>.25):[],"record exactly one wait for each accepted posted step");
  if (!posted) {
    assert.ok(foreground.every(job=>job.fromDisplay),"when message tasks are unavailable, exact work starts on a display sample");
    assert.ok(peak <= (hz === 60 ? 8 : 5),"both queues then share the stock refresh budget");
    assert.equal(exact.st.stats.textSliceRows,80);
    assert.equal(exact.st.stats.textSliceWorkMs,12.25);
    assert.equal(wide.st.stats.wideSliceRows,80);
    console.log(`GPU text slices at ${hz} Hz without MessageChannel, exact ${exact.completed.toFixed(2)} ms, wide ${wide.completed.toFixed(2)} ms`);
    continue;
  }
  console.log(`GPU text slices at ${hz} Hz, exact ${exact.completed.toFixed(2)} ms, largest task ${maxTask.toFixed(2)} ms, wide ${wide.completed.toFixed(2)} ms`);
  assert.ok(foreground.every(task=>task.exact===1&&!task.wide),"every exact step yields before returning to another pane or job");
  assert.ok(maxTask <= 4,"the measured foreground row step stays bounded");
  assert.ok(peak <= (hz === 60 ? 8 : 5), "speculative wide retains its measured budget per refresh");
  assert.ok(worked.filter(job=>job.wide).every(job=>job.fromDisplay),"only a display sample can start wide work");
  assert.deepEqual(order.slice(0, 7), Array(7).fill("exact"), "exact-camera work gets priority");
  assert.ok(exact.completed < 17, "a foreground message task never inherits nested timer delays");
  assert.ok(wide.completed <= (hz === 60 ? 5 : 7) * period + 4, "all wide rows publish within their refresh limit");
  const e = slices.resourceCounters(exact.I), w = slices.resourceCounters(wide.I);
  assert.deepEqual([e.slicing, e.textSliceRows, e.textSliceWorkMs, e.wideSliceRows], [false, 80, 12.25, 0]);
  assert.deepEqual([w.slicing, w.wideSliceRows, w.wideSliceWorkMs, w.textSliceRows], [false, 80, 11.5, 0]);

  // A dense foreground job respects the clip height it measured before culling.
  function heights(name, wide, count, culled) {
    const fixture=viewForSlices(name,wide), rows=[];
    fixture.I.onRows=(y,h)=>{
      rows.push(h);
      fixture.I.workPerRow=y===0?1.25:.01;
      if(y>=16 && count) {
        const job=fixture.st[wide?"wideText":"textJob"];
        job.captionBoxes={culled,bounds:new Map(Array.from({length:count},(_,i)=>[i,null]))};
      }
    };
    fixture.start(); drain();
    return rows;
  }
  assert.deepEqual(heights("dense verified",false,64,true),[16,...Array(8).fill(8)],
    "a measured dense foreground job keeps its observed 8-pixel floor");
  for(const [name,wide,count,culled] of [
    ["sparse verified",false,8,true],["no witness",false,0,false],["unculled",false,64,false],
    ["speculative dense",true,64,true]
  ]) assert.ok(heights(name,wide,count,culled).slice(2).some(h=>h>8),
    name+" keeps the normal growth policy");

  if (hz === 60) {
    const checkpoint=time, f=viewForSlices("exact viewport publication"), {I,st,cam}=f, defs=new Map(), pours=[];
    const track={id:"route",kind:"track",x:0}, label={id:"legend",kind:"label",x:1}, far={id:"far",kind:"label",x:500};
    let queries=0, revision=1, items=[track,label,far];
    Object.assign(I.cache,{bounds:[-600,-50,600,50],all:items});
    st.scene.cache=I.cache; st.scene.layers=new Map(); st.scene.maxPad=0;
    I.scopeWitness=slices.realScope;
    I.query=(_doc,_defs,box)=>{queries++;return items.filter(item=>box[0]<=item.x&&item.x<=box[2]);};
    I.withCamera=(cx,cy,scale,run)=>{
      const previous=cam.slice(0,3);cam.splice(0,3,cx,cy,scale);
      try {return run();} finally {cam.splice(0,3,...previous);}
    };
    sliceVM.AtriumSpatial={};
    const visible=opts=>slices.realScope(I,st,board,defs,opts||{},cam,pours);
    const hidden={routePreview:{hidden:[track.id]}}, present=[];
    const job=(opts,target,at=cam.slice())=>{
      slices.textSlices(I,st,board,defs,opts,pours,target===I.canvas?"textJob":"wideText",at,target,
        (_text,V)=>present.push(Array.from(V.all, i=>i.id)));
    };
    job(hidden,I.canvas); drain();
    assert.deepEqual(present,[["legend"]],"sliced artwork filters its own preview items");
    assert.deepEqual(Array.from(visible().all,i=>i.id),["route","legend"],"raw cache keeps items needed by the subsequent exact draw");
    assert.equal(queries,1,"the exact draw reuses the ordered viewport built by the foreground slice");
    job({}, {getContext:I.canvas.getContext}, [500,0,1,false,200,80,1]); drain();
    assert.deepEqual(present.at(-1),["far"],"the speculative job still queries its own wide camera");
    assert.equal(queries,2);
    assert.deepEqual(visible(hidden).all.map(i=>i.id).join(","),"legend");
    assert.equal(queries,2,"the wide job cannot evict the exact camera viewport");
    items=[track,{...label,x:550},far];I.cache.rev=st.scene.rev=++revision;
    assert.deepEqual(Array.from(visible().all,i=>i.id),["route"],"an edit changes the viewport membership");
    items=[track,label,far];I.cache.rev=st.scene.rev=++revision;
    assert.deepEqual(Array.from(visible().all,i=>i.id),["route","legend"],"Undo uses a fresh ordered query");
    assert.equal(queries,4);
    cam[0]=500;
    job({},I.canvas);
    while(!st.textJob.V)runNext();
    cam[0]=0;drain();
    assert.deepEqual(Array.from(visible().all,i=>i.id),["route","legend"],"cancelled exact slices cannot substitute a different viewport");
    assert.equal(queries,6);
    assert.equal(present.length,2,"cancelled results never publish");
    assert.equal(tasks.size,0);
    slices.views.delete(I);
    delete sliceVM.AtriumSpatial;
    time=checkpoint;
  }

  // A new camera invalidates partial artwork, including its footprint on the GPU.
  exact.start(); runNext(); runNext();
  exact.cam[0]++; drain();
  assert.deepEqual(exact.deleted, ["exact"]);
  assert.equal(exact.I.repaints, 1);
  assert.equal(slices.resourceCounters(exact.I).slicing, false);

  // Hiding after the display callback but before the posted work cancels both kinds of job.
  exact.start(); wide.start(); runNext();
  hidden = true; onPower({visible:false});
  assert.equal(tasks.size, 0);
  assert.equal(slices.resourceCounters(exact.I).slicing, false);
  assert.equal(slices.resourceCounters(wide.I).slicing, false);

  hidden = false; onPower({visible:true});
  const failure = viewForSlices("failed");
  failure.I.fail = true;
  failure.start(); wide.start(); drain();
  assert.deepEqual(failure.deleted, ["failed"]);
  assert.equal(failure.completed, undefined);
  assert.equal(slices.resourceCounters(failure.I).slicing, false);
  assert.equal(slices.resourceCounters(wide.I).wideSliceRows, 160, "failure cannot strand other work");

  // A running step can cancel the last queued view, enqueue a new one, and cancel itself.
  const active = viewForSlices("cancelling"), pending = viewForSlices("superseded", true), fresh = viewForSlices("fresh");
  active.I.onScope = () => { slices.pause(pending.I); fresh.start(); slices.pause(active.I); };
  pending.start(); active.start(); runNext(); runNext();
  assert.equal(tasks.size, 1, "only one successor can be armed during the current refresh");
  drain();
  assert.equal(active.completed, undefined);
  assert.equal(pending.completed, undefined);
  assert.ok(fresh.completed > 0);
  assert.equal(tasks.size, 0, "reentrant cancellation cannot leave a display callback");

  active.I.onScope = () => slices.pause(active.I);
  active.start(); drain();
  assert.equal(tasks.size, 0, "cancelling the running job leaves no scheduled work");

  order.length=0;
  const left=viewForSlices("left"), right=viewForSlices("right");
  left.start();right.start();drain();
  assert.deepEqual(order.slice(0,8),["left","right","left","right","left","right","left","right"],
    "exact panes take turns even when the first one still has rows");
  assert.ok(left.completed > 0 && right.completed > 0);

  const interrupted=viewForSlices("interrupted");
  let paints=0;
  interrupted.I.onRows=()=>{
    paints++;
    if(paints===1)task(()=>interrupted.cam[0]++,time+.1,"input");
  };
  interrupted.start();drain();
  assert.equal(paints,1,"new input runs before the next stationary strip");
  assert.equal(interrupted.completed,undefined,"rows for the old camera are never published");
  assert.deepEqual(interrupted.deleted,["interrupted"]);
  assert.equal(interrupted.I.repaints,1);
  assert.equal(tasks.size,0);

  const abandoned=viewForSlices("old channel"), current=viewForSlices("new channel");
  abandoned.start();
  const late=staleMessage;
  slices.pause(abandoned.I);
  current.start();
  assert.equal(channels,1,"the superseded message channel closed");
  const workedBefore=worked.length;
  task(late,time,"message");runNext();
  assert.equal(worked.length,workedBefore,"a posted message from a cancelled channel cannot start the new job");
  drain();
  assert.ok(current.completed > 0);
  assert.equal(channels,0,"no channel remains when the exact queue drains");

  const held=viewForSlices("display held",true), heldExact=viewForSlices("ready");
  displayDelay=1000;
  const began=time;
  held.start(); heldExact.start();
  for(let steps=0;heldExact.completed===undefined;steps++){
    assert.ok(steps<10 && tasks.size,"the stationary camera completes while the display sample is held");
    runNext();
  }
  assert.ok(heldExact.completed-began<28);
  assert.equal(held.st.stats.wideSliceRows,0,"the speculative view still waits for display refresh");
  slices.pause(held.I);
  displayDelay=0;
  assert.equal(tasks.size,0,"completion and cancellation leave no idle callback");
  assert.equal(channels,0,"closed or completed jobs leave no message ports");
  if (hz !== 60) continue;
  {
    // A deterministic delivery delay stays separate from row work and stops at the recorder boundary.
    const source=fs.readFileSync(path.join(__dirname,"../../app/checks/performance-diagnostics.js"),"utf8");
    vm.runInContext(source,sliceVM);
    const diagnostics=sliceVM.AtriumDiagnostics=sliceVM.AtriumPerformanceDiagnostics;
    const stage=name=>diagnostics.performanceSnapshot().rows.find(row=>row.operation===name);
    const waitStage=()=>stage("stationary-text-dispatch"), waits=()=>waitStage()?.counts.completed||0;
    const ordinary=diagnostics.startPerformance();
    const unmeasured=viewForSlices("without detail");
    const reads=clockReads;
    unmeasured.start();
    assert.equal(clockReads,reads,"a disabled post does not read the clock");
    runNext();
    assert.equal(clockReads,reads+3,"a disabled handler uses only existing work clocks");
    assert.equal(waitStage(),undefined);
    slices.pause(unmeasured.I);

    let detail=diagnostics.startPerformance({rendererStages:true});
    messageDelay=11;
    const partial=viewForSlices("delayed partial");
    partial.start(); runNext();
    assert.equal(waits(),1);
    assert.equal(waitStage().runP95,11,"wait ends at handler entry, before scope work");
    assert.equal(stage("stationary-text-rows"),undefined,"scope work has no row sample");
    runNext(); runNext();
    assert.equal(waits(),3,"both setup and paint deliveries are measured");
    assert.equal(stage("stationary-text-rows").runP95,2,"row paint remains a separate sample");
    assert.deepEqual(["stationary-band-paint","stationary-text-upload","stationary-text-readback"]
      .map(name => stage(name)?.runP95),[1,.5,.25],"readback is nested in upload; band painting is separate");
    partial.cam[0]++;
    runNext();
    assert.equal(waits(),3,"a changed camera invalidates the pending measurement");

    const cancelled=viewForSlices("cancelled dispatch"), replacement=viewForSlices("new dispatch");
    cancelled.start();
    const late=staleMessage;
    slices.pause(cancelled.I); replacement.start();
    task(late,time,"message"); runNext();
    assert.equal(waits(),3,"a stale channel cannot claim the successor's measurement");
    runNext();
    assert.equal(waits(),4);
    slices.pause(replacement.I);

    const head=viewForSlices("old queue head"), nextPane=viewForSlices("next queue head");
    head.start(); nextPane.start(); slices.pause(head.I);
    runNext();
    assert.equal(waits(),4,"a changed queue head does not inherit the old post");
    runNext();
    assert.equal(waits(),5,"the successor's next post has its own timing");
    slices.pause(nextPane.I);

    const restart=viewForSlices("new detailed lease");
    restart.start(); detail.stop();
    detail=diagnostics.startPerformance({rendererStages:true});
    runNext();
    assert.equal(waits(),5,"detail restarting under the same ordinary lease discards the old post");
    runNext();
    assert.equal(waits(),6);
    slices.pause(restart.I);

    const crossing=viewForSlices("new recorder");
    crossing.start(); detail.stop(); ordinary.stop();
    detail=diagnostics.startPerformance({rendererStages:true});
    runNext();
    assert.equal(waits(),0,"a later recording cannot claim an older post");
    runNext();
    assert.equal(waits(),1);
    crossing.I.onRows = () => { detail.stop(); detail=diagnostics.startPerformance({rendererStages:true}); };
    runNext();
    for (const name of ["stationary-text-rows","stationary-band-paint","stationary-text-upload","stationary-text-readback"])
      assert.equal(stage(name),undefined,"a recording started during a strip cannot claim its timing");
    slices.pause(crossing.I); detail.stop();
    messageDelay=.25;
    assert.equal(tasks.size,0);
    assert.equal(channels,0);
  }
  for (const [ua,platform,readback,gtk] of [
    ["Chrome/158","Linux aarch64",false,false],["AppleWebKit/621","MacIntel",true,false],
    ["AppleWebKit/621 Android","Linux armv8",true,false],["AppleWebKit/621","Linux aarch64",true,true]
  ]) {
    // Keep the real overlay transfers. Each synthetic Canvas row has its own visible value.
    const made = [], copied = [];
    let denyFullContext = false, throwContext = false, loseContext = false, lastRaster;
    let lang = "en", dir = "ltr", styledDir = "ltr";
    const rasterBytes = 200 * 240 * 4;
    const canvasForRows = (w,h) => {
      let rows = new Uint8Array(h);
      const canvas = {
        isConnected:true,
        closest(selector){return selector==="[lang]"?{lang}:{dir};},
        ownerDocument:{
          defaultView:{getComputedStyle(){return {direction:styledDir};}},
          createElement(){const scratch=canvasForRows(300,150);made.push(scratch);return scratch;}
        },
        get width(){return w;},set width(n){w=n;rows.fill(0);},
        get height(){return h;},set height(n){h=n;rows=new Uint8Array(h);},
        get rows(){return rows;},
        getContext(){
          if (!made.includes(canvas) || h!==240) return ctx;
          if (throwContext) throw Error("Unable to allocate the offscreen context");
          return denyFullContext ? null : ctx;
        }
      };
      const ctx = {canvas,save(){},restore(){},setTransform(){},beginPath(){},rect(){},clip(){},
        isContextLost(){return loseContext && made.includes(canvas) && h===240;},
        drawImage(source,...args){
          const [sy,height,dy] = args.length===2 ? [0,source.height,0] : [args[1],args[3],args[5]];
          copied.push([source,canvas,sy,height,dy]);
          rows.set(source.rows.subarray(sy,sy+height),dy);
        }};
      return canvas;
    };
    const ctx = vm.createContext({...fixture,navigator:{userAgent:ua,platform},
      AtriumPower:{visible:()=>!hidden},
      AtriumCanvas:{resizeBacking(c,w,h){if(c.width!==w)c.width=w;if(c.height!==h)c.height=h;}},
      pourCoverage(I){I.onCoverage?.();}
    });
    vm.runInContext(gpuCode.replace("  return Object.freeze("+sceneExport,
      "  ({scope, textLayer, pourCoverage} = globalThis); memory = queueDriverMemoryProbe = () => true;\n" +
      "  return Object.freeze({render, damage, stats, views, textSlices, restorePixels, bytesOf,"),ctx);
    const api = ctx.AtriumCanvasGPU, canvas = canvasForRows(200,240), camera = [0,0,1,false,200,240,1];
    const overlay = Uint8Array.from(canvas.rows,(_,i)=>i%19 ? 0 : 207);
    let done = 0, repaints = 0;
    const zero={glCap:0,stride:0}, gl = {deleteTexture(){}};
    const framebuffer = {width:240,height:300};
    const st = {canvas:framebuffer,shown:true,scene:{rev:1,layers:new Map(),edge:zero,air:zero},parked:new Map(),
      gl,commandEpoch:0,stats:{acc:{board:0},textSliceRows:0,textSliceWorkMs:0,pourBytes:0}};
    const I = {name:ua,canvas,ctx:canvas.getContext(),cache:{doc:board},cam:()=>camera,
      withCamera(x,y,s,fn){fn();},repaint(){repaints++;},onRows(y,h){
        lastRaster=I.ctx.canvas;
        lastRaster.rows.fill(17,readback?y:0,readback?y+h:lastRaster.height);
        assert.ok(lastRaster.rows.subarray(y,y+h).every(value=>value===17),"the raster keeps its source row coordinates");
        st.textJob.T.w=canvas.width;st.textJob.T.h=canvas.height;
      }};
    I.sync = () => I.cache;
    api.views.set(I,st);
    const start = () => api.textSlices(I,st,board,new Map(),{},[],"textJob",camera,canvas,(T,V,foreground)=>{
      assert.equal(T.canvas,canvas,"a published band uses the stable canvas for later drawing");
      assert.equal(T.ctx,I.ctx);
      assert.equal(api.bytesOf(st),0,"the released job cannot keep its surface in the app budget");
      if (st.exact) {
        assert.ok(foreground);
        assert.deepEqual(foreground.rows,overlay,"the final coverage stage preserves the full live overlay");
        api.restorePixels(I.ctx,foreground);
      }
      done++;
    });
    const firstRows = () => {runNext();runNext();runNext();};
    const twoSteps = fn => {start();runNext();runNext();fn();};
    const identical = () => assert.deepEqual(canvas.rows,overlay,ua+" restores all live overlay rows");
    const size = c => [c.width,c.height];
    const released = c => assert.deepEqual(size(c),[1,1],ua+" discards the abandoned backing");
    let rows = I.onRows;
    canvas.rows.set(overlay);
    start();firstRows();
    let scratch=made.at(-1);
    assert.equal(lastRaster===canvas,!gtk,platform+" chooses the expected foreground surface");
    assert.deepEqual(size(scratch),[200,gtk||!readback?240:150],platform+" owns one working backing");
    if (gtk) assert.deepEqual([scratch.lang,scratch.dir],["en","ltr"],"the allowed detached scene keeps English LTR shaping");
    assert.equal(copied.length,gtk?0:2,platform+" only snapshots and restores the attached raster");
    assert.equal(api.bytesOf(st),rasterBytes*(gtk?2:1),"live WebGL texture and new raster both count");
    identical();
    if (gtk) {
      canvas.rows[33]=89;
      runNext();
      assert.equal(canvas.rows[33],89,"interleaved live tool pixels survive the next detached stripe");
      assert.equal(copied.length,0);
      canvas.rows[33]=overlay[33];
    }
    api.pause(I);
    released(scratch);
    assert.equal(tasks.size,0);
    assert.equal(done,0);
    identical();

    I.onRows=(y,h)=>{
      rows(y,h);
      api.pause(I);
      scratch=made.at(-1);
      assert.ok(scratch.width>1,"a mid-row pause cannot release pixels needed by finally");
    };
    twoSteps(runNext);
    released(scratch);
    assert.equal(tasks.size,0);
    assert.equal(done,0);
    identical();

    I.onRows=(y,h)=>{rows(y,h);throw new Error("after a destructive row");};
    twoSteps(runNext);
    released(made.at(-1));
    assert.equal(repaints,1,"a failing row still asks for the normal repaint");
    assert.equal(tasks.size,0);
    identical();

    I.onRows=rows;
    start();firstRows();scratch=made.at(-1);
    const allocated=made.length;
    start();firstRows();
    assert.equal(made.length,allocated,"a direct replacement reuses its idle snapshot");
    drain();
    released(scratch);
    assert.equal(done,1);
    identical();

    I.onRows=(y,h)=>{rows(y,h);I.onRows=rows;start();};
    twoSteps(runNext);
    scratch=made.at(-1);released(scratch);
    assert.equal(tasks.size,1,"a synchronous replacement owns the only successor");
    firstRows();
    const replacement=made.at(-1);
    assert.notEqual(replacement,scratch);
    assert.ok(replacement.width>1);
    drain();
    released(replacement);
    assert.equal(done,2);
    assert.equal(tasks.size,0);
    identical();

    st.exact = {};
    I.onCoverage=()=>{canvas.rows.fill(93);api.pause(I);};
    start();drain();
    released(made.at(-1));
    assert.equal(done,2,"cancelled final coverage never publishes");
    identical();

    I.onCoverage=()=>canvas.rows.fill(93);
    start();drain();
    released(made.at(-1));
    assert.equal(done,3,"ordinary coverage publishes and releases the overlay snapshot");
    identical();

    if (gtk) {
      st.exact=null;
      st.driverOutOfMemory=false;
      I.onRows=(y,h)=>{rows(y,h);st.driverOutOfMemory=true;};
      start();firstRows();
      released(made.at(-1));
      assert.equal(tasks.size,0);
      assert.equal(done,3,"a driver failure never publishes the half-painted texture");
      st.driverOutOfMemory=false;
      I.onRows=rows;
      identical();

      ctx.__atriumGpuCapMB=(framebuffer.width * framebuffer.height * 4 + rasterBytes) / 1048576;
      start();firstRows();
      assert.notEqual(lastRaster,canvas,"one large framebuffer and one view-size raster fit their combined budget");
      api.pause(I);
      identical();

      ctx.__atriumGpuCapMB=.25;
      start();firstRows();
      assert.equal(lastRaster,canvas,"insufficient headroom uses the already-admitted attached path");
      api.pause(I);
      delete ctx.__atriumGpuCapMB;
      identical();

      denyFullContext=true;
      start();firstRows();
      assert.equal(lastRaster,canvas,"a failed scratch context retries the same row on the attached path");
      released(made.at(-2));
      api.pause(I);
      denyFullContext=false;
      identical();

      throwContext=true;
      start();firstRows();
      assert.equal(lastRaster,canvas,"a throwing scratch allocation retries the same row on the attached path");
      released(made.at(-2));
      api.pause(I);
      throwContext=false;
      identical();

      for (const [locale,direction,style] of [["ar","rtl","rtl"],["ja","ltr","ltr"],
        ["en","auto","ltr"],["en","ltr","rtl"]]) {
        [lang,dir,styledDir]=[locale,direction,style];
        start();firstRows();
        assert.equal(lastRaster,canvas,"unsupported locale or computed direction stays attached");
        api.pause(I);
        identical();
      }
      [lang,dir,styledDir]=["en","ltr","ltr"];
      start();firstRows();
      assert.notEqual(lastRaster,canvas,"restored English LTR enables the same detached painter");
      scratch=made.at(-1);
      styledDir="rtl";
      runNext();
      released(scratch);
      assert.equal(tasks.size,0,"an ancestor's direction change drops the old partial texture");
      assert.equal(done,3);
      identical();
      styledDir="ltr";

      start();firstRows();scratch=made.at(-1);
      const beforeLoss=repaints;
      I.onRows=(y,h)=>{rows(y,h);loseContext=true;};
      runNext();
      assert.equal(repaints,beforeLoss+1,"a lost 2D raster asks the standard attached paint to recover");
      assert.equal(tasks.size,0);
      assert.equal(done,3,"a lost 2D raster cannot publish a partially cleared band");
      released(scratch);
      identical();
      loseContext=false;
      I.onRows=rows;
      start();firstRows();
      assert.equal(lastRaster,canvas,"a view with an independent 2D loss does not retry the detached context");
      api.pause(I);
      identical();
    }

    // The ordinary attached coverage job may fail after queuing a successor.
    // No newer paint runs inline. The successor owns the only future task.
    st.exact={};
    let successor;
    const beginDone=done, beginRepaints=repaints;
    I.onCoverage=()=>{
      I.ctx.canvas.rows.fill(213);
      I.onCoverage=null;
      start();
      successor=st.textJob;
      throw Error("old coverage failed after another job was queued");
    };
    start();
    while(!successor)runNext();
    identical();
    assert.equal(st.textJob,successor,"failure in the old job must not cancel a queued successor");
    assert.equal(tasks.size,1);
    assert.equal(done,beginDone,"the stale job cannot publish");
    assert.equal(repaints,beginRepaints,"an older renderer failure must not schedule another paint");
    drain();
    assert.equal(done,beginDone+1,"the pending successor owns publication");
    identical();
  }
  console.log("Foreground slice scratch restores Chromium and WebKit overlay rows and releases on cancel, failure and publication");
  // Drive the LOD publisher through the editor's draw/settle route. The prior
  // generic redraw scheduled a stationary frame during a retained camera move.
  const appFile = name => path.join(__dirname,"../../app",name);
  const editor = fs.readFileSync(appFile("editor/editor.js"),"utf8");
  const from = editor.indexOf("  function draw(){activeDirty=true;"), to = editor.indexOf("  // perf1:",from);
  assert.ok(from >= 0 && to > from);
  const hostForLOD = vm.runInContext(`({view,panes,activePane,schedule})=>{
    let activeDirty=false,pointerOnly=false;
    const viewportVisible=true, visibleBoardForPaint=p=>p.covered?null:activePane.doc;
    ${editor.slice(from,to)}
    return {redraw,redrawPourLOD:typeof redrawPourLOD==="function"?redrawPourLOD:undefined};
  }`,sliceVM);
  // The posted job may observe the new camera before the editor's paint callback.
  const sourceRange = (start, end) => {
    const a = editor.indexOf(start), b = editor.indexOf(end, a);
    assert.ok(a >= 0 && b > a);
    return editor.slice(a, b);
  };
  const hostForInterrupt = vm.runInContext(`({pane, clock, inactive})=>{
    const panes=[pane], activePane=inactive?{}:pane, viewportVisible=true, homeFit=false, in3D=()=>false;
    let frame=0, activeDirty=false, pointerOnly=false;
    function schedule(){if(!frame)frame=clock(()=>{frame=0;activeDirty=false;});}
    ${sourceRange("  function paneRepaint(", "  view.onRepaint")}
    ${sourceRange("  function draw(){activeDirty=true;", "  function redraw(")}
    ${sourceRange("  function cameraFrame(", "  // Preserve first-contact")}
    return {cameraFrame, cameraEnd:typeof cameraEnd==="function"?cameraEnd:undefined, repaint:moving=>paneRepaint(pane,moving)};
  }`,sliceVM);
  const canvasStub = sliceVM.AtriumCanvas;
  sliceVM.Atrium = Atrium;
  vm.runInContext(fs.readFileSync(appFile("canvas/canvas.js"),"utf8"),sliceVM);
  const createView = sliceVM.AtriumCanvas.create;
  sliceVM.AtriumCanvas = canvasStub;
  for (const kind of ["queued movement", "programmatic camera", "unowned motion", "changed revision"]) {
    const job = viewForSlices(kind), pane = {view:createView(job.I.canvas), version:0};
    const {view} = pane, settle = view.settle;
    let settles = 0, paints = 0;
    view.settle = () => { settles++; settle(); };
    const host = hostForInterrupt({pane,clock:run => task(()=>{ paints++; run(); },time+period,"display")});
    view.onRepaint(host.repaint);
    job.I.repaint = view.internals().repaint;
    job.start(); runNext(); runNext(); runNext();
    assert.equal(job.st.stats.textSliceRows,16,"partial textures are written before the next input");
    if(kind==="queued movement" || kind==="changed revision")host.cameraFrame(pane,false,false);
    if(kind==="unowned motion")view.moving();
    job.cam[0]++;
    if(kind==="changed revision")job.st.scene.rev++;
    assert.equal(paints,0);
    runNext();
    assert.equal(paints,0,"the stale message ran before the scheduled view paint");
    assert.deepEqual(job.deleted,[kind],"the abandoned texture is freed");
    assert.equal(job.completed,undefined,"the old camera never publishes");
    assert.equal(settles,kind==="changed revision"?2:1,kind+" preserves only an already queued camera gesture");
    drain();
    assert.equal(paints,1,kind+" still receives one editor paint");
  }
  console.log("Stale posted text rows preserve queued editor motion and standalone camera recovery");

  for (const kind of ["queued motion", "queued artwork", "displayed motion", "inactive", "covered"]) {
    const job=viewForSlices("finish editor "+kind), paints=[];
    job.I.canvas.getBoundingClientRect=()=>({width:200,height:80});
    const view=createView(job.I.canvas), pane={view,version:0};
    const current = sliceVM.AtriumCanvasGPU;
    sliceVM.AtriumCanvasGPU = {
      render:(_I,_doc,_defs,_opts,gesture)=>{paints.push(gesture);return true;},
      finishMove:slices.finishMove
    };
    const internals=view.internals();
    slices.views.set(internals,job.st);
    const host=hostForInterrupt({pane,inactive:kind==="inactive",clock:run=>task(()=>{
      run();
      view.render({...board,items:[]},new Map(),{reuseBase:true});
    },time+period,"display")});
    view.onRepaint(host.repaint);
    try {
      if(kind==="queued motion" || kind==="inactive" || kind==="covered")host.cameraFrame(pane,false,false);
      if(kind==="queued artwork")host.repaint(false);
      if(kind==="displayed motion")slices.settleAfterMove(internals,job.st,board,new Map(),{},[],false,true);
      if(kind==="covered")pane.covered=true;
      host.cameraEnd?.(pane);
      host.cameraEnd?.(pane);
      assert.equal(tasks.size,1,"the physical end still uses exactly one pending frame");
      assert.equal(tasks.values().next().value.kind,"display","completion does not leave a timer behind");
      drain();
      assert.deepEqual(paints,[kind==="queued motion"||kind==="inactive"?"wheel-end":kind==="covered"?true:false],
        "only a real queued gesture is upgraded; an already displayed gesture needs a settling repaint");
    } finally {
      slices.views.delete(internals);
      slices.views.delete(job.I);
      sliceVM.AtriumCanvasGPU=current;
    }
  }
  for (const kind of ["signal", "ordinary", "covered", "paused", "hidden"]) {
    const {I,st,cam}=viewForSlices("motion finish "+kind), start=time, defs=new Map();
    st.text={bands:[]};
    slices.settleAfterMove(I,st,board,defs,{},[],false,true);
    assert.equal(tasks.size,1);
    if (kind==="covered") I.canvas.inert=true;
    if (kind==="paused") I.canvas.isConnected=false;
    if (kind==="hidden") hidden=true;
    if (kind!=="ordinary") slices.finishMove?.(I);
    if (kind==="signal") {
      assert.equal(I.repaints,1,"explicit end requests the existing settling paint without the 140 ms retry");
      assert.equal(time,start);
      assert.equal(tasks.size,0,"completion replaces rather than duplicates the outstanding retry");
      assert.equal(st.settling,true);
      slices.settleAfterMove(I,st,board,defs,{},[],true,false);
      assert.ok(st.textJob,"the next paint prepares the final camera");
      slices.finishMove?.(I); // A delayed duplicate arrives while exact rows are pending.
      runNext(); runNext(); runNext();
      assert.ok(st.stats.textSliceRows>0);
      cam[0]++;
      runNext(); drain();
      assert.equal(st.text.bands.length,0,"interruption cannot publish abandoned rows");
    } else {
      assert.equal(I.repaints,undefined,kind+" waits for normal idle behavior");
      hidden=false;
      runNext();
      assert.equal(time-start,140);
      assert.equal(I.repaints,1);
    }
    slices.finishMove?.(I);
    assert.equal(tasks.size,0,"a late completion creates no callback");
    slices.views.delete(I);
  }

  sliceVM.TextDecoder = TextDecoder;
  sliceVM.atob = atob;
  sliceVM.btoa = btoa;
  sliceVM.AtriumIdle.idle = run => task(() => run({timeRemaining:()=>6}), time + .25);
  vm.runInContext(fs.readFileSync(appFile("pcb/pcb-pours.js"),"utf8"),sliceVM);
  const pours = sliceVM.AtriumPCBPours;
  const ring = Array.from({length:1800},(_,n)=>[20*Math.cos(n*Math.PI/900),20*Math.sin(n*Math.PI/900)]);
  for (const kind of ["gesture","stationary","2D","split","covered","different board"]) {
    const {I,st} = viewForSlices("display LOD "+kind);
    st.exact = {doc:board, rev:1};
    const defer = kind === "gesture", active = {doc:kind==="different board"?other:board, covered:kind==="covered"};
    const view = {internals:()=>I,settle(){}};
    let redraws = 0;
    const panes = kind==="split" ? [active,{}] : [active];
    const host = sliceVM.AtriumNavHost = hostForLOD({view,panes,activePane:active,schedule(){redraws++;}});
    if (kind==="2D") slices.views.delete(I);
    else if (kind!=="stationary") slices.settleAfterMove(I,st,board,new Map(),{},[],false,true);
    const region = pours.region([ring],"Top","GND");
    const stamp = pours.lod.version;
    assert.equal(pours.lodRingsAt(region,4),null);
    runNext();
    assert.equal(pours.lod.version,stamp+1,"the idle publisher still exposes the new contours");
    assert.ok(pours.lodRingsAt(region,4));
    assert.equal(redraws,Number(!defer),kind+" chooses the appropriate host redraw");
    assert.equal(tasks.size,kind==="stationary"||kind==="2D"?0:1,kind+" creates no extra work");
    if (defer) {
      host.redraw(); // authored edits and display mode changes still use their existing method
      assert.equal(redraws,1,"ordinary redraw is independent of display LOD");
      assert.equal(I.repaints,undefined);
      runNext();
      assert.equal(I.repaints,1,"the existing settle timer owns the foreground repaint");
    } else drain();
    assert.equal(tasks.size,0,kind+" leaves no recurring work");
  }
  assert.match(editor, /redraw,redrawPourLOD,/, "NavHost exposes the narrow redraw endpoint");
  assert.equal(failure.I.repaints,1,"a failed foreground slice asks for one full repaint and stops");
  assert.equal(tasks.size,0);
  console.log("Display LOD coalesces with an existing foreground GPU settle only");

  const widePane = viewForSlices("wide policy"), exactPane = viewForSlices("exact policy");
  const {I, st, cam} = widePane, defs = new Map(), opts = {selected:"selected",reuseBase:true}, list = [];
  const schedule = () => slices.scheduleWide(I, st, board, defs, opts, list);
  const setEfficiency = value => { efficient = value; onPower({visible:true,efficient}); };
  st.exact = {doc:board, rev:1, cx:0, cy:0, scale:1, flipped:false, width:200, height:80, dpr:1,pourList:list};
  st.overlayWorld = {ink:"exact"};
  st.text = {bands:[{}], key:"visible exact"};
  const start = time;
  schedule();
  assert.equal(tasks.values().next().value.at, start + 250, "AC keeps the idle delay");
  drain();
  const ready = st.wide;
  assert.equal(st.stats.wideBuilds, 1);
  assert.deepEqual([st.stats.wideSliceRows, st.stats.wideSliceWorkMs], [80, 11.5]);
  assert.ok(slices.wideFits(st, st.exact, board, 1, list));
  assert.equal(slices.covers(st.exact, 0, 0, .6, false, 200, 80), undefined);
  assert.equal(slices.covers(ready, 0, 0, .6, false, 200, 80), true,
    "a completed wide texture can still support the first retreat");

  assert.deepEqual([ready.overlay.ink,ready.overlay.width,ready.overlay.height], ["selected",200,80]);
  assert.notEqual(ready.overlay, scratch[0], "the wide world overlay is a separate copy");
  const [scratchBefore, backingsBefore] = [scratch.length, backingSizes];
  cam[2] = .6;
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(slices.render(I,board,defs,opts,true,{pours:list}),true);
    const drawnText = drawn.at(-1);
    assert.equal(drawnText.bands,ready.text.bands,"both retreats draw the prepared wide texture");
    assert.equal(drawnText.exact,ready.text.exact,"the exact layer set remains current");
    assert.equal(drawnText.pours,list,"the kept bands still use the same geometry");
    assert.equal(shownOverlays.at(-1),ready.overlay,"both retreats display the published world overlay");
  }
  cam[2] = 1;
  schedule();
  assert.equal(tasks.size, 0, "an exact repaint at the same pose schedules no wide work or timer");
  assert.deepEqual([scratch.length,backingSizes],[scratchBefore,backingsBefore],"retreat and same-pose reuse do not acquire scratch");
  assert.deepEqual([scratch.length,fullBackings],[1,1],"first prepaint acquires one scratch backing");
  assert.equal(st.wideCanvas,scratch[0],"the view retains one reusable canvas shell");
  assert.equal(scratch[0].width,0,"publishing shrinks the private backing");
  assert.deepEqual([ready.text.canvas,ready.text.ctx,ready.text.strip],[null,null,null],
    "published wide text keeps no drawing context or strip painter");
  st.text.key = "changed artwork";
  // A policy change does not redraw the current camera or discard a finished wide copy.
  schedule();
  assert.ok(st.wideJob);
  setEfficiency(true);
  assert.equal(tasks.size, 0, "visible Efficiency cancels the wide debounce");
  assert.equal(st.wide, ready);
  assert.equal(st.exact.scale, 1);
  const before = backingSizes;
  schedule(); drain();
  assert.equal(backingSizes, before, "Efficiency produces no speculative surface");
  assert.equal(st.stats.wideSliceWorkMs, 11.5, "Efficiency adds zero speculative row work");

  // Recheck policy at timer dispatch even if the notification has not reached the view.
  setEfficiency(false);
  st.text.key = "new exact";
  schedule();
  efficient = true; drain();
  assert.equal(backingSizes, before, "a stale prepaint timer cannot start in Efficiency");

  setEfficiency(false); schedule();
  for (let i = 0; !st.wideText?.T.bands; i++) {
    assert.ok(i < 10, "an AC job has allocated a partial texture");
    runNext();
  }
  const rows = st.stats.wideSliceRows;
  const cancelledScratch = st.wideText.T.canvas;
  assert.equal(cancelledScratch,scratch[0],"dirty wide prep reuses the existing canvas");
  exactPane.start();
  setEfficiency(true); drain();
  assert.deepEqual(widePane.deleted, ["wide policy"], "cancel returns only unfinished texture resources");
  assert.equal(st.wideText, null);
  assert.equal(st.wideCanvas,cancelledScratch,"cancellation leaves the view's single scratch available");
  assert.equal(cancelledScratch.width,200,"cancelling wide work does not resize its canvas on input");
  assert.equal(st.wide, ready);
  assert.equal(ready.overlay.ink,"selected");
  assert.equal(st.stats.wideSliceRows, rows);
  assert.deepEqual([exactPane.st.stats.textSliceRows, exactPane.st.stats.textSliceWorkMs], [80,12.25],
    "real exact-camera work completes in Efficiency");

  // A pane can disconnect before the next renderer entry can release the view.
  setEfficiency(false); schedule();
  const allocated = backingSizes;
  I.canvas.isConnected = false;
  drain();
  assert.equal(backingSizes, allocated, "a detached pane cannot start its delayed prepaint");
  I.canvas.isConnected = true; schedule();
  for (let i = 0; !st.wideText?.T.bands; i++) {
    assert.ok(i < 10);
    runNext();
  }
  const detachedRows = st.stats.wideSliceRows;
  I.canvas.isConnected = false; drain();
  assert.equal(st.stats.wideSliceRows, detachedRows, "a detached pane cannot rasterize more wide rows");
  assert.deepEqual(widePane.deleted, ["wide policy", "wide policy"]);
  assert.equal(st.stats.wideBuilds, 1, "neither cancelled job published");
  I.canvas.isConnected = true;
  schedule(); drain();
  assert.equal(st.stats.wideBuilds,2,"a later dirty build publishes");
  assert.notEqual(st.wide,ready);
  assert.equal(st.wide.overlay,ready.overlay,"rebuilding still reuses the independent overlay");
  for (let i = 0; i < 2; i++) {
    st.text.key = "finished edit " + i;
    schedule(); drain();
    assert.equal(st.wide.forKey,st.text.key);
    assert.equal(st.wide.overlay,ready.overlay,"each rebuild uses the separate retained overlay");
  }
  assert.equal(st.stats.wideBuilds,4,"three successive dirty builds publish");
  assert.equal(scratch[0].width,200,"after first open, keep the backing across rebuilds");
  assert.deepEqual([scratch.length,fullBackings],[1,2],
    "two abandoned starts and three successful rebuilds share one regrowth");
  assert.equal(tasks.size,0);

  // GPU pressure can remove the wide artifact without tearing down the Canvas scratch.
  slices.freeWide(st);
  schedule(); drain();
  assert.equal(st.wideCanvas.width,200,"GPU eviction does not restart the first-publication policy");
  assert.deepEqual([scratch.length,fullBackings],[1,2]);

  // The normal teardown creates a new scratch lifetime on the next opening.
  const teardown = () => { slices.freeWide(st); slices.releaseCanvas(st,"wideCanvas"); };
  teardown();
  schedule(); drain();
  assert.deepEqual([scratch.length,scratch[0].width,st.wideCanvas.width],[2,1,0],
    "a new canvas after teardown releases its own initial backing");

  // An overlay callback can reenter before the first publisher reaches cleanup.
  teardown();
  st.text.key = "reentrant";
  const restart = () => slices.wideLayers(I,st,board,defs,opts,list,0,0,.5);
  let replacement;
  I.onOverlay = () => { I.onOverlay = null; restart(); replacement = st.wideText; };
  schedule();
  for (let i = 0; !replacement; i++) {
    assert.ok(i < 20,"the wide overlay published");
    runNext();
  }
  assert.equal(st.wideText,replacement);
  assert.equal(st.wideCanvas.width,200,"old cleanup must not shrink a replacement's active backing");
  drain();
  assert.equal(st.wideCanvas.width,200,"a first publish with an active replacement retains the shared backing");

  const prior = st.wide;
  st.text.key = "stale";
  I.onScope = () => { I.onScope = null; st.exact = {...st.exact}; };
  schedule(); drain();
  assert.equal(st.wide,prior,"a stale publication leaves the previous artifact");
  assert.equal(st.wideCanvas.width,200,"a stale rebuild keeps the reusable backing");

  st.text.key = "overlay error";
  const ctx = I.ctx, overlay = st.overlayWorld;
  I.onOverlay = () => { I.onOverlay = null; throw new Error("overlay failed"); };
  schedule();
  assert.throws(drain,/overlay failed/);
  assert.equal(I.ctx,ctx);
  assert.equal(st.overlayWorld,overlay);
  assert.equal(st.wideCanvas.width,200,"an overlay error keeps the reusable backing");
  assert.equal(tasks.size,0);
  console.log("Wide scratch shrinks once after first publication, then reuses one regrowth across cancellations and rebuilds");
}

function renderStageAttribution() {
  // Keep the production render decision and recorder. Give each leaf a distinctive
  // deterministic cost so mixing two stages or reading the previous full draw fails.
  let clockReads = 0, elapsed = 0, driverReads = 0, failedStrip = false, sameScaleCopy = false;
  const work = (ms, result = true) => () => { elapsed += ms; return result; };
  const viewport = {viewport:[-5,-5,5,5], o2:{}};
  const leaf = {
    place: work(0), update: work(0), memory: work(3), covers: () => !failedStrip || sameScaleCopy,
    scrollText(_I,st) { elapsed+=2; st.stats.textUpload+=64; return true; },
    scrollOverlay: () => { elapsed += 3; return !failedStrip; },
    draw: work(5), moveOverlay: work(17), afterMove: work(23),
    scope(I) { elapsed += 7; return I.stageViewport || viewport; },
    textLayer(_I, st) { elapsed += 11; st.stats.acc.board += 9; return null; },
    // Keep the real coverage and upload routines. Charge geometry discovery and
    // backing allocation separately from the layer paint and synchronous submission.
    smallHoleEdges: work(3), texture: work(1, {}), coveragePixels: work(2, [0,0,200,80]),
    overlay: work(19), scheduleWide: work(0)
  };
  const stubbed = realText => Object.keys(leaf).filter(name => !realText || name !== "textLayer").reduce((code, name) => {
    const declaration = new RegExp("(function " + name + "\\([^\\n]*\\) \\{)");
    assert.match(code, declaration, "the production render leaf exists");
    return code.replace(declaration, "$1 return G.stageLeaves." + name + "(...arguments);");
  }, gpuCode).replace(sceneExport, "{render, damage, stats, views, pourCoverage, scene, L,");
  const diagnostics = ["performance-diagnostics.js", "diagnostics.js"].map(file =>
    fs.readFileSync(path.join(__dirname, "../../app/checks", file), "utf8")).join("\n");
  function rendererContext(userAgent, realText = false) {
    const context = vm.createContext({
      AtriumPCBAppearance, AtriumResolvedLand, AtriumCanvasGPUPref:{decision:() => ({use:true})}, stageLeaves:leaf,
      navigator:{userAgent}, AtriumPCBPours:{},
      performance:{now() { clockReads++; return elapsed; }}, clearTimeout:cancel => cancel()
    });
    vm.runInContext(diagnostics, context);
    vm.runInContext(stubbed(realText), context);
    return context;
  }
  const webKit = rendererContext("AppleWebKit"), chromium = rendererContext("AppleWebKit Chrome/144");
  const webKitText = rendererContext("AppleWebKit", true), chromiumText = rendererContext("AppleWebKit Chrome/144", true);
  const list = ["Top","Bottom"].map(layer => ({layer,bounds:[-2,-2,2,2]}));
  const doc = {...board,pcbDrawing:{pours:list}}, cache = {doc,rev:1,pourSig:"fixture"};
  const defs = new Map(), frame = {pours:list};
  function capture(kind, mode, {rejectStrip = false, cacheHit = false, direct = false, wires = true, speculative = false, realText = false} = {}) {
    const {AtriumDiagnostics:D, AtriumCanvasGPU:renderer} = realText ? (direct ? chromiumText : webKitText) : (direct ? chromium : webKit);
    const opts = {reuseBase:true, showUnrouted:wires};
    const readback = {};
    sameScaleCopy = kind === "copy";
    failedStrip = rejectStrip || sameScaleCopy;
    const scale = kind === "zoom" ? .8 : 1, prior = {scope: 1000};
    const I = {
      canvas:{width:200,height:80,isConnected:true,getContext:()=>I.ctx}, cache,
      cam:() => [1,0,scale,false,200,80,1], sync:() => cache,
      ctx:{save:work(0),setTransform:work(0),clearRect:work(0),restore:work(0),getImageData:work(5, readback)},
      boardTransform:work(0), paintTop:work(17), airwireConnectivity:work(13, {airwires:[]}),
      drawBoard(g, items, _doc, _defs, _scale, options, regions, _view, _lod, painted, bounds) {
        if (regions) {
          elapsed += regions[0].layer === "Top" ? 3 : 7;
          st.stats.acc.board += 29;
        } else for (const item of items) if (!options.hidden?.has(item.layer)) {
          painted?.(item); bounds?.(g, 6, 6, 9, 9);
        }
      }
    };
    const st = {
      strict:true, powerPreference:"low-power", shown:true, text:{bands:[{}], key:"fixture"},
      canvas:{width:200,height:80}, parked:new Map(), alphaTextures:true,
      exact:{doc,rev:1,cx:0,cy:0,scale:1,flipped:false,width:200,height:80,dpr:1,pourList:list},
      gl:{
        ALPHA:1, RGBA:2, bindTexture:work(0), pixelStorei:work(0),
        texSubImage2D(...args) {
          elapsed += 6;
          assert.equal(args.at(-1), direct ? I.canvas : readback, "the original texture source is submitted");
        },
        isContextLost:() => false,
        getExtension() { driverReads++; return null; },
        getParameter() { driverReads++; return null; },
        getError() { driverReads++; return 0; }
      },
      stats:{acc:{n:0,gesture:0,update:0,gl:0,overlay:0,board:0}, last:prior,pourBytes:0,coverageUpload:0,textUpload:4096}
    };
    if (realText) {
      const pad = {...F4.pad, id:"caption",kind:"pad",layer:"Top",net:"CAPTION",x:0,y:0,w:60,h:30,drill:0};
      const items = ["Bottom","Top"].map(layer => ({id:layer,kind:"label",layer}));
      I.ctx.canvas = I.canvas;
      I.ctx.getTransform = () => ({a:1,b:0,c:0,d:1,e:0,f:0});
      I.worldToScreen = p => p;
      I.query = work(4, [pad]);
      I.padText = work(0);
      I.stageViewport = {...viewport,active:"Top",padDetails:true,all:[pad],items,o2:opts};
      st.scene = renderer.scene({...cache,boxes:new Map(),byId:new Map()},null);
      renderer.L(st.scene,"Top");
      st.text = {};
    }
    const broad = kind === "zoom" || rejectStrip ? {width:200,height:80} : null;
    if (broad) st.stripLarge = broad;
    renderer.views.set(I, st);
    const cancelled = [];
    if (speculative) {
      st.wide = {...st.exact, scale:.5, forKey:st.text.key, forOverlay:false, text:st.text};
      st.wideJob = () => cancelled.push("timer");
      st.wideText = {T:{bands:[{tex:"partial"}]}, cancel:() => cancelled.push("rows")};
      st.gl.deleteTexture = tex => cancelled.push(tex);
    }
    const completeWide = st.wide;
    if (cacheHit) assert.equal(renderer.render(I, doc, defs, opts, false, frame), true);
    const lease = mode && D.startPerformance({rendererStages:mode === "detailed"});
    const readsBefore = clockReads, driverBefore = driverReads;
    if (kind === "slice") {
      st.textJob = {};
      assert.equal(renderer.pourCoverage(I, st, doc, defs, opts, I.cam(), viewport, list, null, cache).size, 2);
    } else assert.equal(renderer.render(I, doc, defs, opts, kind !== "full", frame), true);
    if (speculative) {
      assert.deepEqual(cancelled, ["timer","rows","partial"], kind + " cancels unfinished wide work before another refresh");
      assert.equal(st.wide, completeWide, "camera motion preserves the completed wide artwork");
    }
    if (broad) assert.deepEqual([st.stripLarge,broad.width,broad.height],[null,1,1],
      "zoom and abandoned pan release the broad scratch");
    const afterRender = clockReads;
    assert.equal(driverReads, driverBefore);
    if(kind==="zoom" || kind==="pan" || kind==="copy")
      assert.equal(renderer.resourceCounters(I).textUpload,kind==="zoom"?0:64,
        "each frame reports its own transfers, including a strip abandoned before the final draw");
    assert.equal(st.stats.acc.gesture, kind === "full" || kind === "slice" || rejectStrip ? 0 : 1);
    if (st.stats.acc.gesture) assert.equal(st.stats.last, prior, "legacy last remains the last full draw");
    renderer.views.delete(I);
    lease?.stop();
    const snap = D.performanceSnapshot();
    assert.deepEqual(JSON.parse(JSON.stringify(D.performanceSnapshot({shareable:true}).rows)), [],
      "the exact stage rows never enter the public report");
    assert.equal(clockReads, afterRender, "reading stage snapshots never reads the clock");
    assert.ok(snap.rows.every(row => row.counts.started === 1 && row.counts.completed === 1),
      "each measured stage has one sample for the frame, not one per layer");
    return {reads:afterRender-readsBefore, driverReads:driverReads-driverBefore, legacy:JSON.stringify(st.stats),
      stages:Object.fromEntries(Array.from(snap.rows, row => [row.operation,row.runP95]))};
  }
  const full = {"full-scope":7,"full-text":11,"full-band-paint":9,
    "full-text-caption-occlusion":0,"full-text-upload":0,"full-text-readback":0,"full-coverage":44,
    "full-coverage-paint":10,"full-coverage-upload":22,"full-coverage-readback":10,
    "full-airwires":13,"full-draw":5,"full-overlay":19};
  for (const [kind, legacyClocks, detailedClocks, stages] of [
    ["pan", 3, 6, {"retained-pan-text":2,"retained-pan-overlay":3,"retained-pan-draw":5}],
    ["zoom", 3, 6, {"retained-zoom-draw":5,"retained-zoom-overlay":17}],
    ["copy", 4, 8, {"retained-copy-draw":5,"retained-copy-overlay":17}],
    ["full", 7, 20, full],
    ["slice", 0, 0, {}]
  ]) {
    const off = capture(kind, null), ordinary = capture(kind, "ordinary"), detailed = capture(kind, "detailed");
    assert.deepEqual(detailed.stages, stages, kind + " stage timing");
    assert.deepEqual([off.reads, ordinary.reads, detailed.reads], [legacyClocks, legacyClocks, detailedClocks], kind + " clock reads");
    assert.deepEqual([off.driverReads, ordinary.driverReads, detailed.driverReads], [0,0,0], kind + " driver reads");
    assert.deepEqual(ordinary.stages, {});
    assert.equal(detailed.legacy, off.legacy, "the original renderer timings and counters keep their contract");
  }
  const fallback = capture("pan", "detailed", {rejectStrip:true});
  for (const kind of ["pan", "zoom", "copy"]) capture(kind, null, {speculative:true});
  assert.deepEqual(fallback.stages, full, "abandoned strips do not create a retained frame sample");
  const cached = capture("full", "detailed", {cacheHit:true});
  assert.deepEqual(cached.stages, {...full,"full-coverage":0,"full-coverage-paint":0,"full-coverage-upload":0,"full-coverage-readback":0});
  assert.equal(cached.reads, 10, "a cached coverage pass uses no additional timing");
  const direct = capture("full", "detailed", {direct:true});
  // Both paths test whether the layer reaches the viewport. Direct upload skips the two readbacks.
  assert.deepEqual(direct.stages, {...full,"full-coverage":full["full-coverage"]-full["full-coverage-readback"],
    "full-coverage-upload":12,"full-coverage-readback":0});
  assert.equal(direct.reads, 16, "direct texture submission adds no readback clock reads");
  const noWires = capture("full", "detailed", {wires:false});
  assert.deepEqual(noWires.stages, {...full,"full-airwires":0});
  assert.equal(noWires.reads, 19, "a hidden connection layer skips its lookup clock");
  assert.equal(capture("full", "ordinary", {direct:true}).reads, 7);
  for (const direct of [false, true]) {
    const off = capture("full", null, {realText:true,direct}), ordinary = capture("full", "ordinary", {realText:true,direct});
    const detailed = capture("full", "detailed", {realText:true,direct}), cached = capture("full", "detailed", {realText:true,direct,cacheHit:true});
    const text = row => ["full-text-caption-occlusion","full-text-upload","full-text-readback"].map(key => row.stages[key]);
    assert.deepEqual(text(detailed), [4,direct ? 12 : 22,direct ? 0 : 10], "two actual text-band uploads and a caption occlusion query");
    assert.deepEqual(text(cached), [0,0,0], "a cached frame reports zero caption, upload and readback work");
    assert.equal(ordinary.reads,off.reads, "ordinary recording adds no text clock reads");
    assert.deepEqual(ordinary.stages,{});
    assert.equal(detailed.legacy, off.legacy, "recording text stages does not alter the original draw");
  }
  console.log("GPU stages separate caption occlusion, text upload, explicit readback, coverage, airwires and draw");
}
renderStageAttribution();

{
  // Keep the real render decision, overlay order and idle/end lifecycle. The
  // fixture starts with no retained viewport or text and a nonempty wire graph.
  const order = [], timers = new Map(), listeners = new Map(), defs = new Map(), frame = {pours:[]};
  const result = {airwires:[{from:[0,0],to:[3,4],net:"signal"}]};
  const opts = {editorPane:true, layer:"Silk", showUnrouted:true, highlight:"signal", netColors:new Map([["signal","#ffaa11"]])};
  let next = 0, lookups = 0, repaints = 0;
  const leaf = {
    // Exercise the full repaint when neither the prior nor wider raster can be used.
    place:() => true, update() {}, memory:() => true, wideNowFits:() => false,
    scope:() => ({top:true, active:"Silk", o2:opts, items:[], viewport:[-10,-10,10,10]}),
    textLayer:() => null, pourCoverage:() => null, scheduleWide() {}, queueDriverMemoryProbe() {},
    copyCanvas:() => ({width:200,height:80}),
    draw(I, st, doc, defs, options, cam, c, text, pours, coverage, wires, moving = wires === undefined) {
      assert.equal(options.netColors,opts.netColors);
      assert.equal(options.highlight,opts.highlight);
      assert.equal(wires,result,"the painter gets the already-resolved graph");
      order.push(moving ? "gpu wires" : "geometry");
    }
  };
  const context = vm.createContext({AtriumPCBAppearance, leaf,
    AtriumCanvasGPUPref:{decision:() => ({use:true})},
    setTimeout(run, delay) { timers.set(++next,{run,delay}); return next; },
    clearTimeout(id) { timers.delete(id); }
  });
  let code = gpuCode.replace(sceneExport,"{render, damage, stats, views, listen,");
  for (const name of Object.keys(leaf)) {
    const declaration = new RegExp("(function " + name + "\\([^\\n]*\\) \\{)");
    assert.match(code,declaration);
    code = code.replace(declaration,"$1 return G.leaf." + name + "(...arguments);");
  }
  vm.runInContext(code,context);
  const R = context.AtriumCanvasGPU, doc = {...board}, cache = {doc,rev:1}, cam = [0,0,1,false,200,80,1];
  const I = {canvas:{width:200,height:80,isConnected:true,style:{}},cache,cam:() => cam,sync:() => cache,
    ctx:{setTransform() {},clearRect() {}}, boardTransform() {},
    drawBoard() { order.push("world"); }, paintTop() { order.push("tools"); },
    artworkViewport:() => [-10,-10,10,10], airwireConnectivity() { lookups++; return result; },
    drawAirwires(doc,defs,view,highlight,substrate,colors) {
      assert.equal(highlight,opts.highlight); assert.equal(colors,opts.netColors);
      order.push("exact wires");
    },
    repaint() { repaints++; if (!st.lost) render(false); }
  };
  const st = {strict:true, powerPreference:"low-power", shown:true, losses:0, text:{key:null},
    canvas:{style:{},addEventListener(name,run) { listeners.set(name,run); }},
    scene:{cache}, gl:{isContextLost:() => st.lost}, stats:{acc:{n:0,gesture:0,board:0,update:0,gl:0,overlay:0}}};
  R.views.set(I,st); R.listen(I,st);
  function render(gesture, options = opts) { assert.equal(R.render(I,doc,defs,options,gesture,frame),true); }
  function moving() {
    cam[2] /= 5; // outside the retained zoom ratio when a previous viewport exists
    const before = lookups; order.length = 0;
    render(true);
    assert.deepEqual(order,["gpu wires","world","tools"],"moving full redraw draws the GPU wires below the world overlay");
    assert.equal(lookups,before+1);
    assert.equal(R.resourceCounters(I).exactCamera,false,"a wire preview is not the exact stationary frame");
    assert.deepEqual([...timers.values()].map(item=>item.delay),[140],"the empty text layer still gets one settle timer");
  }
  function exact() {
    assert.deepEqual(order,["geometry","world","exact wires","tools"],"exact wire art returns between world and tools");
    assert.equal(R.resourceCounters(I).exactCamera,true);
    assert.equal(timers.size,0);
  }
  moving();
  const [id,timer] = timers.entries().next().value;
  order.length = 0; timers.delete(id); timer.run(); exact();
  assert.equal(repaints,1,"idle repaints once");
  moving(); order.length = 0; render("wheel-end"); exact();
  assert.equal(repaints,1,"a known end paints its current pose without a second repaint");
  moving(); order.length = 0; R.finishMove(I); exact();
  assert.equal(repaints,2,"an explicit stop replaces the pending idle repaint");
  moving(); order.length = 0; render(false,{...opts,noReuse:true}); exact();
  moving(); R.pause(I); assert.equal(timers.size,0,"covering the pane cancels deferred exact work");
  moving(); listeners.get("webglcontextlost")({preventDefault() {}});
  assert.equal(timers.size,0,"context loss cancels deferred exact work");
  assert.equal(st.exact,null,"a lost context cannot retain its preview camera");
  console.log("Moving full GPU frames settle exact wire order once, including empty text and cancellation");
}

async function frameCounterBurst() {
  const {measureZoomSettle} = require("../support/browser-zoom-probe.cjs");
  let driverReads = 0, legacyReads = 0;
  const I = {cam: () => [0, 0, 1, false, 200, 80, 1]};
  const st = {canvas:{width:200,height:80}, parked:new Map(), shown:true,
    gl:{getExtension() { driverReads++; return null; }, getParameter() { driverReads++; return ""; }},
    stats:{acc:{n:12,gesture:7,update:0,gl:0,overlay:0,board:0,text:0,textHits:0}, pourBytes:0,
      textSliceRows:0, wideSliceRows:0, textSliceWorkMs:0, wideSliceWorkMs:0,
      gridBufferAllocations:0, driverFenceSubmissions:0, driverMemoryChecks:0}};
  gpu.views.set(I, st);
  const canvas = {getBoundingClientRect: () => ({width:200,height:80,left:0,top:0}),
    dispatchEvent() {
      const reset = () => {
        const before = driverReads, avg = gpu.stats(I, true).acc;
        legacyReads += driverReads - before;
        return [avg.frames, avg.gesture];
      };
      assert.deepEqual(reset(), [12, 7]);
      st.stats.acc.n = 2; st.stats.acc.gesture = 1;
      assert.deepEqual(reset(), [2, 1]);
      st.stats.acc.n = 1; st.stats.acc.gesture = 1;
    }};
  const benchView = {internals:()=>I, moving() {}, render() {}};
  const probeContext = vm.createContext({
    AtriumCanvasGPU:gpu, performance:{now:()=>0}, WheelEvent:class {},
    AtriumNavHost:{view:()=>benchView, canvas:()=>canvas, doc:()=>({items:[]}), project:()=>({documents:[]})},
    window:{__rawTimeout:run=>run(), __requireBoardAt() {}, __work:[]}
  });
  const measure = vm.runInContext("(" + measureZoomSettle + ")", probeContext);
  const result = await measure({bursts:[{}], events:1, quietMs:0, renderer:"gpu"});
  const {frames, retainedFrames, driverMemoryChecks} = result.perBurst[0].gpu;
  assert.deepEqual([frames, retainedFrames, frames - retainedFrames, driverMemoryChecks], [3, 2, 1, 0]);
  assert.equal(driverReads, legacyReads, "taking GPU work snapshots never queries the driver");
  console.log("GPU burst counts survive legacy timing resets without driver reads");
}
const done = globalThis.__testDone = frameCounterBurst();
done.catch(error => { console.error(error); process.exitCode = 1; });

{
  // A cold board owner need not decode unrelated copper to report the
  // invalidation. Drive the real resolver with the committed Undo journal.
  require("../support/3d-geometry.cjs");
  require("../../app/history/undo-store.js");
  const A = Atrium, R = AtriumResolvedGeometry, U = AtriumUndoStore, P = AtriumPCBPours;
  const project = A.project("Stored copper damage");
  const doc = project.documents.find(d => d.kind === "pcb");
  doc.outline = [[0,0],[100,0],[100,100],[0,100]];
  const trace = {id:"trace",kind:"track",layer:"Top",width:.2,points:[[8,8],[12,8]]};
  doc.items.push(trace);
  const circle = (x,y,r,degrees) => degrees.map(d => [
    x+r*Math.cos(d*Math.PI/180), y-r*Math.sin(d*Math.PI/180)
  ]);
  const linear = P.region([circle(60,60,5,Array.from({length:4096},(_,n)=>n*360/4096))],"Bottom","B");
  // The arc reaches 90° between stored samples. Stored bounds alone cannot
  // cover its exact damage. An undersized linear hint must not clip it either.
  const curved = P.region([[...circle(20,20,5,[15,55,122]),[17,22]]],"Top","T",{arcs:[0,0,2,20,20]});
  linear.bounds = [58,58,62,62];
  assert.ok(curved.bounds[1] > 15);
  doc.pcbDrawing = {annotations:{},pours:[linear,curved]};
  P.storeSignature(doc,new Map(),project);
  const history = [], future = [];
  const oldContour = P.contourEdges, decoded = [];
  const getView = () => R.readEditor(project,doc);
  const boardKey = {kind:"board",documentId:doc.id,instancePath:[]};
  const edit = fn => {
    const mark=U.mark(project);
    U.duringEdit(fn);
    U.checkpoint(history,future,mark,"Edit track");
    U.record(project,{doc,items:[trace]});
  };
  function checkDamage(view,since) {
    const change=view.changes(since);
    assert.equal(change.kind,"incremental");
    assert.deepEqual(change.owners.map(owner=>owner.kind).sort(),["board","item"]);
    assert.deepEqual(change.layers,["Top","Bottom"],"only the edited copper layers are dirty");
    assert.ok(change.bounds.some(box=>box.every((v,i)=>v===[55,55,65,65][i])),
      "linear damage comes from actual ring coordinates");
    assert.ok(change.bounds.some(box=>Math.abs(box[1]-15)<1e-8),"arc damage includes the true minimum between samples");
    assert.deepEqual(decoded,["T"],"only the stored arc requires contour expansion");
    decoded.length=0;
  }
  try {
    U.reset(project);
    U.record(project);
    P.contourEdges=(p,...args)=>{decoded.push(p.net);return oldContour(p,...args);};
    const original=getView().revision;
    edit(()=>{trace.reviewNote="Does not enter the copper signature";});
    const untouched=getView(), clean=untouched.revision;
    const change=untouched.changes(original);
    assert.deepEqual(change.layers,["Top"],"the unaffected board profile and copper get no damage");
    assert.deepEqual(decoded,[],"an unchanged copper snapshot never expands its contours");

    edit(()=>{trace.width=.6;});
    const stale=getView(), staleToken=stale.revision;
    checkDamage(stale,clean);
    assert.equal(stale.owner(boardKey).features.filter(f=>f.key.role==="pour").length,0,
      "stale copper disappears from the committed material");

    U.jump(history,future,U.mark(project),-1);
    const restored=getView();
    checkDamage(restored,staleToken);
    assert.equal(restored.owner(boardKey).features.filter(f=>f.key.role==="pour").length,2,
      "Undo restores both stored pours");
    decoded.length=0;
    const restoredToken=restored.revision;
    U.jump(history,future,U.mark(project),1);
    const redo=getView();
    checkDamage(redo,restoredToken);
    assert.equal(redo.owner(boardKey).features.filter(f=>f.key.role==="pour").length,0);
  } finally {
    P.contourEdges=oldContour;
    U.reset();
  }
}
console.log("Retained board damage skips equal copper and exactly removes or restores archived linear and curved rings");
