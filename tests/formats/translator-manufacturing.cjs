"use strict";
// Run the worker contract against the existing manufacturing, STEP and MCAD geometry oracles.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
for (const m of ["obsolete-project","model","parts","spatial","net-intent","signals","altium-rules","component-classes","query","pcb-appearance",
  "pcb-draw","pcb-pours","board-shape","board-shape-sources","stackup","viastack","engine-core","rules","project-rules","polygon-pour","drc-pours",
  "vectorize","pcb-text-rich","pcb-text","designator-place","rigid-flex","flex-fold","zip","variants","bom","fab-outputs",
  "vendor/zipjs-deflate","panel","odb-eda","odb",
  "sexpr","step-import","step-export","ipc2581","dxf","mcad-xml","mcad","mcad-idx","mcad-idf","mcad-step","source-file",
  "translator-table","translator-registry","translator-provenance","translator-manufacturing","translators"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const T = AtriumTranslators, GC = require("./gerber-compare.cjs");
const date = "2026-06-15T12:00:00.000Z", p = AtriumParts.example(), doc = p.documents.find(d => d.kind === "pcb");
const original = JSON.stringify(p), opts = {documentId:doc.id, date, fileStem:"Sensor board"};
const direct = AtriumFabOutputs.build(p, doc, {...opts, date:new Date(date)});
const fab = T.export("fabrication", p, opts);
assert.deepEqual(fab.files, direct.files.map(f => ({name:f.name, text:f.content})));
assert.equal(fab.details.stem, opts.fileStem);
assert.equal(fab.details.files.length, direct.files.length);
assert.equal(fab.details.options.date, date);
const row = (r, kind) => r.report.kinds.find(k => k.kind === kind);
const allRefs = r => r.report.kinds.flatMap(k => k.references.map(x => x.source));
const top = fab.files.find(f => f.name.endsWith(".GTL"));
const only = T.export("gerber", p, {...opts, fileName:top.name});
const topFilm = GC.parseGerber(only.files[0].text);
assert.ok(topFilm.draws.length && topFilm.flashes.length);
assert.equal(only.files.length, 1);
assert.deepEqual(only.files[0], top);
assert.ok(allRefs(only).some(x => x.object?.includes(doc.items.find(i => i.kind === "track" && i.layer === "Top").id)));
const dr = T.export("excellon", p, opts);
assert.ok(dr.files.length);
assert.ok(dr.files.every(f => GC.parseExcellon(f.text).hits.length > 0));
assert.deepEqual(dr.files.map(f => f.name), fab.details.files.filter(f => f.kind === "drill").map(f => f.name));
const ipc = T.export("ipc2581", p, opts), checked = AtriumIPC2581.check(ipc.files[0].text);
assert.ok(checked.ok);
assert.equal(checked.counts.byLayer.TOP.pads, topFilm.flashes.length);
assert.equal(checked.counts.holes, dr.details.files.reduce((sum,f) => sum + f.stats.hits, 0));
const step = T.export("step", p, {documentId:doc.id, date});
assert.equal(step.files[0].text, AtriumSTEP.build(p, doc, {format:"step", timestamp:date.slice(0,19)}).data);
assert.equal(step.details.stats.parts, row(step, "Component body").approximated);
const glb = T.export("glb", p, {documentId:doc.id, date});
assert.equal(Buffer.from(glb.files[0].bytes.subarray(0,4)).toString(), "glTF");
assert.deepEqual(glb.files[0].bytes, AtriumSTEP.build(p, doc, {format:"glb"}).data);
assert.equal(JSON.stringify(p), original);
const file = (name, data) => ({name, bytes:typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data)});
const tray = file("tray.step", fs.readFileSync(path.join(__dirname, "../fixtures/mcad/tray.step")));
const incoming = T.import([tray]);
assert.equal(incoming.model.documents.length, 0);
assert.deepEqual(incoming.provenance.files[0].bytes, tray.bytes);
const mesh = incoming.provenance.mechanical.mesh;
assert.ok(mesh.stats.triangles > 50);
const faces = row(incoming, "STEP preview face");
assert.equal(faces.kept + faces.approximated + faces.dropped, mesh.stats.faces);
assert.ok(faces.approximated && faces.kept);
assert.ok(faces.references.every(x => /^#\d+$/.test(x.source.object)));
const boardInput = file("board.step", step.files[0].text);
const proposals = T.import([boardInput], {translator:"step", mode:"outline"});
assert.ok(proposals.provenance.mechanical.design.board.outline.length > 2);
assert.ok(row(proposals, "Mechanical board profile").approximated);
require("./mcad-board.js");
const mc = mcadBoard();
for (const id of ["idx","idf"]) {
  const r = T.export(id, mc, {date});
  const back = T.import(r.files.map(f => file(f.name, f.text)), {translator:id});
  assert.equal(back.provenance.mechanical.design.parts.length, r.details.stats.parts);
  assert.ok(back.provenance.mechanical.design.board.outline.length > 2);
}
const blank = Atrium.project("Missing outline"), blankBefore = JSON.stringify(blank);
for (const id of ["idx","idf"])
  assert.throws(() => T.export(id,blank,{date,captureBaseline:true}),
    {code:"mcad-outline-required",message:"Define a closed board outline before exporting to MCAD."});
assert.equal(JSON.stringify(blank),blankBefore);
const dx = T.export("dxf", mc, {holes:true, layers:["Mechanical 2"], mode:"primitives"});
assert.ok(dx.details.entities > 1);
const dxFile = file(dx.files[0].name, dx.files[0].text);
const drawing = T.import([dxFile]);
assert.ok(drawing.provenance.mechanical.drawing.layers.length);
const gm = T.import([dxFile], {translator:"dxf", mode:"graphics", layers:["HOLES"]});
assert.ok(gm.model.documents[0].items.length > 0);
assert.ok(gm.report.kinds.some(r => r.dropped));
assert.ok(gm.model.documents[0].items.every(i => i.kind === "graphic" && i.layer === "Mechanical 1"));
const profile = T.import([dxFile], {translator:"dxf", mode:"outline", layers:["BOARD_OUTLINE"]});
assert.ok(AtriumBoardShape.fresh(profile.model.documents[0]));
for (const id of ["gerber","excellon","ipc2581","odb"]) assert.equal(AtriumTranslatorRegistry.get(id).import, false);
assert.equal(AtriumTranslatorRegistry.get("odb").export, true);
assert.throws(() => T.export("odb",p,opts),/Enable ODB\+\+ output in Experimental features/);
const odb = T.export("odb",p,{...opts,odbEnabled:true});
assert.match(odb.files[0].name,/\.tgz$/);
assert.deepEqual([...odb.files[0].bytes.subarray(0,2)],[0x1f,0x8b]);
assert.throws(() => T.import([file("bad.step","ISO-10303-21;")]), /DATA/);
assert.throws(() => T.export("gerber",p,{documentId:"missing"}), /PCB/);
// One manufacturing session shares only the physical model and provenance
// trace. Each writer still emits its own report, independent of previous writers.
{
  const F = AtriumFabOutputs, P = AtriumTranslatorProvenance;
  const rows = [
    ["fabrication",{include:["gerber","drill","drillmap","drillreport"]}],
    ["fabrication",{include:["pnp"],pnp:true}],
    ["fabrication",{include:["assembly"],assemblyTop:true}],
    ["ipc2581",{}],["odb",{odbEnabled:true}]
  ];
  const generate = (send, project = p) => rows.map(([id,options])=>send(id,project,{...opts,...options}));
  const expected = generate(T.export);
  let analyses=0, projections=0, groups=0;
  globalThis.AtriumTranslatorProvenance={...P,toLegacy(...a){projections++;return P.toLegacy(...a);}};
  globalThis.AtriumFabOutputs={...F,analyse(...a) {
    analyses++;
    const model=F.analyse(...a), pairs=model.getDrillPairs;
    model.getDrillPairs=()=>{groups++;return pairs();};
    return model;
  }};
  try {
    const send = T.exportSession();
    assert.deepEqual(generate(send),expected);
    assert.deepEqual([analyses,projections,groups],[1,1,1]);
    assert.deepEqual(generate(T.exportSession()),expected);
    assert.deepEqual([analyses,projections,groups],[2,2,2]);

    const sourceA={fields:[{type:"document",id:doc.id,values:{sourceProject:"A"}}]};
    const sourceB={fields:[{type:"document",id:doc.id,values:{sourceProject:"B"}}]};
    const selected=[{provenance:sourceA},{provenance:sourceB},{strictLayers:true},{omitUnconnectedMidLayerPads:true}];
    for (const option of selected) {
      assert.deepEqual(send("gerber",p,{...opts,...option}),T.export("gerber",p,{...opts,...option}));
    }
    assert.equal(analyses,10,"source and film options have their own analysis");
    assert.equal(projections,8,"film options share only the source projection");

    const isolated=Atrium.clone(p), v=AtriumVariants.create(isolated,{name:"Assembly alternate"});
    AtriumVariants.setActive(isolated,v.id);
    for (const variant of [null,undefined,v.name]) {
      const options={...opts,variant,odbEnabled:true};
      assert.deepEqual(send("odb",isolated,options),T.export("odb",isolated,options));
    }
    assert.equal(analyses,15,"base and active remain distinct while the active ID and name share");
  } finally {globalThis.AtriumFabOutputs=F;globalThis.AtriumTranslatorProvenance=P;}
}

// The flattened panel and its source references can be shared by independently
// configured exports. Compare the complete responses with a fresh export.
{
  const project = Atrium.clone(p), board = project.documents.find(d => d.kind === "pcb");
  const part = board.items.find(i => i.kind === "part"), V = AtriumVariants;
  const variant = V.create(project,{name:"Unfitted panel assembly"});
  const fitted = V.create(project,{name:"Fitted panel assembly"});
  V.setParts(project,variant.id,[V.keyOf(part)],{fitted:false});
  const records = ["components6/data#100","components6/data#101"];
  board.pcbDrawing = {...board.pcbDrawing,annotations:{...board.pcbDrawing?.annotations,
    ...Object.fromEntries(records.map((id,i)=>[id,[{field:"ref",at:[i*2,0],angle:0,size:1,layer:"Silk"}]]))}};
  board.items.push(
    {id:"shared-id",kind:"track",layer:"Top",net:"ARC",width:.25,points:[[5,4],[4,3]],arc:{kind:"arc",c:[4,4],r:1,start:0,end:90,ccw:true}},
    {id:"shared-id",kind:"pad",layer:"Multi",x:14,y:6,w:2,h:1,angle:27,shape:"rect",drill:.6,slotLength:1.1,plated:false});
  const panel = AtriumPanel.create(project,{board:board.id,rows:1,cols:2,alternate:"cols"});
  const other = AtriumPanel.create(project,{board:board.id,rows:1,cols:1,name:"Single board panel"});
  project.documents.push(panel,other);
  const settings = {...opts,documentId:board.id,panelId:panel.id};
  const rows = [
    ["fabrication",{include:["gerber","drill","drillmap","drillreport"]}],
    ["fabrication",{include:["pnp"],pnpStyle:"jlc"}],
    ["fabrication",{include:["assembly"],date:"2026-06-15T23:30:00.000Z"}],
    ["ipc2581",{units:"in"}], ["odb",{odbEnabled:true}],
    ["excellon",{drillUnits:"in",drillFormat:"2:5"}]
  ];
  const before = JSON.stringify(project), send = T.exportSession();
  const run = (translate, [id, extra], snapshot = project) => translate(id,snapshot,{...settings,...extra});
  const expected = rows.map(r=>run(T.export,r));
  const P = AtriumPanel, F = AtriumFabOutputs, source = AtriumTranslatorProvenance;
  let flattened = 0, repeats = 0, projections = 0, layouts = 0, boards = 0;
  globalThis.AtriumPanel = {...P,
    analyse(project,panel,options,prepared) {
      if (options.odbRepeat) repeats++; else flattened++;
      return P.analyse(project,panel,options,prepared);
    },
    prepare(...args) { layouts++; return P.prepare(...args); }
  };
  globalThis.AtriumFabOutputs = {...F, analyse(...args) { boards++; return F.analyse(...args); }};
  globalThis.AtriumTranslatorProvenance = {...source,toLegacy(...args) {
    projections++;
    return source.toLegacy(...args);
  }};
  try {
    assert.deepEqual(rows.map(r=>run(send,r)),expected);
    assert.deepEqual([flattened,repeats,projections,layouts,boards],[1,1,1,1,1],"Both panel representations share the layout and source board");
    const fresh = T.exportSession();
    const backwards = [rows[4], ...rows.slice(0,4), rows[5]].map(r=>run(fresh,r));
    assert.deepEqual(backwards,[expected[4], ...expected.slice(0,4), expected[5]]);
    assert.deepEqual([flattened,repeats,projections,layouts,boards],[2,2,2,2,2],"A new job starts fresh and can prepare either panel representation first");
  } finally {
    globalThis.AtriumPanel = P;
    globalThis.AtriumFabOutputs = F;
    globalThis.AtriumTranslatorProvenance = source;
  }
  const [films,pnp] = expected;
  const panelCopper = GC.parseGerber(films.files.find(f=>f.name.endsWith(".GTL")).text);
  assert.equal(panelCopper.draws.filter(row => row.arc && Math.abs(row.width - .25) < 1e-9).length, 2, "Both panels retain the true track arc");
  assert.ok(films.files.some(f=>f.name.endsWith(".TXT") && GC.parseExcellon(f.text).slots.length === 2), "Both panels retain the routed slot");
  const revision = {kind:"snapshot", projectId:project.id, rootId:panel.id, generation:"mixed-provenance"};
  const view = AtriumResolvedGeometry.read({kind:"snapshot", project, root:panel, revision});
  const [track, pad] = board.items.filter(i => i.id === "shared-id"), identify = AtriumGeometryReceipts.itemOwner;
  for (const path of [["0,0"], ["0,1"]]) {
    const trace = identify(view, track, board.id, path), slot = identify(view, pad, board.id, path);
    assert.ok(trace.ambiguous && slot.ambiguous);
    assert.notEqual(trace.owner.id, slot.owner.id);
    assert.equal(view.owner(trace.owner).features[0].ink.kind, "stroke");
    assert.equal(view.owner(slot.owner).bores[0].cutter.kind, "slot");
  }
  assert.throws(() => identify(view, {...track}, board.id, ["0,0"]), /actual authored object/);
  assert.ok(row(films,"Panel stroke").references.length && row(films,"Panel drill").references.length, "Panel exports attribute plotted features");
  assert.equal(pnp.details.files[0].stats.components,2 * board.items.filter(i=>i.kind === "part").length);
  if (process.versions.node) {
    const odbPanel = require("../support/odb-read.cjs").read(expected[4].files[0].bytes);
    assert.deepEqual(odbPanel.steps.get("panel").repeat.map(r=>[r.child,r.angle]),[["pcb",0],["pcb",180]]);
  }
  function check(id, extra, snapshot = project) {
    const want = run(T.export,[id,extra],snapshot), got = run(send,[id,extra],snapshot);
    assert.deepEqual(got,want);
    return want;
  }
  const altered = check("fabrication",{include:["pnp"],pnpStyle:"jlc",variant:variant.id});
  assert.equal(altered.details.files[0].stats.components,pnp.details.files[0].stats.components - 2);
  const selectedVariant = {id:fitted.id}, variantOptions = {include:["pnp"],variant:selectedVariant};
  assert.equal(check("fabrication",variantOptions).details.files[0].stats.components,pnp.details.files[0].stats.components);
  selectedVariant.id = variant.id;
  assert.equal(check("fabrication",variantOptions).details.files[0].stats.components,altered.details.files[0].stats.components);
  selectedVariant.id = "invalid";
  assert.throws(()=>run(send,["fabrication",variantOptions]),/There is no assembly variant/);
  const smaller = check("fabrication",{include:["pnp"],pnpStyle:"jlc",panelId:other.id});
  assert.equal(smaller.details.files[0].stats.components,pnp.details.files[0].stats.components / 2);
  const inline = Atrium.clone(panel), inlineOptions = {panelId:inline,include:["pnp"]};
  const two = check("fabrication",inlineOptions);
  inline.panel.cols = 1;
  assert.equal(check("fabrication",inlineOptions).details.files[0].stats.components,two.details.files[0].stats.components / 2);
  const nextDay = check("gerber",{date:"2026-06-16T00:00:00.000Z"});
  assert.notDeepEqual(nextDay.files.find(f=>f.name.endsWith(".GTO")),films.files.find(f=>f.name.endsWith(".GTO")));
  check("fabrication",{omitUnconnectedMidLayerPads:true});
  const imported = {fields:[{type:"item",id:part.id,values:{sourceRecord:records[0]}}]};
  const legend = result => result.files.find(f=>f.name.endsWith(".GTO")).text;
  const oldLegend = legend(check("gerber",{provenance:imported}));
  imported.fields[0].values.sourceRecord = records[1];
  assert.notEqual(legend(check("gerber",{provenance:imported})),oldLegend,"A mutable source record moves the plotted designator");
  const changed = Atrium.clone(project);
  changed.documents.find(d=>d.id===board.id).items.find(i=>i.id==="shared-id").width *= 2;
  const editedFilm = check("gerber",{},changed);
  assert.notDeepEqual(editedFilm.files.find(f=>f.name.endsWith(".GTL")),films.files.find(f=>f.name.endsWith(".GTL")));
  const rotated = Atrium.clone(project);
  rotated.documents.find(d=>d.id===panel.id).panel.cells["0,1"] = {rotation:0};
  assert.notDeepEqual(check("fabrication",rows[1][1],rotated).files,pnp.files);
  assert.notDeepEqual(check("odb",rows[4][1],rotated).files,expected[4].files);
  assert.throws(()=>run(send,["gerber",{documentId:"invalid"}]),/Choose a PCB layout/);
  assert.equal(JSON.stringify(project), before);
}

console.log("Manufacturing translator: " + fab.files.length + " exact fabrication outputs, " + checked.counts.holes + " holes, " +
  mesh.stats.faces + " source-addressed STEP preview faces; AP214, GLB, IDF, IDX and DXF match their geometry engines.");

// Unmodified PiDP-11 Rev A Gerbers and NC drill in the licensed fixture. Compare source positions,
// actual pad sizes and drill tools under the same 0.255 µm resolution as the full release oracle.
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const m of ["sch-objects","hierarchy","altium-ids","pdf-fonts","altium-typefaces","sch-import","pcb-import","io","connectivity","import-link","import-rules"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const folder = path.join(__dirname, "../fixtures/altium/pidp11-io-expander"), originalFilm = ext =>
  fs.readFileSync(path.join(folder, "altium-outputs-reva", "PiDP11IOExpander." + ext), "utf8");
const pin = Atrium.project("PiDP-11 I/O Expander");
pin.documents = []; pin.library = [];
for (const name of ["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"]) {
  const r = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(folder, name))));
  pin.documents.push(...(r.documents || [])); pin.library.push(...(r.library || []));
  if (r.manifest?.parameters) pin.parameters = {...r.manifest.parameters};
}
AtriumImportLink.reconcile(pin, pin.documents);
const pcb = pin.documents.find(d => d.kind === "pcb");
AtriumImportRules.apply(pcb, pin, new Map(pin.library.map(d => [d.id, d])));
const legacy = AtriumFabOutputs.build(pin, pcb.id, {date:new Date(date), fileStem:pcb.name});
const provenance = {version:1, files:[]}, clean = AtriumTranslatorProvenance.separate(pin, provenance);
const translated = T.export("fabrication", clean, {documentId:pcb.id, date, fileStem:pcb.name, provenance});
assert.deepEqual(translated.files, legacy.files.map(f => ({name:f.name, text:f.content})));
const tolerance = .000255;
for (const ext of ["GTL","GBL","GTS","GBS","GTP"]) {
  const measures = GC.compareFlashes(GC.parseGerber(originalFilm(ext)), GC.parseGerber(translated.files.find(f => f.name.endsWith("." + ext)).text));
  assert.equal(measures.matched, measures.ref, ext);
  assert.equal(measures.matched, measures.out, ext);
  assert.ok(measures.maxPosDev <= tolerance && measures.maxSizeDev <= tolerance, ext + " flash position/size");
}
const nc = translated.files.filter(f => translated.details.files.find(d => d.name === f.name)?.kind === "drill").map(f => GC.parseExcellon(f.text));
const holes = GC.compareDrills(GC.parseExcellon(originalFilm("TXT")), {hits:nc.flatMap(d => d.hits), slots:nc.flatMap(d => d.slots)});
assert.equal(holes.matched, 95);
assert.deepEqual(holes.outTools, holes.refTools);
assert.ok(holes.maxPosDev <= tolerance && holes.maxDiaDev <= tolerance);
console.log("PiDP-11: " + translated.files.length + " identical files and " + holes.matched + " independently measured drill hits.");

// A retained Altium signal store is a real input to scoped clearances. Export
// the verified source island, then move copper and require a new fill.
{
  const A = Atrium, P = AtriumPolygonPour, F = AtriumFabOutputs, model = A.project("Stored source copper");
  const board = model.documents.find(d => d.kind === "pcb");
  board.outline = [[0,0],[20,0],[20,20],[0,20]];
  board.sourceClasses = ["RECORD=Class|KIND=0|NAME=Power|M0=GND"];
  const rules = AtriumRules.create(), scoped = rules.list.find(rule => rule.type === "clearance");
  scoped.scope = {languageVersion:1,source:'object in class "Power" and width < 0.25 mm'};
  AtriumRules.store(board,model,rules);
  assert.ok(P.needsScopeTrace(AtriumRules.stored(board,model)),"The project rule book applies the scoped clearance");
  const zone = P.make([[1,1],[18,1],[18,18],[1,18]],{layer:"Top",net:"GND",removeDeadCopper:false});
  const track = {id:A.id(),kind:"track",layer:"Top",net:"SIGNAL",width:.2,points:[[4,5],[10,5]]};
  board.items = [zone,track];
  model.signals = A.clone(AtriumSignals.fromLegacy(model));
  const island = AtriumPCBPours.region([[[2,2],[9,2],[9,4],[2,4]]],"Top","GND",{source:"altium",polygon:zone.id,links:[]});
  board.pcbDrawing = {annotations:{},sourceFill:true,pours:[island]};
  AtriumPCBPours.storeSignature(board,new Map(),model);
  P.adoptSourceCopper(model);
  assert.equal(F.analyse(model,board.id).copper.state,"current");
  const options = {documentId:board.id,date,origin:"absolute",include:["gerber"]};
  const gerber = project => project.files.find(f => f.name.endsWith(".GTL")).text;
  const current = gerber(T.export("fabrication",model,options));
  const source = {version:1,files:[],generatedSignals:A.clone(model.signals)};
  const native = AtriumTranslatorProvenance.separate(model,source);
  assert.equal(AtriumTranslatorProvenance.toLegacy(native,source).signals,undefined,"Legacy design projection is unchanged");
  assert.equal(gerber(T.export("fabrication",native,{...options,provenance:source})),current,"Untouched scoped source fill survives the manufacturing projection");
  const saved = JSON.stringify(board.pcbDrawing);
  track.points[0][0] += 1;
  const edited = F.analyse(model,board.id);
  assert.deepEqual(edited.copper.filled,[zone.id],"A real edit invalidates the preserved source fill");
  const updated = gerber(T.export("fabrication",native,{...options,provenance:source}));
  assert.notEqual(updated,current);
  assert.equal(updated,gerber(T.export("fabrication",native,options)),"Restored metadata does not override an edited copper fill");
  assert.equal(JSON.stringify(board.pcbDrawing),saved,"The fabricated fill on the export copy leaves the source board alone");
}

// Load the native KiCad page engine independently of the worker module registry.
for (const m of ["panel","sch-appearance","schematic-output","kicad-export","kicad-schematic","translator-exports","output-jobs"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
// Saved jobs keep their packing, layer, units and naming choices across synchronous and worker calls.
const jobs = {name:"Manufacturing checks", folder:"", board:doc.id, outputs:[
  {kind:"gerber", options:{x2:false, pack:"Plain-RS274X.zip", units:"in", drillOrigin:"absolute"}},
  {kind:"ipc2581", options:{units:"inch", impedance:true}}, {kind:"pnp", options:{style:"jlc", name:"placements.csv"}},
  {kind:"assembly", options:{bottom:false}}, {kind:"step", options:{components:false}},
  {kind:"kicad", options:{sheets:true}}
]};
const hashes = r => r.files.map(f => [f.name, AtriumOutputJobs.sha256(f.data)]);
function compareJob(project, set) {
  const old = AtriumOutputJobs.run(project, set, {date}), call = AtriumOutputJobs.run(project, set, {date, translate:T.export});
  assert.equal(old.report.ok, true, JSON.stringify(old.report.failed));
  assert.equal(call.report.ok, true, JSON.stringify(call.report.outputs.map(r => [r.kind, r.message])));
  assert.deepEqual(hashes(call), hashes(old), set.name);
  assert.ok(call.report.outputs.every(r => r.translationReports?.length));
  return {old, call};
}
const boardRun = compareJob(p, jobs);
const sheet = p.documents.find(d => d.kind === "schematic"), connector = sheet.items.find(i => i.ref === "J1");
const sheetOutput = boardRun.old.files.find(f => f.name === "KiCad/Analog front end.kicad_sch");
assert.ok(sheetOutput, "The saved job includes the KiCad schematic");
const sheetText = new TextDecoder().decode(sheetOutput.data);
assert.equal(sheetText.match(/\(paper [^\n]+\)/)?.[0], '(paper "User" 292.1 193.04)', "The native job uses the fixture's page layout");
const connectorBlock = sheetText.split("\n").find(line => line.includes(`(uuid ${AtriumKiCad.symbolUuid(sheet, connector)})`));
assert.ok(connectorBlock?.includes("(at 91.44 91.44 0)"), "The KiCad job preserves J1's identity at its page-relative position");
const panelProject = structuredClone(p), panel = AtriumPanel.create(panelProject, {board:doc.id});
panel.panel = AtriumPanel.normalize({...panel.panel, rows:1, cols:2});
panelProject.documents.push(panel);
const panelRun = compareJob(panelProject, {...jobs, name:"Two-board panel", panel:panel.id, outputs:[
  {kind:"gerber", options:{profileOnly:true}}, {kind:"step", options:{components:false}}, {kind:"ipc2581"}, {kind:"pnp"}
]});
assert.ok(panelRun.call.report.outputs[0].translationReports[0].kinds.some(r => r.kind === "Board profile" && r.kept));
console.log("Saved output jobs: " + boardRun.call.files.length + " board and " + panelRun.call.files.length + " panel files match the original named outputs and hashes.");

const graphicRows = gm.report.modelObjects.find(r => r.documentKind === "pcb" && r.kind === "graphic");
assert.equal(graphicRows.count, gm.model.documents[0].items.length);
assert.ok(graphicRows.references.every(r => r.source.object && gm.model.documents[0].items.some(i => i.id === r.id)));
const idfWithPins = T.export("idf", mc, {date, pinHoles:true, vias:true});
const idfRead = T.import(idfWithPins.files.map(f => file(f.name, f.text)).reverse(), {translator:"idf"});
assert.equal(idfRead.provenance.files[0].name, idfWithPins.files[0].name, "MCAD review cites the board even when its package library was selected first");
assert.ok(row(idfRead, "IDF package contour").dropped > 0);
const emn = idfWithPins.files[0];
const extraDrill = emn.text.replace(".END_DRILLED_HOLES", "0.25 4 5 PTH BOARD VIA ECAD\n.END_DRILLED_HOLES");
const pins = T.import([file(emn.name, extraDrill)], {translator:"idf"});
assert.ok(row(pins, "Drilled hole").references.some(r => r.status === "dropped" && /^DRILLED_HOLES\//.test(r.source.object)));
const baselineFile = fs.readFileSync(path.join(__dirname, "../fixtures/mcad/baseline.idx"), "utf8");
const asSlot = baselineFile.replaceAll('geometryType="KEEPOUT_AREA_COMPONENT"', 'geometryType="HOLE_NON_PLATED"');
const slots = T.import([file("slotted.idx", asSlot)], {translator:"idx"});
assert.ok(row(slots, "Drilled hole").references.some(r => r.status === "approximated" && r.source.object && /inscribed diameter/.test(r.reason)));
const base = T.export("idx", mc, {date, captureBaseline:true});
assert.ok(base.details.baseline.seq === 1 && Object.keys(base.details.baseline.objects).length > 1);
const placed = structuredClone(mc), boardForChanges = placed.documents.find(d => d.kind === "pcb");
AtriumMCAD.store(boardForChanges).baseline = base.details.baseline;
boardForChanges.items.find(i => i.kind === "part").x += 1;
const changes = T.export("idx", placed, {date, captureBaseline:true, mode:"changes"});
assert.deepEqual([changes.details.stats.changed,changes.details.baseline.seq,AtriumMCAD.peek(boardForChanges).baseline.seq],[1,2,1]);

// This exercises the same static HTTP worker and self-contained desktop worker as the live client.
// The established worker harness gives the guest JS a browser worker global with no CommonJS access.
async function workerBindings() {
  const {Worker} = require("node:worker_threads");
  require("../../app/worker-source.js");
  require("../../app/formats/release.js");
  for (const source of [undefined, AtriumImportWorkerSource]) {
    const worker = new Worker(path.join(__dirname, "../workers/import-worker.cjs"), {workerData:{source}});
    let id = 0;
    try {
      await new Promise((resolve, reject) => { worker.once("error", reject); worker.once("message", msg => msg.type === "ready" ? resolve() : reject(Error(msg.message))); });
      function request(message) {
        const next = ++id;
        return new Promise((resolve, reject) => {
          const done = msg => {
            if (msg.id !== next || msg.type === "progress") return;
            worker.off("message", done);
            worker.off("error", failed);
            msg.type === "result" ? resolve(msg.value) : reject(Error(msg.message));
          };
          const failed = error => { worker.off("message", done); reject(error); };
          worker.on("message", done); worker.once("error", failed);
          worker.postMessage({id:next, ...message});
        });
      }
      const client = {export:(translator, model, options) => request({operation:"translate-export", translator, model, options})};
      const got = await client.export("fabrication", p, opts);
      assert.deepEqual(got.files, fab.files);
      const gotGLB = await client.export("glb", p, {date});
      assert.deepEqual(gotGLB.files[0].bytes, glb.files[0].bytes);
      const received = await request({operation:"translate-import", files:[{name:tray.name, buffer:tray.bytes.buffer}], options:{translator:"step"}});
      assert.deepEqual(received.provenance.files[0].bytes, tray.bytes);
      assert.equal(received.provenance.mechanical.mesh.stats.triangles, mesh.stats.triangles);
      // Exercise the desktop Release page's actual interceptor and cache using the worker above.
      globalThis.document = {};
      globalThis.AtriumLazy = {need: async name => { assert.equal(name,"AtriumTranslatorClient"); return client; }};
      const cache = AtriumRelease.createCache(), group = {files:[]};
      const release = await AtriumRelease.generate(p, jobs, {date, cache, provenance:[group]});
      assert.ok(release.report.ok, JSON.stringify(release.report.outputs.map(r => [r.kind,r.message])));
      assert.deepEqual(hashes(release), hashes(boardRun.old));
      assert.equal(release.stats.worker, jobs.outputs.length);
      assert.ok(release.report.outputs.every(r => r.translationReports.length));
      const onceMore = await AtriumRelease.generate(p, jobs, {date, cache, provenance:[group]});
      assert.equal(onceMore.stats.cached, jobs.outputs.length);
      const otherImport = await AtriumRelease.generate(p, jobs, {date, cache, provenance:[{files:[]}]});
      assert.equal(otherImport.stats.cached, 0);
      console.log((source ? "Embedded" : "Static") + " isolated worker matches all 14 fabrication files, mesh and " + jobs.outputs.length + " desktop release rows.");
    } finally {
      delete globalThis.document; delete globalThis.AtriumLazy;
      await worker.terminate();
    }
  }
}
if (process.argv.includes("--workers")) workerBindings().catch(error => { console.error(error); process.exitCode = 1; });
