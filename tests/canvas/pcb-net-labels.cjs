"use strict";
// Net names on tracks and pours (app/canvas/pcb-net-labels.js through canvas.js paintTop): placed for the view,
// repeated along long tracks, kept on screen while panning, hidden when too small, upright, and drawn.
const assert = require("node:assert/strict");
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {value: {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)}, configurable: true, writable: true});
for (const m of ["model", "spatial", "connectivity", "pcb-appearance", "pcb-pours", "canvas-input", "canvas", "pcb-net-labels"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const N = AtriumPCBNetLabels, PCB = AtriumPCBAppearance;

function recorder() {
  const texts = [], stack = [];
  const target = {
    fillText(t, x, y) { texts.push({text: t, ink: this.fillStyle, font: this.font, x, y}); },
    save() { stack.push([this.fillStyle, this.font]); }, restore() { [this.fillStyle, this.font] = stack.pop(); }
  };
  return {texts, ctx: new Proxy(target, {get: (o, k) => o[k] ?? (() => {}), set: (o, k, v) => { o[k] = v; return true; }})};
}
const {texts, ctx} = recorder(), W = 800, H = 600;
const view = AtriumCanvas.create({getContext: () => ctx, getBoundingClientRect: () => ({width: W, height: H})});
const board = Atrium.sheet("pcb", "Labels");
board.outline = [[-60, -30], [60, -30], [60, 30], [-60, 30]];
// A long horizontal track (120 mm), a short one, a narrow one, a diagonal one heading left and down, and a Bottom track.
const long = {id: "long", kind: "track", layer: "Top", width: .5, net: "VBUS", points: [[-58, 0], [58, 0]]};
const short = {id: "short", kind: "track", layer: "Top", width: .5, net: "SHORT", points: [[0, 5], [.6, 5]]};
const thin = {id: "thin", kind: "track", layer: "Top", width: .05, net: "THIN", points: [[-50, 10], [50, 10]]};
const diag = {id: "diag", kind: "track", layer: "Top", width: .5, net: "DIAG", points: [[20, -20], [-20, -8]]};
const under = {id: "under", kind: "track", layer: "Bottom", width: .5, net: "BACK", points: [[-50, -4], [50, -4]]};
const via = {id:"via",kind:"via",x:3,y:4,diameter:.8,drill:.4,layer:"Multi"};
board.items = [long, short, thin, diag, under, via];
const cam = c => view.restoreCamera({...view.camera(), ...c, referenceScale: view.fitScale()});
function render(opts = {}) { texts.length = 0; view.render(board, new Map(), {grid: false, origin: false, layer: "Top", ...opts}); return view.internals().netLabels(); }
const onScreen = l => l.x >= 0 && l.x <= W && l.y >= 0 && l.y <= H;

// Fit: 120 mm across 800 px is under 7 px/mm, so a 0.5 mm track is about 3 px wide: no labels.
view.fit(board, new Map());
assert.equal(render().length, 0, "no labels on tracks too narrow on screen");
assert.equal(texts.length, 0);

// Zoom in (40 px/mm): a 0.5 mm track is 20 px wide; text fits inside it.
cam({cx: 0, cy: 0, scale: 40});
let labels = render();
const of = net => labels.filter(l => l.text === net);
assert.ok(of("VBUS").length >= 1, "the long track is labelled");
assert.ok(of("VBUS").every(onScreen), "its labels are in the view");
assert.ok(of("VBUS").every(l => Math.abs(l.y - H / 2) < 1 && l.angle === 0), "along the track, centred on it");
assert.ok(of("VBUS").every(l => l.size <= 20 * .62 + 1e-9 && l.size >= N.MIN_PX), "sized to the track width");
assert.equal(of("SHORT").length, 0, "a segment too short for its name is not labelled");
assert.equal(of("THIN").length, 0, "a track too narrow for legible text is not labelled");
assert.equal(of("BACK").length, 0, "only the current copper layer is labelled");
for (const l of of("DIAG")) assert.ok(l.angle > -Math.PI / 2 && l.angle <= Math.PI / 2, "never upside down");
assert.ok(texts.some(t => t.text === "VBUS"), "the labels are drawn");
const vbus = texts.find(t => t.text === "VBUS");
assert.equal(vbus.ink, PCB.system.padText, "the pad-caption ink on red copper, as pads");
assert.match(vbus.font, /px/);

// Pan along the long track, far from its middle: a label is still in view.
for (const cx of [-50, -33.3, -12.7, 21.1, 44, 55.5]) {
  cam({cx, cy: 0, scale: 40});
  labels = render();
  assert.ok(of("VBUS").some(onScreen), "a VBUS label stays in view at x = " + cx);
}
// Panned so the track passes through a corner of the view only: the label sits within the visible part.
cam({cx: 0, cy: 7.2, scale: 40});
labels = render();
assert.ok(of("VBUS").length && of("VBUS").every(onScreen), "the label moves onto the visible part of the track");
// Repeats: wide view of a long track shows several, at a world spacing, which pans with the board.
cam({cx: 0, cy: 0, scale: 25});
labels = render();
const xs = of("VBUS").map(l => l.x).sort((a, b) => a - b);
assert.ok(xs.length >= 2, "a long track repeats its name (" + xs.length + ")");
for (let k = 1; k < xs.length; k++) assert.ok(xs[k] - xs[k - 1] >= 300, "repeats are spread out");
cam({cx: 1, cy: 0, scale: 25});
const moved = render().filter(l => l.text === "VBUS").map(l => l.x).sort((a, b) => a - b);
const inner = xs.filter(x => x > 120 && x < W - 120);
for (const x of inner) assert.ok(moved.some(m => Math.abs(m - (x - 25)) < .01), "anchored labels move with the board");
// Labels never overlap one another.
const boxes = labels.map(l => [l.x - l.text.length * .3 * l.size, l.x + l.text.length * .3 * l.size, l.y - l.size / 2, l.y + l.size / 2]);
for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
  const p = boxes[a], q = boxes[b];
  if (labels[a].angle || labels[b].angle) continue;
  assert.ok(!(p[0] < q[1] && p[1] > q[0] && p[2] < q[3] && p[3] > q[2]), "labels do not overlap");
}
// Bottom current: the Bottom track's name instead.
cam({cx: 0, cy: 0, scale: 40});
labels = render({layer: "Bottom"});
assert.ok(of("BACK").length && !of("VBUS").length, "the current layer's tracks");
// Off: the option and hidden layers.
assert.equal(render({netNames: false}).length, 0);
assert.equal(render({hidden: new Set(["Top"])}).length, 0);
{
  const I=view.internals();
  let poursRead=0, tracksRead=0;
  const frame={get pours(){ poursRead++; return []; }};
  const overlay=opts=>{
    I.paintTop(board,I.cache.defs,opts,null,true,true,undefined,null,frame);
    return I.netLabels();
  };
  globalThis.AtriumPCBNetLabels={...N,trackCandidates(...args){ tracksRead++; return N.trackCandidates(...args); }};
  try {
    for(const opts of [{netNames:false},{layer:"Mechanical 1"},{layer:"Top",hidden:new Set(["Top"])},{layer:"Top",visibleLayers:["Bottom"]}]){
      assert.deepEqual(overlay(opts),[]);
      assert.deepEqual([poursRead,tracksRead],[0,0],"a layer that cannot show net labels never prepares their geometry");
    }
    assert.ok(overlay({layer:"Top"}).some(l=>l.text==="VBUS"),"showing the layer restores its labels");
    assert.deepEqual([poursRead,tracksRead],[1,1]);
  } finally { globalThis.AtriumPCBNetLabels=N; }
}
// Selected track: text contrasts with the selection colour.
labels = render({selected: "long"});
assert.equal(texts.find(t => t.text === "VBUS").ink, "#000000", "dark text on the white selection");

// Pours: a label at an interior point in view, not at the region's middle.
{
  const rings = [[[-40, -25], [40, -25], [40, 25], [-40, 25]], [[-5, -5], [5, -5], [5, 5], [-5, 5]]];
  const region = AtriumPCBPours.region(rings, "Top", "GND");
  const pours = [region];
  const v = {items: [], pours, scale: 40, width: W, height: H, PCB, opts: {layer: "Top"}, maxWidth: 0, trackInk: () => "#ff0000", pourInk: () => "#ff0000"};
  const at = (cx, cy) => {
    const toScreen = p => [(p[0] - cx) * 40 + W / 2, (p[1] - cy) * 40 + H / 2];
    return N.place({...v, toScreen, view: [cx - W / 80, cy - H / 80, cx + W / 80, cy + H / 80]});
  };
  // View centred on the hole in the pour: the label is placed on copper beside it, in view.
  let got = at(0, 0);
  assert.ok(got.length >= 1 && got.every(l => l.kind === "pour" && l.text === "GND" && onScreen(l)), "pour labelled in view");
  for (const l of got) {
    const wx = (l.x - W / 2) / 40, wy = (l.y - H / 2) / 40;
    assert.ok(Math.abs(wx) > 5 || Math.abs(wy) > 5, "not over the void");
  }
  // Panned near a corner of the pour, far from its middle.
  got = at(36, 21);
  assert.ok(got.length >= 1 && got.every(onScreen), "pour labelled near its corner");
  assert.ok(got.length <= 4, "sparse");
  // Zoomed out so the pour is small on screen: none.
  const tiny = N.place({...v, scale: 2, toScreen: p => [p[0] * 2 + W / 2, p[1] * 2 + H / 2], view: [-200, -150, 200, 150]});
  assert.ok(tiny.length <= 1);
}
{
  const rect = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  const region = (box, layer="Top", net="GND") => AtriumPCBPours.region([rect(...box)],layer,net);
  const wrongLayer=region([-40,-25,40,25],"Bottom"), noNet=region([-40,-25,40,25],"Top",""),
    distant=region([200,80,240,120]), tiny=region([-1,-1,0,1]);
  const noCopperInView=AtriumPCBPours.region([rect(-40,-25,40,25),rect(-20,-15,20,15)],"Top","GND");
  const pours=[wrongLayer,noNet,distant,tiny,noCopperInView];
  let calls=0;
  const input={items:[],pours,scale:40,width:W,height:H,PCB,opts:{layer:"Top"},maxWidth:0,
    toScreen:([x,y])=>[W/2+x*40,H/2+y*40],view:[-10,-7.5,10,7.5],pourInk:()=>"#ff0000",
    obstacles:()=>{calls++;return [];}};
  assert.deepEqual(N.place(input),[]);
  assert.equal(calls,0,"nothing eligible reaches the part-obstacle lookup");
  const left=region([-30,-20,-.1,20]),right=region([.1,-20,30,20],"Top","VCC");
  input.pours=[...pours,left,right];
  const unblocked=N.place(input);
  assert.equal(calls,1,"several eligible pours share a single obstacle read");
  assert.deepEqual([...new Set(unblocked.map(l=>l.text))],["GND","VCC"],"pour order is preserved");
  const [first]=unblocked, blocker=[first.x-30,first.y-10,first.x+30,first.y+10];
  const blocked=N.place({...input,obstacles:()=>{calls++;return [blocker];}});
  assert.equal(calls,2);
  assert.ok(blocked.length && !blocked.some(l=>l.x===first.x&&l.y===first.y),"part bodies still exclude a viable label");
  assert.deepEqual(N.place({...input,opts:{layer:"Top",hidden:new Set(["Source pours"])}}),[]);
  assert.equal(calls,2,"hidden source pours need no part obstacles");

  // The retained GPU overlay does not provide a full artwork query. Reproduce its
  // paintTop entry point at a scale where no track can carry a name.
  const I=view.internals(), grid=I.cache.index, query=grid.query;
  const walks=[];
  grid.query=box=>{walks.push(box);return query(box);};
  try {
    cam({cx:16,cy:0,scale:6});
    const overlay=pours=>{
      texts.length=0;
      I.paintTop(board,I.cache.defs,{layer:"Top"},null,true,true,undefined,null,{pours});
      return I.netLabels();
    };
    assert.deepEqual(overlay([wrongLayer,distant]),[]);
    assert.equal(walks.length,0,"an offscreen active-layer pour cannot force a full spatial query during pan");
    const shown=overlay([wrongLayer,region([-40,-30,50,30])]);
    assert.ok(shown.some(l=>l.kind==="pour"));
    assert.ok(walks.length && walks.every(([x0,y0,x1,y1])=>x1-x0<10 && y1-y0<5),
      "visible pour names query only the world space occupied by each candidate label");
    assert.deepEqual(texts.map(({text,x,y})=>({text,x,y})),shown.map(({text,x,y})=>({text,x,y})),"the label order and placement reach the canvas");
  } finally { grid.query=query; }
}
{
  // A wide track elsewhere on the board cannot force a viewport query.
  const I=view.internals(), defs=I.cache.defs, grid=I.cache.index, query=grid.query;
  const items=I.cache.all, iterate=items[Symbol.iterator];
  let walks=0, scans=0;
  grid.query=box=>{walks++;return query(box);};
  items[Symbol.iterator]=function(){scans++;return iterate.call(this);};
  const overlay=()=>{
    I.paintTop(board,defs,{layer:"Top"},null,true,true,undefined,null,{pours:[]});
    return I.netLabels();
  };
  const points=long.points;
  try {
    cam({cx:200,cy:200,scale:40});
    assert.deepEqual(overlay(),[]);
    assert.equal(walks,0,"a legible but offscreen track needs no full item query");
    const warmed=scans;
    via.x+=.15;
    view.invalidate(board,[via]);
    assert.deepEqual(overlay(),[]);
    assert.equal(scans,warmed,"a known via move keeps the width summary");
    long.points=[[185,200],[215,200]];
    view.invalidate(board,[long]);
    assert.ok(overlay().some(label=>label.text==="VBUS"),"a geometry edit updates cached track extents");
    assert.equal(walks,0,"a small intersecting width group bypasses the viewport query");
    assert.equal(scans,warmed,"moving an indexed sparse track only updates its own width group");
    short.kind="part";short.x=0;short.y=5;short.def="fixture";
    const shortPoints=short.points;
    delete short.points;
    try {
      view.invalidate(board,[short]);
      assert.ok(overlay().some(label=>label.text==="VBUS"),"a track converted to a part cannot hide another track label");
      assert.equal(scans,warmed,"the old track bounds are still conservative");
    } finally {
      short.kind="track";short.points=shortPoints;
      delete short.x;delete short.y;delete short.def;
      view.invalidate(board,[short]);
    }
    long.points=points;
    view.invalidate(board,[long]);
    assert.deepEqual(overlay(),[]);
    assert.equal(walks,0,"moving the track back retires the changed extents without querying");
    assert.equal(scans,warmed+1,"the unseen revision is incorporated on the new walk");
  } finally {
    long.points=points;
    via.x=3;
    view.invalidate(board,[long,via]);
    delete items[Symbol.iterator];
    grid.query=query;
  }
}
{
  // The sparse route must place and paint the same visible labels as spatial query order.
  const doc=Atrium.sheet("pcb","Sparse track net captions"), defs=new Map(), I=view.internals();
  const a={...long,id:"a",net:"FIRST",points:[[-35,0],[35,0]]};
  const b={...a,id:"b",net:"OTHER"};
  const arc={...a,id:"arc",net:"ARC",width:2,points:[[30,0],[-30,0]],
    arc:{kind:"arc",c:[0,0],r:30,start:0,end:180,ccw:true}};
  assert.ok(Atrium.pathArc(arc));
  doc.items=[a,b,arc];
  const frame={pours:[]}, opts={layer:"Top"};
  const paint=(more={})=>{
    texts.length=0;
    I.paintTop(doc,defs,{...opts,...more},null,true,true,undefined,null,frame);
    return {labels:I.netLabels(),ink:texts.slice()};
  };
  const forcedQuery={...N,trackCandidates(...args){
    return {...N.trackCandidates(...args),tracks:null};
  }};
  for(const [flipped,rotation] of [[false,0],[true,0],[false,.4],[true,-.4]]){
    cam({cx:0,cy:0,flipped,rotation,scale:30});
    const sparse=paint();
    assert.deepEqual([...new Set(sparse.labels.map(l=>l.text))],["FIRST"]);
    assert.deepEqual([...new Set(paint({hide:new Set([a])}).labels.map(l=>l.text))],["OTHER"]);
    assert.deepEqual([...new Set(paint({routePreview:{hidden:[a.id]}}).labels.map(l=>l.text))],["OTHER"]);
    try {
      globalThis.AtriumPCBNetLabels=forcedQuery;
      assert.deepEqual(paint(),sparse,"same ordered labels, angles, fonts, ink and positions as the ordinary query");
    } finally { globalThis.AtriumPCBNetLabels=N; }
  }
  cam({cx:0,cy:0,flipped:false,rotation:0,scale:30});
  // Compare captures after each edit with a newly built width index and the ordinary viewport query.
  const freshQuery={...N,trackCandidates(scene,...args){
    return {...N.trackCandidates({...scene},...args),tracks:null};
  }};
  function compareEdit(change,items,opts={}) {
    change(); view.invalidate(doc,items);
    const incremental=paint(opts);
    try {
      globalThis.AtriumPCBNetLabels=freshQuery;
      assert.deepEqual(incremental,paint(opts));
    } finally { globalThis.AtriumPCBNetLabels=N; }
    return incremental.labels.map(l=>l.text);
  }
  const original=a.points;
  const outside=[[95,0],[110,0]];
  assert.ok(compareEdit(()=>{a.points=outside;},[a]).includes("OTHER"));
  assert.ok(compareEdit(()=>{a.points=original;},[a]).includes("FIRST"));
  assert.deepEqual(compareEdit(()=>{a.points=outside;b.points=outside;},[a,b]),[]);
  assert.ok(compareEdit(()=>{a.points=original;b.points=original;},[a,b]).includes("FIRST"));
  assert.ok(compareEdit(()=>{a.layer="Bottom";},[a],{layer:"Bottom"}).includes("FIRST"));
  assert.ok(compareEdit(()=>{a.layer="Top";a.width=.01;},[a]).includes("OTHER"));
  assert.ok(compareEdit(()=>{a.width=b.width;},[a]).includes("FIRST"));
  assert.ok(compareEdit(()=>{a.net="";},[a]).includes("OTHER"));
  assert.ok(compareEdit(()=>{a.net="FIRST";},[a]).includes("FIRST"));
  doc.items=[b,a,arc];
  assert.deepEqual([...new Set(paint().labels.map(l=>l.text))],["OTHER"],"reordering tied widths preserves document paint order");
  doc.items=[a,b,arc];
  assert.deepEqual([...new Set(paint().labels.map(l=>l.text))],["FIRST"]);
  a.kind="part"; a.x=0; a.y=0;
  view.invalidate(doc,[a]);
  assert.deepEqual([...new Set(paint().labels.map(l=>l.text))],["OTHER"],"an in-place kind change cannot reintroduce a cached track");

  for(const id of ["duplicate",undefined]){
    doc.items=[{...b,id,net:"FIRST"},{...b,id}];
    const sparse=paint();
    assert.deepEqual([...new Set(sparse.labels.map(l=>l.text))],["FIRST"],"IDs do not define the geometry membership or tie order");
    try {
      globalThis.AtriumPCBNetLabels=forcedQuery;
      assert.deepEqual(paint(),sparse);
    } finally { globalThis.AtriumPCBNetLabels=N; }
  }

  const makeTracks=(n,width,offset)=>Array.from({length:n},(_,k)=>({...b,id:"dense"+(offset+k),width,
    points:[[-38,(offset+k)/2-8],[38,(offset+k)/2-8]]}));
  for(const dense of [makeTracks(2049,.5,0),[...makeTracks(1024,.5,0),...makeTracks(1025,.6,1024)]]){
    doc.items=dense;
    const scene=I.sync(doc,defs);
    assert.equal(N.trackCandidates(scene,"Top",30,[-15,-12,15,12]).tracks,null,
      "over-budget candidates in one or several widths use the ordinary query");
    assert.ok(paint().labels.length>0);
  }

  // A retained frame with enough legible tracks to exceed the old small group
  // goes straight to the bounded width lists, but the label commands stay exact.
  const direct=makeTracks(33,.5,0);
  const vias=Array.from({length:1000},(_,i)=>({kind:"via",id:"via-"+i,layer:"Multi",
    x:(i%20)/10,y:Math.floor(i/20)/10,diameter:.3,drill:.15}));
  doc.items=[...vias,...direct];
  const tint={selected:direct[15].id,hide:new Set([direct[16]])};
  view.query(doc,defs,[-15,-10,15,10]);
  const grid=I.cache.index, query=grid.query;
  const collected=[];
  try {
    grid.query=(...args)=>{const rows=query(...args);collected.push(rows);return rows;};
    const directPaint=paint(tint);
    assert.ok(directPaint.labels.length && directPaint.ink.length);
    assert.equal(collected.length,0,"usable width groups bypass the mixed viewport query");
    globalThis.AtriumPCBNetLabels=forcedQuery;
    assert.deepEqual(paint(tint),directPaint,"the filtered viewport route draws the same labels");
    assert.deepEqual(collected,[direct],"the fallback collects just the named tracks, in document order");
    grid.query=(box,ordered)=>query(box,ordered);
    assert.deepEqual(paint(tint),directPaint,"the full viewport agrees on collisions, selection and ink");
  } finally {grid.query=query;globalThis.AtriumPCBNetLabels=N;}

  const scope=I.cache, small=[2,2,3,3];
  assert.equal(N.trackCandidates(scope,"Top",30,small).tracks,null,"a tiny indexed query uses the grid");
  const unindexed={...scope,index:null};
  const create=AtriumSpatial.create;
  try {
    AtriumSpatial.create=()=>{throw Error("label eligibility cannot build a spatial grid");};
    assert.ok(Array.isArray(N.trackCandidates(unindexed,"Top",30,small).tracks));
    assert.equal(unindexed.index,null);
  } finally {AtriumSpatial.create=create;}

  const invalid={...scope,boxes:new Map(scope.boxes)};
  invalid.boxes.delete(direct[0]);
  assert.equal(N.trackCandidates(invalid,"Top",30,[-15,-10,15,10]).tracks,null,"unknown track bounds fall back");
  const textWidth={...direct[0],width:".5"};
  const malformed={...scope,all:[textWidth],boxes:new Map([[textWidth,scope.boxes.get(direct[0])]])};
  assert.equal(N.trackCandidates(malformed,"Top",30,[-15,-10,15,10]).tracks,null,"non-numeric width does not seed a group");
  const wide = [-15,-10,15,10];
  assert.deepEqual(N.trackCandidates(scope,"Top",30,wide).tracks,direct);
  I.sync({...doc,items:[]},defs);
  I.cache=scope;
  assert.equal(N.trackCandidates(scope,"Top",30,wide).tracks,null,"restoring a parked scene does not retain or regather extra track references");

  const dense = makeTracks(33,.5,0), edited = dense[16];
  edited.net="EDITED";
  doc.items=dense;
  paint();
  const scene=I.cache, all=scene.all, iterate=all[Symbol.iterator];
  let scans=0;
  all[Symbol.iterator]=function(){scans++;return iterate.call(this);};
  function denseEdit(change,expected,label) {
    change(); view.invalidate(doc,[edited]);
    const before=scans;
    const result=N.trackCandidates(scene,"Top",30,I.artworkViewport(),true);
    assert.equal(scans-before,expected,label);
    return result;
  }
  const moveTo=y=>()=>{edited.points=[[-38,y],[38,y]];};
  try {
    denseEdit(moveTo(.2),1,"first dense edit seeds from a full scan");
    const first=paint().labels.find(l=>l.id===edited.id);
    assert.ok(first);
    denseEdit(moveTo(.3),0,"repeating an interior dense edit skips the scan");
    assert.notDeepEqual(paint().labels.find(l=>l.id===edited.id),first);
    denseEdit(moveTo(.2),0,"reversing an interior dense edit skips the scan");
    assert.deepEqual(paint().labels.find(l=>l.id===edited.id),first);
    cam({cx:0,cy:50,flipped:false,rotation:0,scale:30});
    assert.equal(denseEdit(moveTo(50),0,"moving a dense extremum outward extends its bounds").maxWidth,.5);
    assert.ok(paint().labels.some(l=>l.id===edited.id),"extended bounds reveal the label");
    assert.equal(denseEdit(moveTo(.2),1,"moving a dense extremum inward rescans its peers").maxWidth,0);
    assert.deepEqual(paint().labels,[]);
    cam({cx:0,cy:0,flipped:false,rotation:0,scale:30});
    denseEdit(()=>{edited.width=.7;},1,"changing width abandons the dense witness");
    assert.ok(paint().labels.some(l=>l.id===edited.id && l.size>first.size));
    denseEdit(()=>{edited.width=.5;},1,"returning to the dense width seeds again");
    denseEdit(()=>{edited.layer="Bottom";},1,"changing layer abandons the dense witness");
    assert.ok(!paint().labels.some(l=>l.id===edited.id));
  } finally {
    delete all[Symbol.iterator];
  }

}
{
  // Several grid columns cross the same two sloped cutouts. A new row or scale needs its own intersections.
  const region = AtriumPCBPours.region([
    [[-68,-33],[68,-33],[68,33],[-68,33]],
    [[-36,-16],[-4,-16],[-10,14],[-35,14]],
    [[12,-12],[35,-12],[33,16],[8,16]]
  ],"Top","GND");
  const at = (cx,cy,scale) => N.place({items:[],pours:[region],scale,width:W,height:H,PCB,
    opts:{layer:"Top"},maxWidth:0,pourInk:()=>"#ff0000",
    view:[cx-W/2/scale,cy-H/2/scale,cx+W/2/scale,cy+H/2/scale],
    toScreen:([x,y])=>[(x-cx)*scale+W/2,(y-cy)*scale+H/2]
  }).map(({x,y})=>[x,y]);
  assert.deepEqual(at(0,0,8),[[464,236],[80,492]],"columns through different sides of a cutout retain their parity");
  assert.deepEqual(at(12,3,8),[[368,212],[752,468]],"panning keeps the newly exposed spots");
  assert.deepEqual(at(-7,6,9),[[391,462],[679,30],[103,30]],"zooming retests the changed label dimensions");
  assert.deepEqual(at(0,0,8),[[464,236],[80,492]],"returning to the original camera preserves the label order");
}
console.log("PASS net names on tracks (level of detail, repeats, pan, upright, current layer) and pours (interior points in view).");
