"use strict";
// A board just imported (unsaved, no edit yet) whose poured nets are joined only through stored source
// copper, under scoped rules (one class per net). The editor verifies the copper by itself in the background:
// every poured net stays joined with no user edit, the source copper is kept rather than repoured, and
// no frame shows an airwire on a poured net. A real break (a stitching via removed, a via moved off its pour) still shows. The full
// connectivity pass is the oracle for every published graph.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const launch = require("../support/standalone-chromium.cjs");
const APP = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;

function stitchedBoard() {
  for (const name of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "impedance",
    "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "design-query-record",
    "query", "net-intent", "signals", "rules", "viastack", "polygon-pour"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
  return require("../support/stitched-ground.cjs").board;
}

// Each case: the fixture, the break to make, and the airwires that break must show by net.
const STITCHED = [
  {name:"ground through a stitched pour", options:{imported:true},
    breaks:"remove the stitching via", cut:doc => {doc.items = doc.items.filter(i => i.id !== "stitch");}, expect:{GND:1}},
  {name:"ground and supply pours under two scoped classes", options:{imported:true, twoNets:true},
    breaks:"move a supply via off its pour", cut:doc => {const v = doc.items.find(i => i.id === "p2"); v.x = 20; v.y = 16;}, expect:{GND:0, VCC:1}}
];

const CASES = {
  connectivity: {fixtures:STITCHED, check:checkConnectivity, viewport:{width:1280,height:800}},
  composition: {fixtures:[null], check:checkComposition}
};

async function livePourBrowser(browser, cases = ["connectivity"]) {
  for (const name of cases) {
    assert.ok(Object.hasOwn(CASES,name), "Unknown live pour browser case: " + name);
    const {fixtures, check, viewport} = CASES[name];
    for (const fixture of fixtures) {
      // A fresh page keeps the deliberate WebGL failure local to the composition case.
      const page = await browser.newPage({viewport}), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(APP);
        await check(page, fixture);
        assert.deepEqual(errors, [], "No page errors for live pour " + name);
      } finally {
        await page.close();
      }
    }
  }
}

async function checkConnectivity(page, test) {
  await page.waitForFunction(() => globalThis.AtriumNavHost?.replaceProject);
  const {project, doc} = stitchedBoard()(test.options);
  const pourNets = [...new Set(doc.items.filter(i => i.kind === "polygon").map(i => i.net))].sort();
  const opened = await page.evaluate(async ({json, nets}) => {
    const h = AtriumNavHost, p = JSON.parse(json);
    // What the graph shows on every frame from the first one on (the canvas draw's own query):
    // the airwires on nets that have pours.
    const frames = globalThis.pourOpenFrames = [];
    const watch = () => {
      const doc = h.doc?.();
      if (doc?.kind === "pcb") {
        const defs = new Map(h.project().library.map(d => [d.id, d]));
        const shown = h.view?.()?.internals?.().airwireConnectivity(doc, defs);
        frames.push(shown ? shown.airwires.filter(w => nets.includes(w.net)).map(w => w.net) : null);
      }
      if (!globalThis.pourOpenStop) requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    await h.replaceProject(p, {force:true, dirty:true});
    return {compiler:!!globalThis.AtriumDesignQuery};
  }, {json:JSON.stringify(project), nets:pourNets});
  assert.equal(opened.compiler, false, "the scoped-rule compiler loads on demand, after the board opens");
  await page.waitForFunction(() => AtriumNavHost.doc()?.kind === "pcb");

  // Settled: the compiler loaded (as Design Rule Check or Query load it), no verification pending.
  const settled = () => page.waitForFunction(() => {
    const h = AtriumNavHost, doc = h.doc(), P = globalThis.AtriumPolygonPour;
    if (!P || !globalThis.AtriumDesignQuery || P.live.busy) return false;
    const defs = new Map(h.project().library.map(d => [d.id, d]));
    const shown = h.view().internals().airwireConnectivity(doc, defs);
    return !!shown && P.state(doc, defs) === "source";
  }, null, {timeout:20000});
  await page.evaluate(() => AtriumLazy.need("AtriumDesignQuery"));
  await settled();
  await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
  await settled();
  const graph = () => page.evaluate(nets => {
    const h = AtriumNavHost, doc = h.doc(), defs = new Map(h.project().library.map(d => [d.id, d]));
    const shown = h.view().internals().airwireConnectivity(doc, defs), full = AtriumConnectivity.inspectFull(doc, defs);
    const checked = AtriumConnectivity.inspect(doc, defs), missing = r => Object.fromEntries(nets.map(n => [n, r.nets.find(x => x.name === n)?.missing ?? 0]));
    return {shown:shown?.airwires, full:full.airwires, missing:missing(checked), fullMissing:missing(full),
      polygons:AtriumPolygonPour.stateOf(doc, defs).polygons, sources:doc.pcbDrawing.pours.map(r => r.source),
      sourceFill:doc.pcbDrawing.sourceFill ?? null};
  }, pourNets);
  const after = await graph();
  const frames = await page.evaluate(() => {globalThis.pourOpenStop = true; return globalThis.pourOpenFrames;});
  const none = Object.fromEntries(pourNets.map(n => [n, 0]));
  assert.ok(frames.length > 0, "frames were sampled");
  assert.deepEqual(frames.filter(f => f?.length), [], test.name + ": no frame shows an airwire on a poured net, before or after verification");
  assert.deepEqual(Object.values(after.polygons), pourNets.map(() => "poured"), test.name + ": every pour is verified");
  assert.deepEqual(after.sources, after.sources.map(() => "altium"), test.name + ": the verified source copper is kept, not repoured");
  assert.equal(after.sourceFill, null, test.name + ": the stored copper was adopted with no user edit");
  assert.deepEqual(after.fullMissing, none, test.name + ": the oracle joins every poured net through its stored pour");
  assert.deepEqual(after.missing, none, test.name + ": the connectivity the checks read agrees: no unrouted poured net");
  assert.deepEqual(after.shown, after.full, test.name + ": the displayed graph is the full pass's");

  // A real break still shows, on its own net only.
  await page.evaluate(cut => {const h = AtriumNavHost; h.edit(() => new Function("doc", cut)(h.doc()));},
    "(" + test.cut.toString() + ")(doc)");
  await page.waitForFunction(() => {
    const h = AtriumNavHost, doc = h.doc(), P = AtriumPolygonPour, defs = new Map(h.project().library.map(d => [d.id, d]));
    const shown = h.view().internals().airwireConnectivity(doc, defs);
    return !P.live.busy && shown && JSON.stringify(shown.airwires) === JSON.stringify(AtriumConnectivity.inspectFull(doc, defs).airwires);
  }, null, {timeout:20000});
  const broken = await graph(), byNet = {};
  for (const net of Object.keys(test.expect)) byNet[net] = broken.shown.filter(w => w.net === net).length;
  assert.deepEqual(byNet, test.expect, test.name + ": " + test.breaks + " shows exactly that break");
  console.log("PASS " + test.name + ": imported pours stayed joined for " + frames.length + " frames, source copper preserved, " + test.breaks + " shows");
}

async function checkComposition(page) {
  await page.waitForFunction(() => globalThis.AtriumNavHost && globalThis.AtriumLazy);
  const {firstHide, first2D, firstGPU, firstGPUHidden, bandFrame, failedGPU} = await page.evaluate(exerciseComposition);
  const first = {net: "PREVIEW", id: "first preview"}, stored = {net: "ACCEPTED", id: "stored"};
  assert.deepEqual(firstHide.reads, [], "an empty 2D board does not resolve region artwork");
  assert.deepEqual(firstGPUHidden.reads, [], "a hidden GPU source does not resolve region artwork");
  assert.deepEqual(first2D.reads, [first]);
  assert.deepEqual(first2D.labels, [first]);
  assert.notDeepEqual(first2D.pixel, firstHide.pixel, "Canvas2D shows a first preview before stored copper exists");
  assert.equal(firstGPU.renderer, "gpu");
  assert.deepEqual(firstGPU.reads, [first]);
  assert.deepEqual(firstGPU.labels, [first]);
  assert.notDeepEqual(firstGPU.pixel, firstGPUHidden.pixel, "GPU also shows the actual first preview copper");
  assert.deepEqual(bandFrame.reads, [stored]);
  assert.deepEqual(bandFrame.labels, [stored]);
  assert.deepEqual(bandFrame.order, [stored]);
  assert.ok(bandFrame.bands.length && bandFrame.bands.every(pour => pour.id === stored.id), "translucent bands keep the same copper list");
  assert.equal(failedGPU.fault, true);
  assert.equal(failedGPU.renderer, "2d");
  assert.deepEqual(failedGPU.reads, [stored], "fallback must not resolve a second list");
  assert.deepEqual(failedGPU.labels, [stored]);
  assert.notDeepEqual(failedGPU.pixel, firstHide.pixel, "fallback paints the resolved copper, not the offscreen decoy");
  console.log("PASS first live copper preview and one source read across GPU bands, labels and Canvas2D fallback");
}

async function exerciseComposition() {
  await AtriumLazy.need(["AtriumCanvasGPU","AtriumPolygonPour","AtriumPourAnim","AtriumPCBNetLabels"]);
  const real = AtriumPolygonPour, animation = AtriumPourAnim, pcb = AtriumPCBAppearance;
  const engine = AtriumCanvasGPU, labels = AtriumPCBNetLabels;
  const realPower = AtriumPower, realMotion = AtriumMotion;
  globalThis.AtriumPower = {...realPower, efficient:()=>false};
  globalThis.AtriumMotion = {...realMotion,level:()=>"full"};
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:12px;top:18px;width:320px;height:240px;z-index:10000";
  document.body.append(canvas);
  const view = AtriumCanvas.create(canvas), I = view.internals(), defs = new Map();
  const board = Atrium.sheet("pcb","Software copper frame");
  board.outline = [[-12,-9],[12,-9],[12,9],[-12,9]];
  const rectangle = (net, x=0) => AtriumPCBPours.region([[[-9+x,-7],[9+x,-7],[9+x,7],[-9+x,7]]],"Top",net);
  const preview = rectangle("PREVIEW"), accepted = rectangle("ACCEPTED"), decoy = rectangle("SECOND_READ",30);
  const graphic = (id,layer,y) => ({kind:"graphic",id,layer,width:.2,points:[[-6,y],[6,y]]});
  board.items = [graphic("two","Mechanical 15",-8), graphic("one","Mechanical",8),
    {id:"trace",kind:"track",net:"T",layer:"Top",width:.3,points:[[-9,-8],[9,-8]]}];
  view.restoreCamera({cx:0,cy:0,scale:12,referenceScale:12});
  const opts = {editorPane:true,noReuse:true,grid:false,origin:false,showUnrouted:false,layer:"Top"};
  const originalOrder=I.paintOrder, originalDraw=I.drawBoard, listIds=new WeakMap();
  const identify = list => list ? {net:list[0]?.net??null,id:listIds.get(list)??null} : null;
  const identity = (list,id) => {if(list)listIds.set(list,id);return list;};
  let tracing = null, alternate = false;
  globalThis.AtriumPolygonPour = {...real,
    displayPours(doc){
      if(doc!==board || !tracing)return real.displayPours(doc);
      const result = alternate && tracing.reads.length ? identity([decoy],"second read") : real.displayPours(doc);
      tracing.reads.push(identify(result));
      return result;
    },
  };
  globalThis.AtriumPCBNetLabels = {...labels, place(data){
    if(tracing)tracing.labels.push(identify(data.pours));
    return labels.place(data);
  }};
  I.paintOrder=(...args)=>{
    if(tracing)tracing.order.push(identify(args[5]));
    return originalOrder(...args);
  };
  I.drawBoard=(...args)=>{
    if(tracing && args[6])tracing.bands.push(identify(args[6]));
    return originalDraw(...args);
  };
  function draw(gpu, extra = {}, fault = false) {
    engine.enable(gpu);
    const rows = {reads:[],labels:[],order:[],bands:[],fault:false};
    if(fault) {
      const gl = canvas.previousElementSibling.getContext("webgl2");
      gl.drawElements = () => {rows.fault=true;throw new Error("deliberate GPU failure after accepted copper resolution");};
    }
    tracing=rows;
    view.render(board,defs,{...opts,...extra});
    tracing=null;
    const capture=engine.composite(I)||canvas, context=capture.getContext("2d");
    Object.assign(rows,{renderer:engine.status(I).renderer,device:engine.status(I).device, pixel:[...context.getImageData(Math.round(78*devicePixelRatio),Math.round(68*devicePixelRatio),1,1).data]});
    return rows;
  }
  const hidden = new Set(["Source pours"]), firstHide = draw(false,{hidden});
  const token = {};
  const started = animation.begin({doc:board,ids:["first-pour"],estimateMs:1000,token});
  if (!started) throw new Error("Fixture did not enter the genuine Repour All animation");
  animation.preview(token,"first-pour",[preview]);
  identity(real.displayPours(board),"first preview");
  const first2D=draw(false), firstGPU=draw(true), firstGPUHidden=draw(true,{hidden});
  animation.end(token,{committed:false});
  board.pcbDrawing={annotations:{},pours:identity([accepted],"stored")};
  board.sourcePourSignature=AtriumPCBPours.signature(board,defs);
  view.invalidate(board);
  const oldOpacity=pcb.opacity.track;
  pcb.setOpacity("track",.5);
  const bandFrame=draw(true);
  pcb.setOpacity("track",oldOpacity);
  alternate=true;
  const failedGPU=draw(true,{},true);
  return {firstHide, first2D, firstGPU, firstGPUHidden, bandFrame, failedGPU};
}

module.exports = livePourBrowser;
if (require.main === module) {
  const cases = process.argv.slice(2);
  const executablePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  launch({headless:true, executablePath}, browser => livePourBrowser(browser, cases.length ? cases : undefined),
    error => { console.error(error); process.exitCode = 1; });
}
