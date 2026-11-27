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
vm.runInContext(gpuCode.replace(sceneExport, "{render, damage, stats, views, update, padDetails, coveredPadDetails, paintPadDetails,"), sandbox);
const gpu = sandbox.AtriumCanvasGPU;
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
  const U=AtriumUndoStore, spatial=AtriumSpatial, builds=[], queries=[];
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
    query(doc,defs,rect){queries.push(Array.from(rect));return I.query(doc,defs,rect);}
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
    builds.length=0; queries.length=0;
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

// Reuse unchanged coverage regions and keep the old snapshot for in-place edits.
{
  const W=47,H=31, reads=[], region={data:"body",count:2,layer:"Top",net:"GND",bounds:[8,9,15,13]};
  const rings=[[8,9,15,9,15,13,8,13],[9,10,9.1,10,9.1,10.1]];
  let inkChecks=0, paints=0;
  const context=vm.createContext({
    navigator:{userAgent:"AppleWebKit"},
    AtriumPCBAppearance:{...AtriumPCBAppearance,ink(...args){inkChecks++;return AtriumPCBAppearance.ink(...args);}},
    AtriumPCBPours:{contours:()=>rings}
  });
  vm.runInContext(gpuCode.replace(sceneExport,"{pourCoverage, render, damage, stats,"),context);
  const ctx={setTransform(){},clearRect(){},getImageData(...rect){reads.push(rect);return {};}};
  const canvas={width:W,height:H,getContext:()=>ctx};
  const gl={RGBA:2,createTexture:()=>({}),bindTexture(){},texStorage2D(){},texParameteri(){},pixelStorei(){},texSubImage2D(){}};
  const st={gl,canvas,alphaTextures:false,parked:new Map(),stats:{pourBytes:0,coverageUpload:0}};
  const I={canvas,ctx,worldToScreen:point=>point,boardTransform(){},drawBoard(){paints++;}};
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
    uploaded.length=0;
    if(owner)st[owner]={T:target};
    for(let y=0;y<H;y+=8)context.AtriumCanvasGPU.textLayer(I,st,doc,defs,opts,cam,V,null,target,[0,y,W,8]);
    if(owner)st[owner]=null;
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
  }
}

// Keep the full pixel result when a band's new footprint is smaller or moves away.
{
  require("../../app/pcb/pcb-draw.js");
  const webKit=vm.createContext({AtriumPCBAppearance,AtriumResolvedLand,AtriumSpatial,navigator:{userAgent:"AppleWebKit"}});
  vm.runInContext(gpuCode.replace(sceneExport,"{textLayer, render, damage, stats,"),webKit);
  const {textLayer}=webKit.AtriumCanvasGPU;
  const W=144,H=96,doc=Atrium.sheet("pcb","Text band uploads"),defs=new Map();
  const label={id:"legend",kind:"label",layer:"Silk",text:"jÉ",size:.08,width:.002,x:0,y:0,angle:37,italic:true};
  const pad={...F4.pad,id:"land",kind:"pad",layer:"Top",net:"LONG_NET_NAME",x:0,y:0,w:6,h:3,drill:0};
  const line={id:"path",kind:"label",text:"Imported annotation",size:1.1,width:.2,layer:"Silk",x:1,y:1,
    points:[[-5,-4],[5,-4]]};
  const rec=AtriumPDF.recorder(W,H), view=AtriumCanvas.create(rec.canvas);
  const scratch=new Uint8Array(W*H), reads=[];
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
      for(let row=H-bottom-h;row<H-bottom;row++)
        bound.set(pixels.subarray(row*W+x,row*W+x+w),row*W+x);
    }};
  function paint(st,items,cx,flipped,dpr,scale,hidden) {
    doc.items=items;
    const layer="Top",opts={layer,layerMode:"all",flipped,hidden};
    const I={...view.internals(),ctx:rec.ctx,worldToScreen:()=>[W/(2*dpr)+(flipped?cx:-cx)*scale,H/(2*dpr)],query:()=>items};
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
  } finally { rec.ctx.stroke=stroke; }
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
  let peak=0, deleted=0;
  const webKit=vm.createContext({AtriumPCBAppearance,AtriumCanvas,navigator:{userAgent:"AppleWebKit"},
    setTimeout:()=>1,clearTimeout(){},requestAnimationFrame:()=>2,cancelAnimationFrame(){},
    document:{createElement(){
      const {ctx}=AtriumPDF.recorder(1,1);
      let width=1,height=1;
      const c={
        get width(){return width;}, set width(w){width=w;peak=Math.max(peak,area());},
        get height(){return height;}, set height(h){height=h;peak=Math.max(peak,area());},
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
  vm.runInContext(gpuCode.replace(sceneExport,"{scrollText, afterMove, freeViewport, render, damage, stats,"),webKit);
  const {scrollText,afterMove,freeViewport}=webKit.AtriumCanvasGPU;
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
  console.log("GPU diagonal pan bounds its scratch and releases the large-jump backing before settle");
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
  let running, displayDelay=0, channels=0, staleMessage;
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
    AtriumPCBAppearance, performance:{now:() => time},
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
        const id=task(()=>{ids.delete(id);receive({data});},time+.25,"message");
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
    scope:I => { work(I, I.scopeWork ?? .75); I.onScope?.(); return {viewport:[0,0,4,4],o2:{}}; },
    textLayer(I, st, doc, defs, opts, cam, V, pours, T, [, y, , h]) {
      if (!h) {
        T.key = "painted"; T.bands = [{tex:I.name}]; T.pixels = new Uint8Array(st.canvas.height);
        T.exact = new Set(["Top"]); T.pours = pours;
        T.canvas = I.ctx.canvas; T.ctx = I.ctx; T.strip = {paintBand: () => T.canvas};
      }
      else if (I.fail) throw new Error("raster failed");
      T.pixels.fill(1, y, y + h);
      if (h) I.onRows?.(y,h);
      work(I, h ? h * (I.workPerRow ?? .125) : .75);
      return T;
    },
    pourCoverage:I => work(I, .75),
    copyCanvas(c, prior) { return Object.assign(prior || {}, {width:c.width,height:c.height,ink:c.ink}); }
  };
  if (!posted) delete fixture.MessageChannel;
  const sliceVM = vm.createContext(fixture);
  vm.runInContext(gpuCode.replace("  return Object.freeze(" + sceneExport,
    "  ({scope, textLayer, pourCoverage, copyCanvas, draw} = globalThis);\n" +
    "  const settleAfterMove = afterMove; place = memory = () => true; update = afterMove = queueDriverMemoryProbe = () => {};\n" +
    "  return Object.freeze({render, damage, stats, views, textSlices, wideLayers, scheduleWide, wideFits, freeWide, releaseCanvas, covers, settleAfterMove,"), sliceVM);
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
      stats:{acc:{n:0,gesture:0}, textSliceRows:0, wideSliceRows:0, textSliceWorkMs:0, wideSliceWorkMs:0}};
    slices.views.set(I, st);
    const target = wide ? {getContext:() => ctx} : canvas;
    let completed;
    return {I, st, cam, deleted, get completed() { return completed; }, start() {
      slices.textSlices(I, st, board, new Map(), {}, [], wide ? "wideText" : "textJob", cam, target,
        T => { assert.ok(T.pixels.every(p => p === 1)); completed = time; });
    }};
  }

  const wide = viewForSlices("wide", true), exact = viewForSlices("exact");
  wide.start(); exact.start();
  assert.equal(tasks.size, 1, "views subscribe to one display clock");
  drain();
  const peak = Math.max(...perFrame.values());
  const foreground=worked.filter(task=>task.exact);
  const maxTask=Math.max(...foreground.map(task=>task.ms));
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
  const hostForInterrupt = vm.runInContext(`({pane, clock})=>{
    const panes=[pane], activePane=pane, viewportVisible=true, homeFit=false, in3D=()=>false;
    let frame=0, activeDirty=false, pointerOnly=false;
    function schedule(){if(!frame)frame=clock(()=>{frame=0;activeDirty=false;});}
    ${sourceRange("  function paneRepaint(", "  view.onRepaint")}
    ${sourceRange("  function draw(){activeDirty=true;", "  function redraw(")}
    ${sourceRange("  function cameraFrame(", "  // Preserve first-contact")}
    return {cameraFrame, repaint:moving=>paneRepaint(pane,moving)};
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
    scrollText: work(2), scrollOverlay: () => { elapsed += 3; return !failedStrip; },
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
      stats:{acc:{n:0,gesture:0,update:0,gl:0,overlay:0,board:0}, last:prior,pourBytes:0,coverageUpload:0}
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
    const afterRender = clockReads;
    assert.equal(driverReads, driverBefore);
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
