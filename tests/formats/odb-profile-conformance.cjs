"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {synthetic} = require("./odb-output.cjs");
const {bboxOf,holeShapes,parseExcellon,parseGerber,rasterize} = require("./gerber-compare.cjs");
const R = require("../support/odb-read.cjs");
const {AtriumODB:ODB,AtriumBoardShape:S,AtriumFabOutputs:F,AtriumPanel:P} = globalThis;
const date = "2000-01-01T00:30:00Z", options = {date,origin:"absolute"};
const film = (files,ext) => parseGerber(files.find(file => file.name.endsWith("." + ext)).content);
const exact = (actual,reference,message) => {
  const result = R.layerXor(actual,reference,{pixel:.005});
  assert.equal(result.differ,0,message + " " + JSON.stringify(result));
  return result;
};
const rectangle = (x0,y0,x1,y1) => S.polySegments([[x0,y0],[x1,y0],[x1,y1],[x0,y1]],true);
const circle = () => [S.arc([12,7],.8,0,0,false)];
function boardShape(board,cutouts) {
  board.boardShape = S.normalize({version:1,contour:S.polySegments(board.outline,true),cutouts,sig:S.signature(board.outline)});
}

{
  const {project,board} = synthetic();
  boardShape(board,[rectangle(2,2,5,5),circle()]);
  const product = R.read(ODB.build(project,board.id,options).bytes);
  const raw = product.entries.get("steps/pcb/profile"), pcb = product.steps.get("pcb");
  assert.deepEqual(pcb.profile.features[0].contours.map(r => [r.kind,r.segments]),[["I",4],["H",4],["H",3]]);
  assert.equal(raw.match(/^OC .* N$/gm)?.length,3,"The circular hole is three true counterclockwise arcs");
  const gerbers = F.build(project,board.id,options);
  exact(pcb.layers.get("profile_rout"),film(gerbers.files,"GM1"),"Standalone board with line and arc cutouts");
  boardShape(board,[rectangle(2,2,5,5),rectangle(3,3,4,4)]);
  assert.throws(() => ODB.build(project,board.id,options),/material island inside a cutout.*Export Gerber/);
  boardShape(board,[rectangle(2,2,5,5),rectangle(4,4,7,7),circle()]);
  const routed = ODB.build(project,board.id,options), overlapping = R.read(routed.bytes);
  const outline = overlapping.steps.get("pcb");
  assert.deepEqual(outline.profile.features[0].contours.map(r => [r.kind,r.segments]),[["I",4],["H",3]]);
  assert.equal(overlapping.matrix.layers.get("profile_rout").context,"BOARD");
  assert.deepEqual([...new Set(outline.layers.get("profile_rout").features.map(f => f.attributes[".drill"]+":"+f.attributes[".rout_chain"]))],["1:1","1:2","1:3","1:4"]);
  assert.ok(routed.warnings.some(w => w.includes("Intersecting cutout paths")));
  exact(outline.layers.get("profile_rout"),film(F.build(project,board.id,options).files,"GM1"),"All overlapping cuts are preserved on the board rout layer");
}

{
  const {project,board} = synthetic(), contour = [S.arc([9,6],5,0,0,true)];
  board.outline = S.flattenContour(contour);
  board.boardShape = {version:1,contour,sig:S.signature(board.outline)};
  const product = R.read(ODB.build(project,board.id,options).bytes);
  const raw = product.entries.get("steps/pcb/profile");
  assert.equal(raw.match(/^OC .* Y$/gm)?.length,3,"The circular island is three true clockwise arcs");
  exact(product.steps.get("pcb").layers.get("profile_rout"),film(F.build(project,board.id,options).files,"GM1"),"Circular PCB exterior");
}

{
  const rect = (type,x0,y0,x1,y1) => {
    const corners = [[x0,y0],[x0,y1],[x1,y1],[x1,y0]];
    const pts = type === "I" ? corners : [...corners].reverse();
    return ["OB " + pts[0].join(" ") + " " + type,...pts.slice(1).concat([pts[0]]).map(p => "OS " + p.join(" ")),"OE"];
  };
  const parse = (...rings) => R.profileOrFeatures(["UNITS=MM","F 1","S P 0",...rings.flat(),"SE"].join("\n"),{profile:true});
  const outer = rect("I",0,0,20,10), hole = rect("H",1,1,5,6);
  assert.doesNotThrow(() => parse(outer,hole));
  const relabel = (ring,kind) => [ring[0].replace(/[IH]$/,kind),...ring.slice(1)];
  assert.throws(() => parse(relabel(rect("H",0,0,20,10),"I")),/winding/);
  assert.throws(() => parse(outer,relabel(rect("I",1,1,5,6),"H")),/winding/);
  assert.throws(() => parse(outer,hole,rect("H",2,2,4,4)),/Nested holes/);
  assert.throws(() => parse(outer,hole,rect("I",2,2,4,4)),/one positive island/);
  assert.throws(() => parse(outer,hole,rect("H",5,2,8,4)),/touch or intersect/);
  assert.throws(() => parse(outer,hole,rect("H",4,0.5,8,2)),/touch or intersect/);
  assert.throws(() => parse(outer,rect("H",21,2,22,3)),/outside the island/);
}

{
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures/compat/projects/v1.5-altium-geometry.waffle"),"utf8"));
  const board = legacy.documents.find(doc => doc.kind === "pcb");
  const shape = S.fresh(board);
  assert.equal(S.profileContours(shape).length,3,"The legacy source retains both rings of its annular cutout");
  assert.throws(() => ODB.build(legacy,board.id,options),/material island inside a cutout.*Export Gerber/);
}

function tabPanel(cutout) {
  const {project,board} = synthetic();
  if (cutout) boardShape(board,[circle()]);
  const panel = P.create(project,{board:board.id,rows:1,cols:2,cells:{"0,1":{rotation:90}},...(cutout ? {mill:{radius:.5}} : {})});
  project.documents.push(panel);
  const panelOptions = {...options,panelId:panel.id};
  const {bytes} = ODB.build(project,board.id,panelOptions), result = R.read(bytes), pcb = result.steps.get("pcb"), step = result.steps.get("panel");
  const gerbers = P.build(project,panel,panelOptions), expected = film(gerbers.files,"GM1");
  const route = R.panelLayer(result,"profile_rout");
  const diff = exact(route,expected,"Fully expanded panel route at 5 µm");
  assert.deepEqual(step.repeat.map(({child,angle}) => [child,angle]),[["pcb",0],["pcb",90]]);
  assert.equal(pcb.layers.get("profile_rout").features.length,0);
  if (cutout) {
    assert.ok(step.layers.get("profile_rout").features.filter(f => f.op === "A").length > 2,"Panel routing has tool fillets and true rotated circular cutouts");
    assert.ok(pcb.profile.features[0].contours.some(r => r.kind === "H"),"The reusable PCB profile retains its cutout");
  }

  // Put the original child outline back on the rout layer to prove the comparison
  // and direct gap samples detect the unsafe cuts from repeated child outlines.
  const standalone = R.read(ODB.build(project,board.id,options).bytes).steps.get("pcb");
  pcb.layers.set("profile_rout",standalone.layers.get("profile_rout"));
  const unsafe = R.panelLayer(result,"profile_rout"), obsolete = R.layerXor(unsafe,expected,{pixel:.005});
  const {tabs,instances} = gerbers.model.panel;
  const betweenBoards = tabs.filter(tab => typeof tab.to === "number");
  assert.ok(betweenBoards.length,"Fixture needs breakaway tabs between repeated boards");
  for (const tab of betweenBoards) {
    assert.equal(tab.side,"right");
    const bounds = instances[tab.instance-1].box, x = bounds[2], y = -(tab.rect[1]+tab.rect[3])/2;
    const grid = {w:1,h:1,x0:x-.0025,y0:y-.0025,s:.005};
    assert.equal(rasterize(route.shapes,grid)[0],0,"Actual toolpath leaves the middle of a breakaway tab uncut");
    assert.equal(rasterize(unsafe.shapes,grid)[0],1,"Repeating the original PCB rout crosses the tab");
  }
  assert.ok(obsolete.differ > 100000,"The full expanded route comparison detects the old child outline duplication");
  console.log(JSON.stringify({panel:cutout ? "rotated arc cutout and route fillets" : "rotated two-up",pixelMm:diff.pixel,
    width:diff.width,height:diff.height,differ:diff.differ,withObsoleteChildRoutes:obsolete.differ}));

  assert.match(result.entries.get("misc/info"),/^CREATION_DATE=20000101\.003000$/m);
  assert.ok(gerbers.model.panel.texts[0].value.endsWith("2000-01-01"));
  exact(R.panelLayer(result,"silk_top"),film(gerbers.files,"GTO"),"Dated panel rail legend");
  assert.deepEqual(ODB.build(project,board.id,{...panelOptions,date:new Date(date)}).bytes,bytes,"Output-job ISO and Date formats give identical archives");
  const nextDay = R.read(ODB.build(project,board.id,{...panelOptions,date:"2000-01-02T00:30:00Z"}).bytes);
  assert.ok(R.layerXor(R.panelLayer(result,"silk_top"),R.panelLayer(nextDay,"silk_top")).differ > 0,"Changing the selected day changes the actual legend artwork");
  if (!cutout) {
    const withoutDate = ODB.build(project,board.id,{...panelOptions,date:undefined}).bytes;
    const atEpoch = ODB.build(project,board.id,{...panelOptions,date:"1970-01-01T00:00:00Z"}).bytes;
    assert.deepEqual(withoutDate,atEpoch,"Undated ODB++ panel exports use the archive epoch in their rail legend");
  }
}

tabPanel(false);
tabPanel(true);

{
  const {project,board} = synthetic();
  const unplated = board.items.find(item => item.id === "slot"), plated = board.items.find(item => item.id === "plated-slot");
  Object.assign(plated,{x:unplated.x,y:unplated.y,angle:unplated.angle,slotLength:unplated.slotLength-unplated.drill+plated.drill});
  board.origin = [3.25,8.125];
  const panel = P.create(project,{board:board.id,rows:1,cols:2,cells:{"0,1":{rotation:90}}});
  project.documents.push(panel);
  const opts = {...options,panelId:panel.id,origin:"user"}, product = R.read(ODB.build(project,board.id,opts).bytes);
  const gerbers = P.build(project,panel,opts), pcb = product.steps.get("pcb");
  const first = pcb.layers.get("rout_plated").drill.slots[0], second = pcb.layers.get("rout_nonplated").drill.slots[0];
  assert.deepEqual([first.a,first.b],[second.a,second.b],"The two slots share the same centerline");
  assert.deepEqual([first.plated,second.plated,first.d,second.d],[true,false,.55,.6]);
  for (const [layer,isPlated] of [["rout_plated",true],["rout_nonplated",false]]) {
    const reference = gerbers.files.filter(file => file.kind === "drill" && /;TYPE=PLATED/.test(file.content) === isPlated)
      .flatMap(file => parseExcellon(file.content).slots);
    assert.equal(reference.length,2,"Both copies keep the distinct route tool and plating");
    const shapes = holeShapes([{hits:[],slots:reference}]), expanded = R.panelLayer(product,layer);
    assert.equal(expanded.shapes.length,2);
    exact(expanded,{shapes,bbox:bboxOf(shapes)},"Translated and rotated " + layer + " compared with Excellon");
  }
}

{
  const {project,board} = synthetic();
  const panel = P.create(project,{board:board.id,rows:1,cols:2,cells:{"0,1":{rotation:180}},separation:"vscore",spacing:0});
  project.documents.push(panel);
  const panelOptions = {...options,panelId:panel.id};
  const gerbers = P.build(project,panel,panelOptions), product = R.read(ODB.build(project,board.id,panelOptions).bytes);
  const route = R.panelLayer(product,"profile_rout");
  assert.equal(route.shapes.length,4,"The rout layer holds the panel frame without board separation cuts");
  exact(route,film(gerbers.files,"GM1"),"V-scored panel frame");
  exact(R.panelLayer(product,"document_vcut"),film(gerbers.files,"GM2"),"V-score separation layer");
}
