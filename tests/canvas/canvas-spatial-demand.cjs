"use strict";
const assert = require("node:assert/strict");
for (const name of ["model", "pcb-appearance", "spatial", "canvas"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

// A whole-board query needs no grid. Its first subsequent detail query gets the exact current geometry.
const doc = {id:"board",kind:"pcb",items:[
  {id:"near",kind:"track",points:[[0,0],[1,1]],width:.2},
  {id:"far",kind:"track",points:[[5,6],[7,8]],width:.2},
]};
const defs = new Map(), view = AtriumCanvas.create({getContext:() => ({})});
const oldTimer = globalThis.setTimeout;
let timers = 0;
try {
  globalThis.setTimeout = () => { timers++; };
  assert.deepEqual(view.query(doc, defs, [-10,-10,10,10]), doc.items);
  assert.equal(timers, 0, "a whole-board bounding-box query schedules no hidden work");
} finally { globalThis.setTimeout = oldTimer; }
assert.equal(view.internals().cache.index, null);
doc.items[1].points = [[2,2],[3,3]];
view.invalidate(doc, [doc.items[1]]);
assert.deepEqual(view.query(doc, defs, [1.9,1.9,3.1,3.1]), [doc.items[1]]);
const index = view.internals().cache.index;
assert.ok(index);
assert.deepEqual(view.query(doc, defs, [6,6,7,7]), []);
assert.equal(view.internals().cache.index, index);

// A dense partial view switches to the ordered bounds without changing hit or paint order.
{
  const items = Array.from({length:1600}, (_, id) => {
    const cell = id * 619 % 1600, x = (cell % 40 - 20) * 2, y = ((cell / 40 | 0) - 20) * 2;
    return {id:"dense-" + id,kind:"track",points:[[x,y],[x+.5,y]],width:.2};
  });
  const moved = items[17], long = {id:"long",kind:"track",points:[[-262,3],[290,3]],width:.2};
  const missing = {id:"missing",kind:"imageMarkup"};
  const board = {id:"dense",kind:"pcb",items:[...items,missing,long]};
  const pane = AtriumCanvas.create({getContext:() => ({})});
  const viewport = [-33,-36,31,34], point = [0,0,0,0], strip = [-32,0,30,.9];
  const oracle = box => board.items.filter(item => {
    const bounds = pane.internals().cache.boxes.get(item);
    return bounds && AtriumSpatial.overlaps(bounds, box);
  });
  assert.deepEqual(pane.query(board, defs, viewport), oracle(viewport));
  const c = pane.internals().cache, index = c.index;
  assert.ok(index);
  assert.equal(c.boxes.has(missing), false);
  let scans = 0;
  c.all = new Proxy(c.all, {get(target, key) {
    if (key === Symbol.iterator) scans++;
    return target[key];
  }});
  for (const area of [point,strip]) assert.deepEqual(pane.query(board, defs, area), oracle(area));
  assert.equal(scans, 0, "point and strip queries keep using the grid");
  assert.deepEqual(pane.query(board, defs, viewport), oracle(viewport));
  assert.equal(scans, 1, "a dense partial query stops walking the grid and scans the ordered bounds");
  const original = c.all.slice(), staleOrder = original.slice();
  const other = {id:"unindexed"};
  staleOrder[staleOrder.length - 1] = other;
  const repeated = original.slice();
  repeated[repeated.length - 1] = repeated[repeated.length - 2];
  const reversed = original.slice().reverse();
  for (const stale of [staleOrder,repeated,reversed]) {
    assert.deepEqual(index.query(viewport,stale), oracle(viewport), "a stale ordered list falls back to the index");
  }
  const reordered = AtriumSpatial.create(board.items, item => c.boxes.get(item));
  reordered.reorder(reversed);
  const reverseHits = oracle(viewport).reverse();
  assert.deepEqual(reordered.query(viewport,original), reverseHits, "the old list cannot override new ranks");
  assert.deepEqual(reordered.query(viewport,reversed), reverseHits, "the new list follows the new ranks");
  const duplicateIndex = AtriumSpatial.create(board.items, item => c.boxes.get(item));
  const example = oracle(viewport)[0];
  duplicateIndex.insert(example,-1);
  assert.deepEqual(duplicateIndex.query(viewport,c.all), [example,...oracle(viewport)], "a duplicate insertion keeps both results");
  duplicateIndex.remove(example);
  assert.deepEqual(duplicateIndex.query(viewport,c.all), oracle(viewport), "removing the last insertion leaves the earlier result");
  const withoutOrphan = original.filter(item => item !== example);
  assert.deepEqual(duplicateIndex.query(viewport,withoutOrphan), oracle(viewport), "the ordered list cannot lose the orphaned entry");
  assert.equal(scans, 1, "duplicate grid entries exclude an otherwise eligible ordered scan");
  moved.points = [[800,7],[810,7]];
  pane.invalidate(board, [moved]);
  assert.deepEqual(pane.query(board, defs, viewport), oracle(viewport));
  assert.equal(pane.internals().cache.index, index, "an in-place edit keeps the index");
  assert.equal(pane.query(board, defs, viewport).includes(moved), false);
  assert.deepEqual(pane.query(board, defs, [805,7,805,7]), [moved]);
  board.items = [long,...board.items.slice(0,-1).reverse().filter(item => item !== items[22])];
  assert.deepEqual(pane.query(board, defs, viewport), oracle(viewport));
  assert.equal(pane.query(board, defs, viewport)[0], long, "the new order starts with the multilevel object");
  assert.equal(pane.query(board, defs, viewport).includes(items[22]), false);
}

// Generic indexes preserve repeated inserts and encounter order for equal ranks.
{
  const a = {id:"a",box:[-1,-1,1,1]}, b = {id:"b",box:[-1,-1,1,1]}, c = {id:"c",box:[-1,-1,1,1]};
  const index = AtriumSpatial.create([], item => item.box);
  index.insert(a, 4); index.insert(b, 4); index.insert(a, 2); index.insert(c, 4);
  const bounds = [-.5,-.5,.5,.5];
  assert.deepEqual(index.query(bounds), [a,a,b,c]);
  assert.equal(index.remove(a), 2);
  assert.deepEqual(index.query(bounds), [a,b,c]);
  index.reorder([c,b]);
  assert.deepEqual(index.query(bounds), [c,b,a]);
}

// A foreground viewport can draw and pick the whole project while its grid is prepared.
const work = new Map();
let workId = 0;
const previousIdle = globalThis.AtriumIdle;
globalThis.AtriumIdle = {idle(fn) {work.set(++workId,fn);return workId;},cancel(id) {work.delete(id);}};
try {
  const artwork = [];
  const context = new Proxy({}, {get:(target,key)=>target[key] ?? ((...args)=>artwork.push([key,...args]))});
  const canvas = {isConnected:true,getContext:()=>context,getBoundingClientRect:()=>({width:800,height:600})};
  const board = offset => ({kind:"pcb",grid:.25,origin:[0,0],items:Array.from({length:1200},(_,id)=>({
    id,kind:"track",layer:"Top",width:.2,points:[[id+offset,0],[id+offset+.5,0]]
  }))});
  const a = board(0), b = board(2000), viewport = AtriumCanvas.create(canvas);
  viewport.onRepaint(()=>{});
  viewport.fit(a,defs);viewport.render(a,defs,{grid:false,origin:false});
  const I = viewport.internals(), first = I.cache;
  const runSlice = (ms = 0) => {
    const [id,run] = work.entries().next().value;work.delete(id);
    run({timeRemaining:()=>ms});
  };
  const area = [0,0,1,0], point = [.3,0];
  assert.equal(viewport.hit(a,defs,point),a.items[0]);
  assert.equal(first.index,null);
  runSlice();
  assert.ok(first.preparation.next > 0 && first.preparation.next < a.items.length);
  a.items[0].points = [[-10,0],[-9.5,0]];
  viewport.invalidate(a,[a.items[0]]);
  const before = viewport.query(a,defs,area);
  artwork.length=0;
  viewport.render(a,defs,{grid:false,origin:false});
  const firstArtwork=artwork.splice(0);
  while(work.size)runSlice(99);
  assert.ok(first.index);
  assert.deepEqual(viewport.query(a,defs,area),before);
  assert.equal(viewport.hit(a,defs,[-9.8,0]),a.items[0]);
  viewport.render(a,defs,{grid:false,origin:false});
  assert.deepEqual(artwork,firstArtwork,"preparing the grid preserves the complete board artwork");

  viewport.invalidate(a);
  viewport.render(a,defs,{grid:false,origin:false});
  const leaving = I.cache, stale = work.values().next().value;
  viewport.fit(b,defs);viewport.render(b,defs,{grid:false,origin:false});
  stale({timeRemaining:()=>99}); // Worst case: an already dispatched callback after a project switch.
  assert.equal(leaving.index,null);
  assert.equal(I.cache.doc,b);
  assert.equal(viewport.hit(b,defs,[2000.3,0]),b.items[0]);
  assert.deepEqual(viewport.query(b,defs,area),[]);
  viewport.onRepaint(null);
  assert.equal(work.size,0,"a closed pane cancels its unfinished grid");
} finally { globalThis.AtriumIdle = previousIdle; }

// Compare unjournaled edits and Undo with a new exact canvas while idle preparation is held.
require("../../app/history/undo-store.js");
{
  const U = AtriumUndoStore, previous = globalThis.AtriumIdle, jobs = new Map();
  let id = 0;
  globalThis.AtriumIdle = {idle(fn) {jobs.set(++id, fn); return id;}, cancel(job) {jobs.delete(job);}};
  function canvasView() {
    const artwork = [];
    const ctx = new Proxy({}, {get:(target, key)=>target[key] ?? ((...args)=>artwork.push([key,...args]))});
    const view = AtriumCanvas.create({isConnected:true,getContext:()=>ctx,getBoundingClientRect:()=>({width:800,height:600})});
    view.restoreCamera({cx:4,cy:3,scale:20,referenceScale:20});
    return {view,artwork};
  }
  try {
    U.reset();
    const history = [], future = [], board = Atrium.sheet("pcb", "Early board edit");
    const graphic = (id, x, layer) => ({id,kind:"graphic",layer,width:.2,points:[[x,1],[x+.5,1]]});
    const first = graphic("a", 1, "Mechanical 15"), second = graphic("b", 3, "Mechanical");
    const last = graphic("c", 5, "Mechanical 15");
    board.items = [first,second,...Array.from({length:1197},(_,n)=>graphic("filler-"+n,40+n,"Silk")),last];
    const model = {documents:[board],library:[]}, original = JSON.stringify(model);
    U.mark(model);
    const prepared = canvasView(), opts = {grid:false,origin:false,layer:"Top"};
    prepared.view.onRepaint(()=>{});
    prepared.view.render(board,defs,opts);
    assert.equal(prepared.view.internals().cache.prints.size,0,"opening defers item snapshots");
    const [sliceId,slice] = Array.from(jobs).at(-1);
    jobs.delete(sliceId);
    slice({timeRemaining:()=>0});
    const opening = prepared.view.internals().cache;
    assert.ok(opening.preparation.next > 0 && opening.preparation.next < board.items.length);
    assert.equal(prepared.view.hit(board,defs,[5.25,1],opts),last,"picking includes an item outside the partial index");
    const compare = label => {
      const oracle = canvasView();
      prepared.artwork.length = 0;
      prepared.view.render(board,defs,opts);
      oracle.view.render(board,defs,opts);
      assert.deepEqual(prepared.artwork,oracle.artwork,label+" draws identical artwork");
      const internals = prepared.view.internals(), exact = oracle.view.internals();
      assert.deepEqual(internals.paintOrder(board,defs,opts),exact.paintOrder(board,defs,opts),label+" preserves layer order");
      assert.deepEqual(internals.cache.boxes,exact.cache.boxes,label+" resolves every geometry bound");
      assert.deepEqual(prepared.view.query(board,defs,[0,0,12,2]),oracle.view.query(board,defs,[0,0,12,2]),label+" preserves object order");
      for (const x of [1,3,5,7,9,11]) {
        assert.equal(prepared.view.hit(board,defs,[x,1],opts),oracle.view.hit(board,defs,[x,1],opts),label+" picks exact geometry at "+x);
        assert.deepEqual(prepared.view.snapPoint(board,defs,[x+.25,1.1],opts),oracle.view.snapPoint(board,defs,[x+.25,1.1],opts));
      }
    };
    const change = (label, mutate) => {
      const before = U.mark(model);
      mutate();
      U.checkpoint(history,future,before,label);
      U.touch(model);
      assert.equal(U.recordedChanges(board,opening.seq).ids,null,"the test holds the journal open");
      AtriumCanvas.edited(false);
      compare(label);
    };
    const stale = Array.from(jobs.values()).at(-1), openingProgress = opening.preparation.next;
    change("modify unprepared geometry",()=>{last.points = [[7,1],[7.5,1]];});
    const afterFirst = JSON.stringify(model), firstEditedCache = prepared.view.internals().cache;
    stale({timeRemaining:()=>99});
    assert.equal(opening.preparation.next,openingProgress,"the discarded preparation cannot resume after an unknown edit");
    assert.equal(firstEditedCache.index,null,"the fallback keeps the grid lazy");
    change("modify previously indexed geometry",()=>{first.points = [[9,1],[9.5,1]];});
    assert.ok(prepared.view.internals().cache===firstEditedCache,"another unknown edit retains the geometry cache");
    change("reorder an unchanged object in place",()=>{board.items.splice(0,1);board.items.splice(2,0,first);});
    assert.ok(U.jump(history,future,U.mark(model),-2));
    AtriumCanvas.edited(false);
    assert.equal(JSON.stringify(U.root()),afterFirst,"Undo restores the complete project state");
    assert.equal(prepared.view.hit(board,defs,[1.25,1],opts),first,"Undo immediately restores direct picking");
    compare("undo two unscoped edits");
    assert.ok(U.jump(history,future,U.mark(model),-1));
    AtriumCanvas.edited(false);
    assert.equal(JSON.stringify(U.root()),original);
    assert.equal(prepared.view.hit(board,defs,[5.25,1],opts),last,"the final Undo immediately restores picking");
    compare("undo the initial edit");
    prepared.view.onRepaint(null);
  } finally {
    U.reset();
    globalThis.AtriumIdle = previous;
  }
}

// An enabled ratsnest has no lines on unassigned copper. The inspector must still find real contacts.
require("../../app/checks/connectivity.js");
const physical = AtriumConnectivity;
let inspections = 0;
globalThis.AtriumConnectivity = {...physical, inspect(...args) { inspections++; return physical.inspect(...args); }};
try {
  const diagram = {kind:"pcb",id:"wires",items:[
    {kind:"track",id:"track-a",layer:"Top",width:.25,points:[[0,0],[2,0]]},
    {kind:"track",id:"track-b",layer:"Top",width:.25,points:[[2,0],[4,0]]},
    {kind:"track",id:"track-c",layer:"Top",width:.25,points:[[8,0],[9,0]]},
  ]};
  const v = AtriumCanvas.create({getContext:() => ({})}), I = v.internals(), index = new Map();
  const overlay = () => I.airwireConnectivity(diagram,index);
  assert.equal(overlay(),null);
  assert.equal(inspections,0);
  const explicit = v.boardConnectivity(diagram,index);
  assert.equal(inspections,1);
  assert.equal(explicit.unassigned,3);
  assert.ok(explicit.stats.contacts>0);
  diagram.items[0].net = diagram.items[2].net = "LINK";
  v.invalidate(diagram,[diagram.items[0],diagram.items[2]]);
  assert.equal(overlay().airwires.length,1);
  assert.equal(inspections,2);
  delete diagram.items[0].net; delete diagram.items[2].net;
  v.invalidate(diagram,[diagram.items[0],diagram.items[2]]);
  assert.equal(overlay(),null);
  assert.equal(inspections,2);
  assert.equal(I.connectivity,null,"release the previously named physical graph after its last assignment is removed");

  for (const source of ["pinNets","pad","shape"]) {
    const footprint = {pads:[{number:"1",x:0,y:0,w:1,h:1,shape:"rect",layer:"Top"}],shapes:[]};
    const part = {id:"device",kind:"part",x:10,y:0,ref:"U1",def:"library"};
    if (source === "pinNets") part.pinNets = {"1":"LINK"};
    if (source === "pad") footprint.pads[0].net = "LINK";
    if (source === "shape") footprint.shapes.push({kind:"path",layer:"Top",width:.2,points:[[0,0],[1,0]],net:"LINK"});
    const doc = {id:source,kind:"pcb",items:[{...diagram.items[0],net:"LINK"},part]};
    const defs = new Map([["library",{footprint}]]);
    const onlyPart = {...doc,items:[part]};
    if (source === "pad") {
      const unassigned = new Map([["library",{footprint:{...footprint,pads:footprint.pads.map(({net,...pad})=>pad)}}]]);
      assert.equal(I.airwireConnectivity(onlyPart,unassigned),null);
      assert.ok(I.airwireConnectivity(onlyPart,defs),"assigning a library pad invalidates empty overlay evidence");
      assert.equal(I.airwireConnectivity(onlyPart,unassigned),null,"returning to the old library releases the named graph");
    }
    assert.ok(I.airwireConnectivity(onlyPart,defs),"a placed " + source + " is an airwire source");
    assert.deepEqual(I.airwireConnectivity(doc,defs).airwires,physical.inspectFull(doc,defs).airwires);
    assert.equal(I.airwireConnectivity(doc,defs).airwires.length,1);
  }
} finally { globalThis.AtriumConnectivity = physical; }

// The layer order drives retained 2D repaints and GPU compositing. Pin the
// first visible encounter for tied ranks and compare it with full drawing.
require("../../app/pcb/pcb-pours.js");
require("../../app/canvas/canvas-board-batches.js");
{
  const previousPath = globalThis.Path2D;
  globalThis.Path2D = class {
    moveTo() {}
    lineTo() {}
  };
  try {
    const ctx = new Proxy({globalAlpha:1}, {get:(target,key)=>target[key] ?? (()=>{})});
    const canvas = {getContext:()=>ctx,getBoundingClientRect:()=>({width:460,height:396})};
    const boardView = AtriumCanvas.create(canvas), I = boardView.internals();
    boardView.restoreCamera({cx:10,cy:10,scale:10,referenceScale:10});
    boardView.resized();
    const stroke = (id,layer) => ({id,kind:"graphic",layer,width:.3,points:[[2,4],[4,6]]});
    const first = stroke("first","Mechanical 15"), second = stroke("second","Mechanical");
    const later = stroke("later",first.layer);
    const track = {...stroke("track","Top"),kind:"track",maskExpansion:.1,pasteExpansion:.2};
    const part = {id:"part",kind:"part",def:"footprint",x:9,y:8,ref:"R1",value:"10k",
      boardLabels:[{field:"ref",layer:"Placed legend",at:[0,2],angle:0,size:1}]};
    const layout = new Map([[part.def,{footprint:{
      shapes:[{kind:"text",layer:"Footprint text",text:"R",x:0,y:1,size:1},
        {...stroke("cutout","Footprint cutout"),cutout:true}],
      pads:[{number:"1",x:0,y:0,w:1,h:1,shape:"rect",layer:"Inner 2"}],
    }}]]);
    const region = (layer,x) => AtriumPCBPours.region([[[x,1],[x+5,1],[x+5,5],[x,5]]],layer,"GND");
    const board = Atrium.sheet("pcb","Artwork order");
    board.items = [first,second,later,track,part];
    board.pcbDrawing = {pours:[region("Source plane",2),region("Offscreen plane",100)]};
    board.sourcePourSignature = AtriumPCBPours.signature(board,layout);
    const opts = {layer:"Top",grid:false,origin:false};
    const retained = ["Footprint text","Footprint cutout","Placed legend"];
    const copper = ["Inner 2","Top","Top mask","Top paste"];
    function check(name, options, expected, batched = false) {
      const drawing = {...opts,...options}, layers = [];
      const order = I.paintOrder(board,layout,drawing);
      I.paint(board,layout,{...drawing,recordLayer:layer=>{if(layer!==null)layers.push(layer);}},null,true);
      assert.deepEqual(order,expected,name);
      assert.deepEqual(layers,expected,name+" matches the full paint");
      assert.equal(I.lodUsed,batched,name+" uses the expected draw path");
    }
    check("tied custom layers",{},["Source plane",first.layer,second.layer,...retained,...copper]);
    const world=Atrium.world;
    let labelTransforms=0;
    Atrium.world=(point,frame)=>{
      if(frame===part && point[0]===0 && point[1]===2)labelTransforms++;
      return world(point,frame);
    };
    try {
      assert.ok(I.paintOrder(board,layout,opts).includes("Placed legend"));
      assert.ok(I.paintLayers(board,layout,part).includes("Placed legend"));
      assert.equal(labelTransforms,0,"ordering layers and finding changed layers do not place board lettering");
      I.paint(board,layout,opts,null,true);
      assert.ok(labelTransforms>0,"the full painter still positions the same label");
    } finally {Atrium.world=world;}
    check("route hides the first occurrence",{routePreview:{hidden:[first.id]}},
      ["Source plane",second.layer,first.layer,...retained,...copper]);
    check("hidden layers and source pours",{hidden:new Set([first.layer,"Source pours","Top mask"])},
      [second.layer,...retained,"Inner 2","Top","Top paste"]);
    check("GPU retains text, cutouts and source copper",{gpu:i=>i===track,selected:part.id},
      ["Source plane",first.layer,second.layer,...retained]);

    boardView.restoreCamera({...boardView.camera(),flipped:true});
    check("flipped dimmed copper",{layerMode:"dim"},
      ["Source plane",first.layer,second.layer,...retained,"Inner 2","Top mask","Top paste","Top"]);
    boardView.restoreCamera({...boardView.camera(),flipped:false});
    I.lodForce = true;
    check("selected artwork and tied batch layers",{selectedIds:new Set([later.id,part.id])},
      ["Source plane",first.layer,...retained,second.layer,...copper],true);

    // A change to one overlapping batch must keep tied layers in fresh encounter order.
    const idle = globalThis.AtriumIdle;
    globalThis.AtriumIdle = {idle:()=>1,cancel:()=>{}};
    try {
      const edited = Atrium.sheet("pcb","Overlapping batched layers");
      const a = stroke("a","Mechanical 15"), b = stroke("b","Mechanical"), c = stroke("c",a.layer);
      const filler = Array.from({length:1500},(_,n)=>({...stroke("filler-"+n,"Silk"),points:[[12+n/30,4],[12.2+n/30,4]]}));
      edited.items = [a,b,c,...filler];
      function panel(prepare) {
        const ink = [];
        const context = new Proxy({globalAlpha:1,stroke(){ink.push(this.strokeStyle);}}, {get:(target,key)=>target[key] ?? (()=>{})});
        const view = AtriumCanvas.create({isConnected:true,getContext:()=>context,getBoundingClientRect:()=>({width:800,height:600})});
        view.internals().lodForce=true;
        if(prepare)view.onRepaint(()=>{});
        view.restoreCamera({cx:25,cy:7,scale:12,referenceScale:12});
        return {view,ink};
      }
      const staged = panel(true);
      staged.view.render(edited,defs,opts);
      assert.ok(staged.view.internals().lodUsed);
      a.points[1][0] += .01;
      AtriumCanvas.edited(false);
      staged.view.render(edited,defs,opts);
      const close = (label,mutate) => {
        mutate();
        AtriumCanvas.edited(false);
        staged.ink.length=0;
        staged.view.render(edited,defs,opts);
        const fresh = panel(false);
        fresh.view.render(edited,defs,opts);
        assert.deepEqual(staged.view.internals().orderUsed,fresh.view.internals().orderUsed,label+" preserves layer order");
        assert.deepEqual(staged.ink,fresh.ink,label+" presents stroke colors in the same order");
      };
      close("change a tied batch layer",()=>{a.layer="Board";});
      close("move the first batch to another chunk",()=>{a.points=[[25,4],[26,6]];});
      staged.view.onRepaint(null);
    } finally {
      globalThis.AtriumIdle = idle;
    }
  } finally {
    globalThis.Path2D = previousPath;
  }
}
console.log("PASS whole-board spatial indexing, physical airwire overlays and PCB layer order");
