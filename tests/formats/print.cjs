"use strict";
// Printing and PDF (app/formats/print.js): the recording context, page planning, layer
// sets, colour modes, Smart PDF links and bookmarks, and AtriumPDF.export.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "connectivity", "pcb-appearance", "pcb-pours", "stackup", "sch-appearance", "sch-objects", "hierarchy",
  "vectorize", "pcb-text-rich", "pcb-text", "canvas", "zip", "fab-outputs", "path-record", "pdf", "print"]) {
  try { require(require("../support/app-source-paths.cjs").appFile(m + ".js")); } catch (e) { if (!/sch-objects|hierarchy/.test(m)) throw e; }
}
const P = AtriumPDF, PR = AtriumPrint, MM = 72 / 25.4;
const date = new Date(Date.UTC(2026, 10, 18));

// Sheet and drawing frames both depend on project parameters. Check the live
// render against a freshly loaded project for an edit, undo and redo.
{
  require("../../app/history/undo-store.js");require("../../app/formats/drawing-views.js");
  const u=AtriumUndoStore,p=Atrium.project("Title blocks",[]),history=[],future=[];
  p.parameters={CompanyName:"Atlas Devices"};
  const sch=p.documents[0];sch.sheet={size:"ANSI A",titleBlock:"ansi"};
  const drawing={name:"Assembly",kind:"drawing",id:"drawing-frame",items:[],drawing:{
    sheets:[{id:"frame",name:"Sheet 1",size:"A4",titleBlock:true}],views:[],revisions:[],parameters:{}}};
  p.documents.push(drawing);
  function paint(pr){
    const schPage=P.recorder(1200,900),sheet=pr.documents[0],d=pr.documents[2],page=P.recorder(1200,900);
    AtriumSchAppearance.page(schPage.ctx,sheet,10,null,null,pr);
    AtriumDrawingViews.frameAndTitle(page.ctx,{project:pr,doc:d,drawing:d.drawing,date},d.drawing.sheets[0],0,{ink:"#000",paper:"#fff",px:0});
    return [schPage.list,page.list];
  }
  u.reset();u.record(p);
  let revision=u.documentVersions(sch,p),outer=u.outer();
  const check=(company,changed)=>{
    const live=paint(p);assert.deepEqual(live,paint(JSON.parse(JSON.stringify(p))));
    for(const page of live)assert.ok(page.some(op=>op.k==="t" && op.u===company),"printed company "+company);
    const next=u.documentVersions(sch,p);
    if(changed){
      // A parameter edit has its own version: readers of other project records (rules) keep theirs.
      assert.ok(next.parameters>revision.parameters && u.outer()>outer);
      assert.equal(next.project,revision.project);
      assert.equal(next.library,revision.library);assert.equal(next.items,revision.items);
    }
    revision=next;outer=u.outer();
  };
  check("Atlas Devices",false);
  const before=u.mark(p);p.parameters.CompanyName="Orion Instruments";u.checkpoint(history,future,before,"Company");u.record(p);
  check("Orion Instruments",true);
  for(const [dir,value] of [[-1,"Atlas Devices"],[1,"Orion Instruments"]]){
    u.jump(history,future,u.mark(p),dir);u.record(p);check(value,true);
  }
  u.reset();
}

// ---- recording context ----
{
  const rec = P.recorder(200, 100, {unit: .5});
  const c = rec.ctx;
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.beginPath(); c.arc(10, 10, 5, 0, Math.PI * 2); c.closePath(); c.fillStyle = "#00ff00"; c.fill();
  const arc = rec.list[0];
  assert.equal(arc.d.filter(v => v === 2).length >= 4, true, "a full circle is four or more Béziers");
  assert.deepEqual(arc.d.slice(0, 3), [0, 15, 10], "device = unit × transform");
  assert.deepEqual(arc.c, [0, 1, 0, 1]);
  c.lineWidth = 3; c.setLineDash([2, 1]); c.strokeStyle = "rgba(0,0,255,.5)"; c.strokeRect(0, 0, 4, 4);
  const box = rec.list[1];
  assert.equal(box.w, 3); assert.deepEqual(box.dash, [2, 1]); assert.equal(box.a, .5);
  c.lineWidth = 0; assert.equal(c.lineWidth, 3, "invalid widths are ignored, as in canvas");
  c.font = "10px Helvetica"; c.textAlign = "center"; c.textBaseline = "alphabetic"; c.fillStyle = "#000";
  assert.equal(Math.round(c.measureText("AB").width * 1000), 13340);
  c.fillText("AB", 50, 20);
  const t = rec.list[2];
  assert.equal(t.k, "t"); assert.equal(t.s, "AB"); assert.deepEqual(t.m.map(v => +v.toFixed(3)), [10, 0, 0, -10, 43.33, 20]);
  c.fillText("1 kΩ", 0, 0);
  assert(rec.list.slice(3).some(op => op.k === "p" && op.cap === "round"), "Ω outside WinAnsi draws as stroke-font outline");
  c.fillText("too wide", 0, 0, 5);
  assert(Math.abs(rec.list.at(-1).m[0] / 10 * P.runs("too wide", "H").width * 10 - 5) < 1e-6, "maxWidth compresses horizontally");
  const p = new Path2D(); p.rect(0, 0, 10, 10);
  c.save(); c.clip(p); c.fill(p); c.restore(); c.fill(p);
  assert.ok(rec.list.at(-2).clip && !rec.list.at(-1).clip, "clip follows save/restore");
  assert.equal(rec.list.at(-1).d.length, 13, "recorded Path2D replays");
  c.beginPath(); c.moveTo(0, 0); c.arcTo(10, 0, 10, 10, 2); c.stroke();
  assert(rec.list.at(-1).d.includes(2), "arcTo makes a tangent arc");
  const svg = P.svg(200, 100, rec.list);
  assert(svg.startsWith("<svg") && svg.includes("<clipPath") && svg.includes("<text") && svg.endsWith("</svg>"));
}

// ---- the example project ----
const project = AtriumParts.example();
const parse = bytes => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return s; };
function xrefOK(bytes) {
  const s = parse(bytes), sx = +/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1], head = /^xref\n0 (\d+)\n/.exec(s.slice(sx));
  const rows = s.slice(sx + head[0].length).split("\n").slice(1, +head[1]);
  rows.forEach((r, i) => { const off = +r.slice(0, 10); assert.equal(s.slice(off, off + String(i + 1).length + 6), (i + 1) + " 0 obj"); });
  return s;
}
{
  const r = PR.build(project, {date, layerSets: ["top", "bottom", "assembly-top", "drill"]});
  assert.deepEqual(r.pages.map(p => p.kind), ["schematic", "pcb", "pcb", "assembly", "drill"]);
  assert.deepEqual(r.notes, []);
  assert(r.pages.every(p => Math.abs(p.w - 297 * MM) < .01 && Math.abs(p.h - 210 * MM) < .01), "A4 landscape by default (auto orientation)");
  assert.equal(r.links, 21, "7 schematic→top, 7 top→schematic, 7 bottom→schematic");
  const sch = r.pages[0], j1 = sch.marks.find(m => m.key === "part:link-J1");
  assert(j1 && j1.rect[0] < j1.rect[2] && j1.rect[1] < j1.rect[3]);
  assert(sch.list.some(op => op.k === "t" && op.u === "Analog front end"), "title block filled from the sheet");
  // Bottom set hides top copper and mirrors the view.
  const top = r.pages[1], bottom = r.pages[2];
  const red = l => l.some(op => op.c && op.c[0] > .9 && op.c[1] < .1 && op.c[2] < .1);
  assert(red(top.list) && !red(bottom.list), "top copper only on the top page");
  assert(bottom.list.some(op => op.c && op.c[2] > .9 && op.c[0] < .1), "bottom copper on the bottom page");
  const jTop = top.marks.find(m => m.key === "part:link-J1").rect, jBot = bottom.marks.find(m => m.key === "part:link-J1").rect;
  assert(Math.abs((jTop[0] + jTop[2]) / 2 - (top.w - (jBot[0] + jBot[2]) / 2)) < 1, "bottom view is mirrored about the page centre");
  // Text on the drill page includes the table.
  assert(r.pages[4].list.some(op => op.u === "Drill drawing" || op.u?.includes("Drill drawing")));
  const bytes = r.bytes(), s = xrefOK(bytes);
  assert.match(s, /\/Count 5/); assert.match(s, /\/PageMode \/UseOutlines/);
  assert.equal((s.match(/\/Subtype \/Link/g) || []).length, 21);
  // Same design, same options: same bytes.
  const again = PR.build(project, {date, layerSets: ["top", "bottom", "assembly-top", "drill"]}).bytes();
  assert(again.length === bytes.length && again.every((v, i) => v === bytes[i]), "deterministic");
}
// Negative coordinates, adjacent frames of different aspect ratios and an unframed label.
{
  const project = Atrium.project("Frame printing", []), doc = project.documents[0];
  doc.sheet = {infinite: true};
  const frame = (id, text, x, y, w, h) => ({id, kind: "textframe", role: "frame", text, x, y, w, h});
  const label = (id, text, x, y) => ({id, kind: "netlabel", text, x, y});
  doc.items = [frame("wide", "Power", -370, -60, 240, 100), frame("tall", "Control", -110, -60, 90, 170),
    label("inside-left", "LEFT_NET", -320, -30), label("inside-right", "RIGHT_NET", -90, 0), label("outside", "OUTSIDE_NET", 270, 0)];
  const options = {documents: [doc.id], date, paper: "A4", compress: false};
  const frames = PR.build(project, {...options, infiniteLayout: "frames", scale: 4});
  assert.deepEqual(frames.pages.map(p => p.title), [doc.name + " — Power", doc.name + " — Control"]);
  assert(frames.pages[0].w > frames.pages[0].h && frames.pages[1].w < frames.pages[1].h);
  assert.deepEqual(frames.pages.map(p => p.marks.map(m => m.net)), [["LEFT_NET"], ["RIGHT_NET"]]);
  const fit = PR.build(project, {...options, infiniteLayout: "fit", scale: 4});
  assert.equal(fit.pages.length, 1); assert.equal(fit.pages[0].marks.length, 3);
  const tiles = PR.build(project, {...options, infiniteLayout: "tile", infiniteScale: 1.5, tile: false});
  assert(tiles.pages.length > 2 && tiles.pages.every(p => p.tile && Math.abs(p.scale - 1.5 * MM) < 1e-9));
  assert(tiles.pages[0].list.some(op => op.dash && op.dash.length), "visible overlap line");
  assert(tiles.pages[0].list.some(op => op.u?.includes("overlap 6 mm")));
  for (const r of [fit, frames, tiles]) assert.match(xrefOK(r.bytes()), new RegExp("/Count " + r.pages.length + "\\b"));
  assert.throws(() => PR.build(project, {...options, infiniteLayout: "tile", infiniteScale: 100000}), /smaller tile scale/);
  doc.items = doc.items.filter(i => !i.role);
  assert.throws(() => PR.build(project, {...options, infiniteLayout: "frames"}), /has no frames/);
  assert.equal(PR.settle({infiniteLayout: "future", infiniteScale: -1}).infiniteLayout, "fit");
}
// Monochrome: every ink is black or white.
{
  const r = PR.build(project, {date, color: "mono", layerSets: ["top"]});
  for (const p of r.pages) for (const op of p.list) if (op.c) assert(op.c.slice(0, 3).every(v => v === 0) || op.c.slice(0, 3).every(v => v === 1));
  const g = PR.build(project, {date, color: "grey", layerSets: ["top"]});
  for (const p of g.pages) for (const op of p.list) if (op.c) assert(op.c[0] === op.c[1] && op.c[1] === op.c[2]);
}
// Exact scale, paper, orientation, documents.
{
  const board = project.documents.find(d => d.kind === "pcb");
  const r = PR.build(project, {date, documents: [board.id], layerSets: ["top"], scale: 1, paper: "Letter", orientation: "portrait"});
  assert.equal(r.pages.length, 1); assert(Math.abs(r.pages[0].scale - MM) < 1e-9, "1:1 is 72/25.4 pt per mm");
  assert(Math.abs(r.pages[0].w - 215.9 * MM) < .01 && r.pages[0].h > r.pages[0].w);
  assert(r.pages[0].list.some(op => op.u === "10 mm" || op.u === "5 mm" || op.u === "20 mm"), "scale bar");
  assert.throws(() => PR.build(project, {documents: []}), /Choose at least one/);
  assert.throws(() => PR.build(project, {paper: "B7"}), /Unknown paper/);
  const huge = PR.build(project, {date, documents: [board.id], layerSets: ["top"], scale: 40, tile: false});
  assert.match(huge.notes.join(" "), /clipped/);
  // Smart PDF tiling (draftsman): at a fixed scale a page larger than the paper is tiled.
  const tiled = PR.build(project, {date, documents: [board.id], layerSets: ["top"], scale: 8, paper: "A4"});
  assert.match(tiled.notes.join(" "), /tiled over \d+ pages/);
  assert(tiled.pages.length > 1 && tiled.pages.every(p => p.tile && p.tile.count === tiled.pages.length), "one page per tile");
  assert(tiled.pages.every(p => p.list.some(op => op.k === "t" && /^Tile \d+ of \d+/.test(op.u))), "tile labels");
  const root = c => c.parent ? root(c.parent) : c;
  assert(tiled.pages.every(p => p.list.filter(op => op.clip).length > 10 && p.list.filter(op => op.clip).every(op => root(op.clip).d[1] === p.area[0] && root(op.clip).d[2] === p.area[1])),
    "tile content is clipped to the printable area");
  assert.equal(new Set(tiled.pages.map(p => p.title)).size, tiled.pages.length);
  const bytes = tiled.bytes();
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "%PDF-1.4");
}
// Track captions belong to the editor. Opening the board can load the module
// but can't change the PDF's copper paths, authored text or searchable marks.
{
  const project = Atrium.project("PCB print captions", []), board = project.documents.find(doc => doc.kind === "pcb");
  const track = {id:"wide-track",kind:"track",layer:"Top",width:1.4,points:[[2,8],[22,8]],net:"CLK_MAIN"};
  const pad = {id:"standalone-pad",kind:"pad",layer:"Top",x:8,y:3,w:1,h:1,net:"PAD_NET"};
  const front = {id:"front-text",kind:"label",layer:"Silk",x:4,y:4,size:1,width:.1,text:"Front"};
  const back = {id:"back-text",kind:"label",layer:"Bottom silk",x:4,y:4,size:1,width:.2,text:"Back"};
  board.outline = [[0,0],[24,0],[24,12],[0,12]];
  board.items = [track,pad,front,back];
  const options = {date,documents:[board.id],layerSets:["top","bottom"],footer:false,viewerLayers:true,searchable:true};
  const runs = [options, {...options,layerSets:["top"],scale:12}, {...options,presentation:[{
    id:"front-view",title:"Front view",documentId:board.id,
    viewport:{pixelWidth:480,pixelHeight:300},camera:{cx:12,cy:6,scale:20,referenceScale:20},
    layers:{mode:"all",active:"Top",hidden:["Bottom silk"]}
  }]}];
  const cold = runs.map(o => PR.build(project,o).bytes({compress:false}));
  require(require("../support/app-source-paths.cjs").appFile("pcb-net-labels.js"));
  const [physical, tiled, saved] = runs.map((o,i) => {
    const print = PR.build(project,o), bytes = print.bytes({compress:false});
    assert(bytes.length === cold[i].length && bytes.every((v,n) => v === cold[i][n]),
      "same PDF bytes with the editor caption module loaded");
    assert.match(parse(bytes), /3 Tr [^\n]+\(CLK_MAIN\) Tj ET/, "searchable net text in the vector PDF");
    assert(!print.pages.some(p => p.list.some(op => op.k === "t" && [track.net,pad.net].includes(op.u))), "no painted track or pad captions");
    assert(print.pages.some(p => p.marks.some(mark => mark.net === track.net && mark.layer.name.endsWith(" · Top"))));
    assert(print.pages.some(p => p.list.some(op => op.k === "p" && op.d.length === 6 &&
      Math.abs(op.w - track.width * p.scale) < .01)), "vector copper stroke at the print scale");
    return print;
  });
  assert(tiled.pages.length > 1 && tiled.pages.every(page => page.tile), "fixed-scale output tiled");
  const textLayers = page => [front,back].filter(item => page.list.some(op => op.k === "p" &&
    op.layer?.name === board.name + " · " + item.layer)).map(item => item.layer);
  assert.deepEqual(physical.pages.map(textLayers),[["Silk"],["Bottom silk"]]);
  const [viewport] = saved.pages;
  const drawsText = item => viewport.list.some(op => op.k === "p" && !op.fill && op.cap === "round" &&
    Math.abs(op.w - item.width * viewport.scale) < .01);
  assert(drawsText(front) && !drawsText(back), "the viewport draws authored text only on its visible overlay");

  const rec = P.recorder(480,300), view = AtriumCanvas.create(rec.canvas), defs = new Map();
  view.restoreCamera({cx:12,cy:6,scale:40,referenceScale:40});
  view.render(board,defs,{layer:"Top",grid:false,origin:false,editorPane:true});
  assert(view.internals().netLabels().some(l => l.id === track.id), "zoomed editor paints the track caption");
  assert(rec.list.some(op => op.k === "t" && op.u === pad.net), "zoomed editor still paints the pad caption");
  view.restoreCamera({cx:12,cy:6,scale:4,referenceScale:20});
  view.render(board,defs,{layer:"Top",grid:false,origin:false,editorPane:true});
  assert.equal(view.internals().netLabels().length,0,"editor hides captions on narrow tracks at low zoom");
}
// Inner layers: one page each; plan without rendering.
{
  const p = JSON.parse(JSON.stringify(project)), board = p.documents.find(d => d.kind === "pcb");
  const options = PR.settle({layerSets: ["inner"], documents: [board.id]});
  board.items.push({id: "t-in1", kind: "track", layer: "Inner 1", net: "GND", width: .3, points: [[2, 2], [8, 2]]});
  assert.deepEqual(PR.plan(p, options).map(j => j.set.active), ["Inner 1"], "legacy boards derive the occupied stack");
  board.stackup = AtriumStackup.preset("4");
  assert.deepEqual(PR.plan(p, options).map(j => j.set.active), ["Inner 1", "Inner 2"], "the stored stack includes pad-only or empty faces");
}
// Finished copper has the cutters of its own depth, even over unrelated artwork.
{
  const p = Atrium.project("Printed drill depth", []), board = p.documents.find(d => d.kind === "pcb");
  board.outline = [[0,0],[20,0],[20,12],[0,12]];
  board.stackup = AtriumStackup.preset("4");
  const stock = (layer, points) => ({id:layer,kind:"graphic",layer,points,closed:true,fill:true});
  const strip = [[2,4],[15,4],[15,8],[2,8]], marker = [[2,1],[3,1],[3,2],[2,2]];
  board.items = [
    ...["Top","Bottom","Inner 2"].map(layer => stock(layer,strip)),
    ...["Silk","Bottom silk","Top mask","Top paste","Inner 4"].map(layer => stock(layer,marker)),
    {...stock("Assembly notes",[[20.1,5.5],[20.8,5.5],[20.8,6.5],[20.1,6.5]]),net:"USER_NOTE"},
    {id:"slot",kind:"pad",layer:"Multi",x:5,y:6,w:2,h:2,drill:.6,slotLength:2,slotAngle:90,plated:true,holeOnly:true},
    {id:"npth",kind:"pad",layer:"Multi",x:8,y:6,w:1,h:1,drill:.65,plated:false,holeOnly:true},
    ...[11,17].map(x => ({id:"blind-"+x,kind:"via",layer:"Multi",x,y:6,net:"BLIND",diameter:1,drill:.5,fromLayer:"Top",toLayer:"Inner 1"}))
  ];
  const options = {date,documents:[board.id],layerSets:["top","bottom","inner","mask-top","silk-top","composite"],footer:false,viewerLayers:true};
  function rings(path) {
    const out = [];
    for (let i=0;i<path.length;) {
      const op = path[i++];
      if (op === 3) continue;
      if (op === 0) out.push([]);
      if (op === 2) i += 4; // At these interior witnesses, a chord between cubic endpoints suffices.
      out.at(-1).push(path.slice(i,i+=2));
    }
    return out;
  }
  const hits = (path, [x,y]) => rings(path).filter(ring => AtriumGeometry.inRingAt(x,y,ring)).length % 2 === 1;
  const onLayer = (page, layer) => page.list.filter(op => op.layer?.name === board.name + " · " + layer);
  function fills(page, layer, at) {
    const point = page.map(at);
    return onLayer(page,layer).some(op => {
      if (!op.fill || !op.c.slice(0,3).some(c => c < .8) || !hits(op.d,point)) return false;
      for (let clip=op.clip;clip;clip=clip.parent) if (!hits(clip.d,point)) return false;
      return true;
    });
  }
  const result = PR.build(p,options), {pages} = result;
  const [top,bottom,inner1,inner2,mask,silk,composite] = pages;
  assert.deepEqual(pages.map(page => page.set),["top","bottom","inner","inner","mask-top","silk-top","composite"]);
  assert.ok(top.map([2,4])[0] < top.map([15,4])[0] && bottom.map([2,4])[0] > bottom.map([15,4])[0],"Bottom alone is mirrored");
  assert.deepEqual([top,bottom,inner2].map((page,i) => [[5,6.65],[8,6],[11,6],[5,7.2]].map(at => fills(page,["Top","Bottom","Inner 2"][i],at))),
    [[false,false,false,true],[false,false,true,true],[false,false,true,true]]);
  assert.ok(fills(top,"Multi",[17.4,6]),"the Top blind via land is visible on the incident layer");
  assert.ok(!fills(bottom,"Multi",[17.4,6]) && !fills(inner2,"Multi",[17.4,6]),"an off-layer blind via does not add copper");
  assert.ok(onLayer(inner1,"Inner 1").length === 0 && onLayer(mask,"Top mask").length > 0);
  assert.ok(onLayer(top,"Silk").length > 0 && onLayer(bottom,"Bottom silk").length > 0 && onLayer(silk,"Silk").length > 0);
  for(const layer of ["Top paste","Assembly notes","Inner 4"]){
    assert.equal(onLayer(top,layer).length,0,"hidden print layer " + layer);
    assert.ok(onLayer(composite,layer).length,"visible composite layer " + layer);
  }
  assert.ok(fills(composite,"Assembly notes",[20.4,6]),"a physically off-board user layer still paints on the composite");
  assert.ok(composite.marks.some(mark => mark.net === "USER_NOTE" && mark.layer?.name.endsWith(" · Assembly notes")));
  assert.ok(top.marks.some(mark => mark.net === "BLIND" && mark.layer?.name.endsWith(" · Multi")));
  assert.ok(![bottom,inner2].some(page => page.marks.some(mark => mark.net === "BLIND")),"searchable layer links follow the incident copper");
  const pdf = xrefOK(result.bytes({compress:false})), svg = P.svg(top.w,top.h,top.list);
  assert.match(pdf,/W\* n/,"physical copper uses a vector clip in the PDF");
  assert.match(svg,/clip-rule="evenodd"/,"the same layer clip reaches the browser print SVG");
  assert.match(pdf,/\/OCProperties/);
}

// Multi-sheet: sheet symbols and off-sheet connectors link between sheets; bookmarks per sheet, part and net.
{
  const p = JSON.parse(JSON.stringify(project)), first = p.documents[0];
  const child = {...JSON.parse(JSON.stringify(first)), id: "child-sheet", name: "Child sheet"};
  child.items = child.items.map(i => ({...i, id: "c-" + i.id})).filter(i => i.kind !== "part" || i.ref !== "J1");
  p.documents.splice(1, 0, child);
  first.items.push({id: "sym1", kind: "sheetsymbol", x: 30, y: 30, w: 20, h: 15, name: "Child", sheet: "child-sheet", entries: []},
    {id: "off1", kind: "offsheet", x: 60, y: 30, text: "SPI_CLK", angle: 0});
  child.items.push({id: "off2", kind: "offsheet", x: 60, y: 40, text: "SPI_CLK", angle: 0});
  const r = PR.build(p, {date, layerSets: ["top"]});
  assert.deepEqual(r.pages.map(x => x.doc), [first.id, "child-sheet", p.documents[2].id]);
  const s = xrefOK(r.bytes({compress: false}));
  const sheetLink = r.pages[0].marks.find(m => m.key === "sheet:child-sheet");
  assert(sheetLink, "sheet symbol mark");
  const off = r.pages[0].marks.find(m => m.key === "port:SPI_CLK");
  assert(off && r.pages[1].marks.find(m => m.key === "port:SPI_CLK"), "off-sheet connectors on both sheets");
  const annots = [...s.matchAll(/\/Rect \[[^\]]+\] \/Border \[0 0 0\] \/Dest \[(\d+) 0 R/g)].map(m => +m[1]);
  const pageObjs = /\/Kids \[([^\]]*)\]/.exec(s)[1].match(/\d+(?= 0 R)/g).map(Number);
  assert(annots.filter(n => n === pageObjs[1]).length >= 2, "links reach the child sheet (symbol and connector)");
  assert(annots.filter(n => n === pageObjs[0]).length >= 1, "the child sheet's connector links back");
  assert.match(s, /\/Title <feff004e006500740073>/i, "a Nets bookmark group");
  assert.match(s, /\/Title <feff0043006f006d0070006f006e0065006e00740073>/i, "a Components bookmark group for the board");
}
// AtriumPDF.export is the headless entry point (MCP export_pdf).
{
  const bytes = P.export(project, {date, layerSets: ["top"], links: false, bookmarks: false});
  assert(bytes instanceof Uint8Array); const s = xrefOK(bytes);
  assert(!/\/Annots/.test(s) && !/\/Outlines/.test(s));
}
console.log("print: ok");
