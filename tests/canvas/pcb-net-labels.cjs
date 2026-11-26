"use strict";
// Net names on tracks and pours (app/canvas/pcb-net-labels.js through canvas.js paintTop): placed for the view,
// repeated along long tracks, kept on screen while panning, hidden when too small, upright, and drawn.
const assert = require("node:assert/strict");
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {value: {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)}, configurable: true, writable: true});
for (const m of ["model", "spatial", "connectivity", "pcb-appearance", "pcb-pours", "canvas", "pcb-net-labels"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
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
    assert.equal(walks,1,"an intersecting width group retains the exact item query");
    assert.equal(scans,warmed+1,"a track move rebuilds the width summary");
    short.kind="part";short.x=0;short.y=5;short.def="fixture";
    const shortPoints=short.points;
    delete short.points;
    try {
      view.invalidate(board,[short]);
      assert.ok(overlay().some(label=>label.text==="VBUS"),"a track converted to a part cannot hide another track label");
      assert.equal(scans,warmed+1,"the old track bounds are still conservative");
    } finally {
      short.kind="track";short.points=shortPoints;
      delete short.x;delete short.y;delete short.def;
      view.invalidate(board,[short]);
    }
    long.points=points;
    view.invalidate(board,[long]);
    assert.deepEqual(overlay(),[]);
    assert.equal(walks,2,"moving the track back retires the changed extents");
    assert.equal(scans,warmed+2,"the unseen revision is incorporated on the new walk");
  } finally {
    long.points=points;
    via.x=3;
    view.invalidate(board,[long,via]);
    delete items[Symbol.iterator];
    grid.query=query;
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
