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
vm.runInContext(gpuCode.replace(sceneExport, "{render, damage, stats, update, padDetails, coveredPadDetails, paintPadDetails,"), sandbox);
const gpu = sandbox.AtriumCanvasGPU;
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
  const c = {doc:board,rev:1,all:[track],byId:new Map([[track.id,track]])};
  const curves = world.AtriumGeometryCurves, clock = Object.freeze({});
  const centerline = curves.pathEdges(track);
  const layer = "Top mask", width = 1.2;
  function capture() {
    const scene = gpu.update({stats:{},parked:new Map(),gl:{}},c,"Top");
    const {f,stride,n} = scene.layers.get(layer).seg;
    return Array.from({length:n},(_,i)=>Array.from(f.subarray(i*stride,i*stride+5)));
  }
  delete world.AtriumNavHost.boardGeometry;
  const cold = capture();
  world.AtriumNavHost.boardGeometry = () => ({revision:clock,owner:() =>
    ({features:[{key:{role:"mask",layer},ink:{kind:"stroke",centerline,width}}]})});
  assert.deepEqual(cold,capture(),"cold and committed GPU strokes have identical arc geometry");
  const onFilm = p => cold.some(([ax,ay,bx,by,w]) => Atrium.nearSegment(p,[ax,ay],[bx,by]) < w/2);
  assert.equal(onFilm(F2.inside),true,"the mask occupies the true arc");
  assert.equal(onFilm(F2.outside),false,"the old sampled chord is empty");
  assert.deepEqual([cold[0][0],cold[0][1],...cold.at(-1).slice(2,4).map(n=>Math.round(n)||0)],[6,0,-6,0]);
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
  const initialInk = fitForPaint(), flat = view.internals().cache.doc, projection = AtriumPanel.projectionOf(flat);
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
