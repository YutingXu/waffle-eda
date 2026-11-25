"use strict";
// The exact composed pixels of the retained 2D frame versus a fresh independent view. Open
// canvas-damage.html, or run it with headless Chrome --dump-dom --disable-accelerated-2d-canvas.
globalThis.atriumCanvasDamage = async function () {
  const A = Atrium, U = AtriumUndoStore, original = AtriumCanvasFast;
  const trace = new WeakMap(), cases = [], failures = [];
  const efficient = AtriumPower.mode();
  AtriumPower.setMode("always");
  globalThis.AtriumCanvasFast = {...original, reuse(I, ...args) {
    const paint = I.paint, areas = [];
    I.paint = (...inputs) => { areas.push(inputs[3]); return paint(...inputs); };
    try {
      const reused = original.reuse(I, ...args);
      trace.set(I.canvas, {reused, areas, layers:I.orderUsed, lod:I.lodUsed, delta:I.cache?.delta?.known});
      return reused;
    } finally { I.paint = paint; }
  }};
  const surface = () => {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:920px;height:640px";
    document.body.append(canvas);
    return canvas;
  };
  const line = (id, points, layer = "Top", width = .28) => ({id, kind:"track", layer, width, points});
  const project = (doc, defs) => ({name:"Partial frame test", documents:[doc], library:[...defs.values()]});
  const opts = {reuseBase:true, grid:true, layer:"Top", hidden:new Set(), measure:{a:[176,130],b:[185,142],text:"12.4 mm"}};
  const camera = {cx:182, cy:135, scale:16, referenceScale:16, flipped:false};
  const load = (doc, defs, position = camera, drawing = opts, verified = false) => {
    const p = project(doc, defs), canvas = surface(), view = AtriumCanvas.create(canvas), history = [], future = [];
    U.reset(verified ? p : null);
    if (!verified) U.sync(p);
    view.restoreCamera(position); view.render(doc, defs, drawing);
    function edit(change) {
      const before = U.mark(p);
      change(); U.checkpoint(history, future, before);
      U.record(p); AtriumCanvas.edited();
    }
    function undo(n) { U.jump(history, future, U.mark(p), n); AtriumCanvas.edited(); }
    return {doc, defs, canvas, view, edit, undo, drawing, history, future};
  };
  function compare(scene, name, mode, drawing = scene.drawing, expectedRects = 1) {
    const {doc, defs, canvas, view} = scene;
    view.render(doc, defs, drawing);
    const retained = trace.get(canvas);
    const reference = surface();
    reference.style.cssText = canvas.style.cssText;
    const fullView = AtriumCanvas.create(reference);
    fullView.restoreCamera(view.camera());
    fullView.render(doc, defs, {...drawing, noReuse:true});
    const width = canvas.width, height = canvas.height;
    const actual = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    const expected = reference.getContext("2d").getImageData(0, 0, width, height).data;
    let pixels = 0, first = null, last = null, max = 0;
    for (let n = 0; n < actual.length; n += 4) {
      const delta = Math.max(Math.abs(actual[n]-expected[n]), Math.abs(actual[n+1]-expected[n+1]),
        Math.abs(actual[n+2]-expected[n+2]), Math.abs(actual[n+3]-expected[n+3]));
      if (!delta) continue;
      pixels++; max = Math.max(delta, max);
      last = [(n/4)%width, Math.floor(n/4/width)]; first ??= last;
    }
    reference.remove();
    const reused = retained?.reused || false, rects = retained?.areas.length || 0;
    const pass = pixels === 0 && (mode === "full" ? !reused : reused && rects === expectedRects);
    cases.push({name, mode, reused, rects, pixels, ...(!pass ? {first, last, max, ...retained} : {})});
    if (!pass) failures.push(name);
  }
  const rect = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  try {
    const zoom = await atriumCanvasViaMarkZoom();
    failures.push(...zoom.failures);
    cases.push(...zoom.cases);
    const {d, defs} = makeAtriumBenchmarkBoard();
    const moving = line("moving", [[179.1,135.25],[184.65,135.35]], "Top", .41);
    const other = line("second", [[194.25,149.8],[197.9,150.2]], "Bottom", .32);
    const under = line("overlap-under", [[162.31,134.17],[203.67,136.03]], "Bottom", 1.21);
    const crossing = line("clip-crossing", [[161.1,139.172],[202.42,133.591]], "Top", .19);
    const text = {id:"test-text",kind:"label",layer:"Silk",text:"GÄTÈ CONTROL",x:175.5,y:139.25,size:.9,angle:8};
    const polygon = {id:"imported-region",kind:"graphic",layer:"Mechanical",points:rect(178,132,187,138),closed:true,fill:true,width:0};
    const via = {id:"mask", kind:"via", layer:"Multi", x:183, y:135.5, diameter:1, drill:.4, tent:{top:false,bottom:false}};
    const B = AtriumBoardShape, [width,height] = d.outline[2];
    B.apply(d, {...B.rect({x:0,y:height,width,height}), cutouts:[B.circle(.55, [181.1,135.3]).contour]});
    d.items.push(under, crossing, moving, other, text, polygon, via);
    const scene = load(d, defs, camera, opts, true), selected = {...opts, selected:moving.id};
    scene.edit(() => {moving.points = moving.points.map(([x,y]) => [x+.35,y+.91]); via.tent.top = true;});
    compare(scene, "First PCB move with cutout, changed solder mask and selection overlay", "partial", selected);
    scene.edit(() => d.items.splice(d.items.indexOf(moving),1));
    compare(scene, "PCB delete/selection disappears", "partial");
    scene.undo(-1);
    compare(scene, "PCB undo reinserts at original overlap order", "partial", selected);
    scene.undo(1);
    compare(scene, "PCB redo delete", "partial");
    const added = line("new", [[179.3,135.05],[184.8,135.43]], "Top", .48);
    scene.edit(() => d.items.push(added));
    compare(scene, "PCB add", "partial");
    scene.edit(() => {added.points = added.points.map(([x,y]) => [x+.8,y+.5]);});
    scene.view.query(d,defs,[174,129,198,151]); // An intervening non-paint sync consumes the first journal delta.
    scene.edit(() => {other.points = other.points.map(([x,y]) => [x+.5,y-1]);});
    compare(scene, "Union of two separated edits before one frame", "partial", opts, 2);
    scene.edit(() => {text.text = "GÄTÈ CONTROL / AUXILIARY"; text.x += 1.2;});
    compare(scene, "Rotated PCB text moves and gets wider", "partial");
    scene.edit(() => {polygon.points = rect(179,131,188,138);});
    compare(scene, "PCB imported layer polygon with overlaps", "partial");
    compare(scene, "PCB selection only", "partial", {...opts, selected:polygon.id});
    scene.edit(() => {d.items[0].x += .1;});
    compare(scene, "An offscreen edit keeps the current artwork", "partial", opts, 1);
    scene.edit(() => {d.items[0].x += .1;});
    compare(scene, "A confirmed offscreen edit has no dirty pixels to paint", "partial", opts, 0);
    const theme = settings => dispatchEvent(new CustomEvent("atrium-theme", {detail:{reason:"change", settings}}));
    theme({preset:"dark", density:"comfortable", motion:"full"});
    compare(scene, "A theme setting draws in full", "full");
    theme({preset:"dark", density:"comfortable", motion:"off"});
    compare(scene, "An animation setting keeps the retained artwork", "partial", opts, 0);
    scene.edit(() => d.items.unshift({...polygon,id:"tied-rank",layer:"Mechanical 15",fill:true}));
    compare(scene, "Changed order among tied PCB layers uses full paint", "full");
    scene.view.pan(27, -15);
    compare(scene, "A different camera invalidates the retained artwork", "full");
    scene.canvas.remove();

    const imported = makeAtriumBenchmarkBoard().d;
    const silk = {id:"pour-label",kind:"label",layer:"Silk",text:"Copper underneath",x:178,y:136,size:.75};
    imported.items.push(silk);
    const region = AtriumPCBPours.region([rect(169,122,198,154),rect(182,130,184,144)], "Bottom", "GND");
    imported.pcbDrawing = {pours:[region]};
    imported.sourcePourSignature = AtriumPCBPours.signature(imported, defs);
    const importedScene = load(imported, defs, {...camera,flipped:true});
    importedScene.edit(() => {silk.x += 1.11; silk.y -= .4;});
    compare(importedScene, "Stable imported copper under changed silk, flipped PCB", "partial");
    importedScene.edit(() => {imported.pcbDrawing.pours = [];});
    compare(importedScene, "Imported copper removal invalidates retained pixels", "full");
    importedScene.canvas.remove();

    const airwires = makeAtriumBenchmarkBoard().d;
    const a = {id:"wire-start",kind:"via",x:171,y:122,diameter:1.2,drill:.4,layer:"Multi",net:"U"};
    const b = {...a,id:"wire-end",x:200,y:149};
    airwires.items.push(a,b);
    const wireScene = load(airwires, defs, camera, {...opts,showUnrouted:true});
    wireScene.edit(() => {a.x += .8; a.y -= 1;});
    compare(wireScene, "New connectivity redraws airwires outside the item's damage over the retained pixels beneath them", "partial");
    compare(wireScene, "Selection over retained airwires", "partial", {...wireScene.drawing, selected:b.id});
    // Connectivity after the edit frame, as in the editor: the edit frame draws the last airwires,
    // then the new result redraws only the airwires.
    let repaints = 0;
    wireScene.view.onRepaint(() => {repaints++;});
    wireScene.edit(() => {b.x -= 1.4; b.y += .6;});
    wireScene.view.render(airwires, defs, wireScene.drawing);
    for (let n = 0; n < 40 && !repaints; n++) await new Promise(r => setTimeout(r, 25));
    if (!repaints) failures.push("Deferred connectivity never asked for a repaint");
    compare(wireScene, "A later connectivity result redraws only the airwires", "partial", wireScene.drawing, 0);
    wireScene.view.onRepaint(null);
    wireScene.canvas.remove();

    const overviewBoard = A.sheet("pcb", "Batched copper");
    overviewBoard.outline = rect(0,0,132,100);
    // Pixel-aligned strokes isolate the batching path from native antialiasing differences
    // between independent whole renders of composite footprints at this zoom.
    for (let x=1; x<=50; x++) for (let y=1; y<=38; y++) {
      const layer = y%9 === 0 ? "Mechanical 15" : y%9 === 1 ? "Mechanical" : "Top";
      overviewBoard.items.push(line(`batch-${x}-${y}`,[[x*2.5,y*2.5],[x*2.5+1.5,y*2.5]],layer,.5));
    }
    const overviewTrack = overviewBoard.items.find(i => i.id === "batch-25-19");
    const overview = load(overviewBoard, defs, {cx:66,cy:50,scale:6,referenceScale:6,flipped:false}, {...opts,hidden:new Set(["Mechanical 15"])});
    compare(overview, "Batched PCB track selection", "partial", {...overview.drawing,selected:overviewTrack.id});
    overview.edit(() => {overviewTrack.points = overviewTrack.points.map(([x,y]) => [x+.03,y]);});
    compare(overview, "Batched artwork repaints a geometry edit with its batches", "partial");
    const batchCrossing = line("batch-crossing", [[60.2,46.1],[64.9,49.3]], "Top", .5);
    overview.edit(() => {overviewTrack.points = overviewTrack.points.map(([x,y]) => [x+2.5,y+1.25]); overviewBoard.items.push(batchCrossing);});
    compare(overview, "Batched move into another chunk and an added track", "partial");
    overview.edit(() => overviewBoard.items.splice(overviewBoard.items.indexOf(batchCrossing), 1));
    compare(overview, "Batched delete", "partial");
    // 1,900 objects in view against the 1,500 that batch: removing 200 keeps batching, but 250 more
    // could leave fewer than 1,500, and a fresh paint might not batch, so that frame paints in full.
    const gone = overviewBoard.items.filter(i => i !== overviewTrack && i.layer === "Top").slice(0, 450);
    overview.edit(() => {for (const i of gone.slice(0, 200)) overviewBoard.items.splice(overviewBoard.items.indexOf(i), 1);});
    compare(overview, "Batched deletions that keep the frame batched", "partial", overview.drawing, 1);
    overview.edit(() => {for (const i of gone.slice(200)) overviewBoard.items.splice(overviewBoard.items.indexOf(i), 1);});
    compare(overview, "Batched deletions that may end batching use a full paint", "full");
    overview.edit(() => overviewBoard.items.push(...gone));
    compare(overview, "Restored objects bring batching back", "full");
    const canvasContexts = new Set([CanvasRenderingContext2D.prototype]);
    const offscreen = typeof OffscreenCanvas === "function" && new OffscreenCanvas(1,1).getContext("2d");
    if (offscreen) canvasContexts.add(Object.getPrototypeOf(offscreen));
    let dragCopies = 0;
    const restoreCopies = [...canvasContexts].map(context => {
      const draw = context.drawImage;
      context.drawImage = function (source, ...args) {
        if (source === overview.canvas) dragCopies++;
        return draw.call(this, source, ...args);
      };
      return () => {context.drawImage = draw;};
    });
    try {
      const transient = {...overview.drawing,transientGeometry:true,selected:overviewTrack.id,
        measure:{a:[58,47.5],b:[76,50],text:"18.2 mm"}};
      for (let n = 1; n <= 3; n++) {
        overviewTrack.points = overviewTrack.points.map(([x,y]) => [x+.25,y]);
        overview.view.invalidate(overviewBoard,[overviewTrack]);
        compare(overview, `Transient PCB move ${n} displays current geometry`, "full", transient);
      }
      if (dragCopies !== 0) throw new Error("Moving geometry must not capture a board copy");
      const preview = {...transient,measure:{...transient.measure,text:"18.20 mm"}};
      compare(overview, "Static transient preview can capture the board", "full", preview);
      compare(overview, "Overlay-only transient preview can reuse the board", "partial", transient, 0);
      if (dragCopies !== 1) throw new Error("The static preview must capture one reusable copy");

      compare(overview, "First PCB frame after drop displays settled geometry", "full");
      compare(overview, "Settled preview can reuse the first post-drop frame", "partial", overview.drawing, 0);
      if (dragCopies !== 2) throw new Error("The post-drop frame must capture a reusable copy");

      const dropped = overviewTrack.points;
      overviewTrack.points = dropped.map(([x,y]) => [x+.25,y]);
      overview.view.invalidate(overviewBoard,[overviewTrack]);
      compare(overview, "Transient PCB move before cancel", "full", transient);
      overviewTrack.points = dropped;
      overview.view.invalidate(overviewBoard);
      compare(overview, "Canceled PCB move displays the restored geometry", "full");
      compare(overview, "Restored geometry has a reusable board copy", "partial", overview.drawing, 0);
      if (dragCopies !== 3) throw new Error("Cancel must retain the restored board once");

      overviewTrack.points = overviewTrack.points.map(([x,y]) => [x+.25,y]);
      overview.view.invalidate(overviewBoard,[overviewTrack]);
      overview.canvas.style.display = "none";
      overview.view.resized();
      overview.view.render(overviewBoard,defs,transient);
      if (dragCopies !== 3) throw new Error("A hidden pane must not capture a copy");
      Object.assign(overview.canvas.style,{display:"block",width:"900px",height:"620px"});
      overview.view.resized();
      compare(overview, "First settled PCB frame after hide and resize", "full");
      compare(overview, "Settled PCB frame reuses the new size", "partial", overview.drawing, 0);
      if (dragCopies !== 4) throw new Error("The resized frame must capture a reusable copy");
    } finally {
      for (const restore of restoreCopies) restore();
    }
    overview.canvas.remove();

    const s = A.sheet("schematic", "Wire sheet");
    for (let x=0; x<24; x++) for (let y=0; y<18; y++) {
      s.items.push({id:`wire-${x}-${y}`,kind:"wire",points:[[153+x*2.5,114+y*2.4],[154.7+x*2.5,114.2+y*2.4]]});
    }
    const wire = {id:"attached-a",kind:"wire",points:[[179.2,136.22],[182.2,136.22]]};
    const connected = {id:"attached-b",kind:"wire",points:[[182.2,136.22],[184.4,144.46]]};
    const junction = {id:"join",kind:"junction",x:182.2,y:136.22};
    const cross = {id:"horizontal",kind:"wire",points:[[177.1,142.75],[189.5,142.75]]};
    const port = {id:"fixed-port",kind:"port",text:"WWWWWWWW",width:3,x:183,y:131,angle:0};
    s.items.push(wire,connected,junction,cross,port);
    const schematic = load(s, defs, camera, {...opts,measure:null});
    schematic.edit(() => {
      junction.x += .9; junction.y += .2;
      wire.points[1] = [junction.x,junction.y]; connected.points[0] = [junction.x,junction.y];
    });
    compare(schematic, "Schematic connected wires and junction changed together", "partial");
    schematic.edit(() => {port.text = "WWWWWWWWWW"; port.x += .75;});
    compare(schematic, "Schematic text overhangs the port's fixed body width", "partial");
    schematic.edit(() => {s.hopOvers = true; connected.points = [[183.1,136.42],[183.1,144.46]];});
    compare(schematic, "Schematic enables dependent wire crossings", "full");
    await Promise.resolve();
    schematic.edit(() => {connected.points = [[184.1,136.42],[184.1,144.46]];});
    compare(schematic, "Schematic hop on an otherwise unchanged horizontal wire", "full");
    schematic.canvas.remove();

    const infinite = A.sheet("schematic", "Infinite");
    infinite.sheet = {infinite:true};
    const frame = AtriumSchObjects.make("frame", [-16,-12], {w:13,h:10,text:"Block"});
    const pin = {id:"member",kind:"junction",x:-12,y:-6};
    infinite.items = [frame, pin, {id:"outlier",kind:"junction",x:25,y:16}];
    // Keep this viewport above the 300-object retained-artwork threshold.
    for (let index=0;index<360;index++) {
      const x=-35+(index%24)*2, y=-29+Math.floor(index/24)*2.5;
      infinite.items.push({id:"line-"+index,kind:"wire",points:[[x,y],[x+.75,y]]});
    }
    const free = load(infinite, defs, {cx:0,cy:4,scale:6,referenceScale:6,flipped:false}, {...opts,measure:null});
    free.edit(() => {frame.x-=1;pin.x-=1;});
    compare(free, "Infinite frame and member move on the negative grid", "partial");
    free.undo(-1);
    compare(free, "Infinite frame Undo restores the exact retained pixels", "partial");
    free.edit(() => {infinite.sheet.titleBlock="standard";});
    compare(free, "Infinite title block is enabled at the drawing corner", "full");
    free.edit(() => {infinite.items[2].y-=5;});
    compare(free, "Shrinking the drawing moves the title block", "full");
    free.undo(-1);
    compare(free, "Undo restores the title to its previous drawing corner", "full");
    free.canvas.remove();

    // Batched footprints on the dense board. A rebuilt batch can move antialiasing by a level
    // elsewhere on its scanlines: the partial frame is marked inexact and the idle frame (as after
    // a gesture) paints in full. That frame must equal a full paint of the same view.
    {
      const board = makeAtriumBenchmarkBoard().d, view = {cx:150, cy:120, scale:5, referenceScale:5, flipped:false};
      const scene = load(board, defs, view, {...opts, measure:null, showUnrouted:true});
      const pixels = () => scene.canvas.getContext("2d").getImageData(0, 0, scene.canvas.width, scene.canvas.height).data;
      const parts = board.items.filter(i => i.kind === "part" && Math.abs(i.x-150) < 30 && Math.abs(i.y-120) < 20).slice(0, 3);
      const via = board.items.find(i => i.kind === "via" && Math.abs(i.x-140) < 20 && Math.abs(i.y-115) < 15);
      const delta = (a, b) => { let n = 0, max = 0, box = null; for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { n++; max = Math.max(max, Math.abs(a[k] - b[k])); const x = (k >> 2) % scene.canvas.width, y = Math.floor((k >> 2) / scene.canvas.width); box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]; } return {n, max, box}; };
      for (const [n, change] of [[0, () => {parts[0].x += .45;}], [1, () => {parts[1].angle = ((parts[1].angle || 0) + 90) % 360;}],
        [2, () => {via.x -= .6; parts[2].y += .3;}], [3, () => board.items.splice(board.items.indexOf(parts[0]), 1)]]) {
        scene.edit(change);
        scene.view.render(board, defs, scene.drawing);
        const partial = trace.get(scene.canvas), quick = pixels();
        trace.delete(scene.canvas);
        await new Promise(r => setTimeout(r, 200));   // the idle exact frame renders the last frame again
        const exact = trace.get(scene.canvas), settled = pixels();
        scene.view.render(board, defs, {...scene.drawing, noReuse:true});
        const full = pixels(), early = delta(quick, full), late = delta(settled, full);
        const name = "Batched dense footprints, edit " + (n + 1) + ": partial frame, then the exact idle frame";
        const pass = partial?.reused && partial.lod && partial.areas.length >= 1 && early.max <= 2 && exact && !exact.reused && late.n === 0;
        cases.push({name, mode:"partial", reused:partial?.reused, rects:partial?.areas.length, pixels:late.n, inexact:early, ...(pass ? {} : {partial, exact})});
        if (!pass) failures.push(name);
        scene.view.render(board, defs, scene.drawing);   // a copy for the next edit
      }
      scene.canvas.remove();
    }

    // DRC markers above 250 rows draw as an overview into a layer kept per canvas. A frame that
    // reuses the layer equals a fresh view's frame; an edit redraws the pixel rows of its markers'
    // old and new areas, and the frame after the edits stop redraws the layer whole.
    if (globalThis.AtriumDRCMarkers) {
      const board = makeAtriumBenchmarkBoard().d, near = board.items.filter(i => (i.kind === "via" || i.kind === "track") &&
        Math.abs((i.x ?? i.points[0][0]) - 182) < 26 && Math.abs((i.y ?? i.points[0][1]) - 135) < 18);
      const list = [];
      for (let n = 0; n + 1 < near.length && list.length < 600; n++) {
        const a = near[n], b = near[n + 1], at = [a.x ?? a.points[0][0], a.y ?? a.points[0][1]], to = [b.x ?? b.points[0][0], b.y ?? b.points[0][1]];
        list.push({type: n % 6 ? "clearance" : "width", rule: "Clearance", id: a.id, otherId: n % 6 ? b.id : undefined, at, otherAt: n % 6 ? to : undefined, warning: n % 10 === 0, actual: .1, required: .2});
      }
      const scene = load(board, defs, camera, {...opts, measure:null});
      let rev = 1;
      const markers = (extra = {}) => ({...scene.drawing, overlay:[AtriumDRCMarkers.overlay(board, defs, list, {rev, ...extra})]});
      const pixels = canvas => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const fresh = drawing => {
        const reference = surface(); reference.style.cssText = scene.canvas.style.cssText;
        const v = AtriumCanvas.create(reference); v.restoreCamera(scene.view.camera()); v.render(board, defs, {...drawing, noReuse:true});
        const data = pixels(reference); reference.remove(); return data;
      };
      const delta = (a, b) => { let n = 0, max = 0, box = null; for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { n++; max = Math.max(max, Math.abs(a[k] - b[k])); const x = (k >> 2) % scene.canvas.width, y = Math.floor((k >> 2) / scene.canvas.width); box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]; } return {n, max, box}; };
      const record = (name, d, pass) => { cases.push({name, mode:"partial", reused:true, rects:0, pixels:d.n, ...(pass ? {} : {max:d.max, box:d.box, rows:list.length, stats:AtriumDRCMarkers.overviewStats()})}); if (!pass) failures.push(name); };
      const stats = () => AtriumDRCMarkers.overviewStats();
      scene.view.render(board, defs, markers());
      const first = pixels(scene.canvas), s0 = stats();
      scene.view.render(board, defs, markers());
      const again = pixels(scene.canvas), d0 = delta(again, first), d1 = delta(again, fresh(markers()));
      record("DRC overview layer reused on an unchanged frame", d0, d0.n === 0 && stats().reused > s0.reused);
      record("Reused DRC overview layer against a fresh view", d1, d1.n === 0);
      const moved = near[2];
      scene.edit(() => { if (moved.points) moved.points = moved.points.map(([x, y]) => [x + .4, y + .2]); else { moved.x += .4; moved.y += .2; } });
      rev++;
      const s1 = stats();
      // The board itself in full (its batched patch has its own exact frame): this compares the markers.
      scene.view.render(board, defs, {...markers(), noReuse:true});
      const patched = delta(pixels(scene.canvas), fresh(markers()));
      record("DRC overview after an edit: patched pixel rows within two levels of a fresh view", patched, patched.max <= 2 && stats().patched === s1.patched + 1);
      await new Promise(r => setTimeout(r, 600));
      scene.view.render(board, defs, markers());
      const settled = delta(pixels(scene.canvas), fresh(markers()));
      record("DRC overview after an edit: settled layer equals a fresh view", settled, settled.n === 0);
      scene.view.render(board, defs, markers({hover:list[3]}));
      const hover = delta(pixels(scene.canvas), fresh(markers({hover:list[3]})));
      record("DRC overview with a hovered marker equals a fresh view", hover, hover.n === 0);
      scene.canvas.remove();
    }

    if (globalThis.AtriumDRCMarkers) {
      const top = line("drc-top", [[170, 126], [194, 126]]);
      const bottom = line("drc-bottom", [[170, 144], [194, 144]], "Bottom");
      const board = {id: A.id(), name: "Layer switch fixture", kind: "pcb", grid: .25, items: [top, bottom]};
      const scene = load(board, defs, camera, {...opts, noReuse: true, measure: null});
      const list = [{type: "clearance", id: top.id, otherId: bottom.id, at: [175, 126], otherAt: [175, 144]},
        ...Array.from({length: 250}, () => ({type: "width", at: [182, 135]}))];
      const paint = (view, hidden) => view.render(board, defs, {...scene.drawing,
        overlay: [AtriumDRCMarkers.overlay(board, defs, list, {rev: 1, hidden: new Set([hidden])})]});
      const pixels = c => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const reference = surface(), ref = AtriumCanvas.create(reference);
      ref.restoreCamera(camera);
      paint(scene.view, "Bottom");
      const before = pixels(scene.canvas), first = AtriumDRCMarkers.overviewStats();
      paint(scene.view, "Bottom");
      const warm = AtriumDRCMarkers.overviewStats();
      paint(scene.view, "Top");
      const switched = AtriumDRCMarkers.overviewStats();
      paint(ref, "Top");
      const actual = pixels(scene.canvas), expected = pixels(reference);
      let difference = 0, changed = 0;
      for (let i = 0; i < expected.length; i++) {
        difference += actual[i] !== expected[i];
        changed += before[i] !== expected[i];
      }
      const name = "DRC overview swaps the visible physical outline with the same marker count";
      const reused = warm.reused > first.reused;
      cases.push({name, mode: "partial", pixels: difference, changed, reused, first, warm, switched});
      if (difference || !changed || !reused) failures.push(name);
      reference.remove();
      scene.canvas.remove();
    }

    const dense = makeAtriumBenchmarkBoard().d;
    const sample = dense.items.find(i => i.kind === "track" && Math.abs(i.points[0][0]-182)<4 && Math.abs(i.points[0][1]-135)<4);
    const bench = load(dense, defs, camera, {...opts,measure:null});
    const timing = {full:[],retained:[]}; let reused = 0;
    const samplesPerMode = 64;
    for (const mode of Object.keys(timing)) {
      const drawing = {...bench.drawing,noReuse:mode==="full"}, ctx = bench.canvas.getContext("2d");
      bench.view.render(dense, defs, drawing);
      for (let n=0; n<samplesPerMode; n++) {
        bench.edit(() => {sample.points = sample.points.map(([x,y]) => [x+(n%2 ? .02 : -.02),y]);});
        const start = performance.now();
        bench.view.render(dense, defs, drawing);
        ctx.getImageData(0,0,1,1);
        timing[mode].push(performance.now()-start);
        if (mode === "retained" && trace.get(bench.canvas)?.reused) reused++;
      }
    }
    bench.canvas.remove();
    const stats = data => {
      data.sort((a,b) => a-b);
      return Object.fromEntries([.5,.95,.99].map(q => [`p${q*100}`, +data[Math.ceil(q*data.length)-1].toFixed(3)]));
    };
    return {dpr:devicePixelRatio,cases,failures,timing:{objects:dense.items.length,reused,samplesPerMode,full:stats(timing.full),retained:stats(timing.retained)}};
  } finally {
    U.reset(); AtriumPower.setMode(efficient); globalThis.AtriumCanvasFast = original;
  }
};


// Compare only the via mark's neighbourhood with the exact camera. The other
// artwork is intentionally sampled from a scaled copy during a wheel gesture.
globalThis.atriumCanvasViaMarkZoom = async function () {
  const PCB = AtriumPCBAppearance, T = AtriumPCBText;
  const css = "display:block;width:520px;height:360px";
  const defs = new Map(), cases = [], failures = [];
  const opts = {grid:false, origin:false, layer:"Top", netNames:false};
  const now = performance.now.bind(performance);
  const makeView = () => {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = css; document.body.append(canvas);
    const ctx = canvas.getContext("2d", {willReadFrequently:true}), view = AtriumCanvas.create(canvas);
    let copies = 0;
    const drawImage = ctx.drawImage;
    ctx.drawImage = function (...args) { copies++; return drawImage.apply(this, args); };
    return {ctx, canvas, view, copies:() => copies};
  };
  const camera = scale => ({cx:0, cy:0, scale, referenceScale:scale});
  function exact(surface, doc, scale, options) {
    surface.view.restoreCamera(camera(scale));
    surface.view.render(doc, defs, {...options, noReuse:true});
  }
  // Always exercise reuse even if the exact SVG-free fixture takes below 4 ms.
  function warm(surface, doc, scale, options) {
    const nowProperty = Object.getOwnPropertyDescriptor(performance, "now");
    let tick = now();
    Object.defineProperty(performance, "now", {configurable:true, value:() => tick += 5});
    try { exact(surface, doc, scale, options); }
    finally {
      if (nowProperty) Object.defineProperty(performance, "now", nowProperty);
      else delete performance.now;
    }
  }
  function move(surface, doc, scale, options) {
    surface.view.restoreCamera(camera(scale));
    surface.view.moving();
    const before = surface.copies(), start = now();
    surface.view.render(doc, defs, options);
    return {ms:now()-start, copied:surface.copies()>before};
  }
  function compare(a, b, at, radius) {
    const [x,y] = a.view.worldToScreen(at), dpr = devicePixelRatio;
    const side = 2*radius+1, left = Math.floor(x*dpr)-radius, top = Math.floor(y*dpr)-radius;
    const first = a.ctx.getImageData(left,top,side,side).data, second = b.ctx.getImageData(left,top,side,side).data;
    let bytes = 0, max = 0;
    for (let i=0;i<first.length;i++) {
      const diff=Math.abs(first[i]-second[i]);
      if(diff){bytes++;max=Math.max(max,diff);}
    }
    return {bytes, max};
  }

  for (const mode of ["ordinary", "translucent", "covered"]) for (const direction of ["in", "out"]) {
    const surface = makeView(), reference = makeView(), control = makeView();
    const doc = Atrium.sheet("pcb", "Via zoom");
    doc.outline = [[-20,-13],[20,-13],[20,13],[-20,13]];
    const via = {id:"mark",kind:"via",x:0,y:0,diameter:2.8,drill:1.5,layer:"Multi",ipc4761:"VII",
      backdrill:{from:"Bottom",to:"Inner 1",diameter:1.7}};
    const title = {id:"far",kind:"label",x:9,y:5,text:"AUX 7",size:1.4,layer:"Silk"};
    doc.items = [via,title];
    if (mode==="covered") doc.items.push({id:"cover",kind:"track",layer:"Multi",points:[[-3,.2],[3,.2]],width:.6});
    const plain = {...doc, id:"control", items:[{...via,ipc4761:"none",backdrill:null},...doc.items.slice(1)]};
    const previous = [PCB.opacity.via, PCB.layerAlpha("Multi")], draw = T.draw;
    try {
      if (mode==="translucent"){
        PCB.setOpacity("via",.65); PCB.setLayerOpacity("Multi",.7);
      }
      const [start, cache, target] = direction==="in" ? [3.1,3.5,4.8] : [8,7,3.6];
      warm(surface, doc, start, opts);
      warm(control, plain, start, opts);
      const prepared = move(surface, doc, cache, opts);
      move(control, plain, cache, opts);
      let copiedTitle = 0;
      T.draw = (ctx,item,...args) => {
        if (ctx === surface.ctx && item===title) copiedTitle++;
        return draw(ctx,item,...args);
      };
      const changed = move(surface, doc, target, opts), noMark = move(control, plain, target, opts);
      exact(reference, doc, target, opts);
      const local = compare(surface,reference,[via.x,via.y],Math.ceil(via.drill*target*devicePixelRatio/2)+1);
      const disjoint = compare(surface,control,[title.x+.9,title.y-.5],3);
      const row = {name:mode+" via mark, zoom "+direction, local, disjoint, copiedTitle, prepared, changed, noMark};
      cases.push(row);
      // A clipped covering stroke can round an edge channel by one level.
      if (local.max > (mode==="covered" ? 1 : 0) || disjoint.bytes || copiedTitle || !prepared.copied || !changed.copied || !noMark.copied) failures.push(row.name);
    } finally {
      T.draw = draw; PCB.setOpacity("via",previous[0]); PCB.setLayerOpacity("Multi",previous[1]);
      for (const s of [surface,reference,control]) {
        s.view.internals().surfacesLost(); s.canvas.remove();
      }
    }
  }
  return {dpr:devicePixelRatio, cases, failures};
};
