"use strict";
// KiCad export fidelity: export a board with every exported object kind, read it back with
// Waffle's own KiCad importer (import-kicad.js) and compare counts, nets and geometry.
//   1. The built-in example board plus polygon pours (poured, holes and all), a hatched pour,
//      a pour cut-out, keep-outs, teardrops, net-assigned fills, text, linear / aligned / radial
//      dimensions, net classes, design rules and a differential pair.
//   2. The .kicad_pro and .kicad_dru companions: net classes come back as per-net rules.
//   3. exportProject: a whole KiCad project (board, rules, root sheet) in one zip.
//   4. Optional: --real <dir | board.kicad_pcb …> imports every .kicad_pcb (a .kicad_pro beside it too), exports it, imports the
//      export and compares. Prints one line per board.
// Runs under Node and under the JSC shim (scripts/test-jsc.sh).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "board-shape-sources", "stackup", "query", "viastack", "rooms", "component-classes", "pcb-pours", "polygon-pour",
  "net-intent", "signals", "rules", "pcb-text-rich", "pcb-text", "pcb-draw", "teardrops", "zip", "kicad-export", "kicad-schematic", "import-link", "sexpr", "import-kicad"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, K = AtriumKiCad, I = AtriumImportFormats, PP = AtriumPolygonPour, R = AtriumRules, D = AtriumPCBDraw, enc = new TextEncoder();
const file = (name, text) => ({name, bytes: enc.encode(text)});
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const nearP = (p, q, tol = 1e-3) => near(p[0], q[0], tol) && near(p[1], q[1], tol);
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
const area = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const ringsOf = region => AtriumPCBPours.contours(region).map(xy => { const r = []; for (let i = 0; i < xy.length; i += 2) r.push([xy[i], xy[i + 1]]); return r; });
// Copper area of a stored region: outline minus holes (or one fractured ring).
const regionArea = region => { const rs = ringsOf(region), a = rs.map(r => Math.abs(area(r))), big = Math.max(...a); return rs.length === 1 ? a[0] : 2 * big - a.reduce((s, v) => s + v, 0); };
function parse(text) {
  const tokens = text.match(/\(|\)|"(?:\\.|[^"\\])*"|[^()\s]+/g), stack = [[]];
  for (const t of tokens) {
    if (t === "(") { const v = []; stack.at(-1).push(v); stack.push(v); }
    else if (t === ")") { assert.ok(stack.length > 1, "unbalanced )"); stack.pop(); }
    else stack.at(-1).push(t.startsWith('"') ? JSON.parse(t) : t);
  }
  assert.equal(stack.length, 1, "unbalanced ("); return stack[0][0];
}
const kids = (v, name) => v.filter(i => Array.isArray(i) && i[0] === name);
function reimport(out) {
  const results = I.readSet([file(out.name, out.content), ...(out.files || []).filter(f => f.name.endsWith(".kicad_pro")).map(f => file(f.name, f.content))]);
  const p = A.project("Imported"); p.documents = results.flatMap(r => r.documents); p.library = results.flatMap(r => r.library);
  AtriumImportLink.reconcile(p, p.documents); A.validate(p);
  return {project: p, board: p.documents.find(d => d.kind === "pcb")};
}
const summary = doc => ({
  parts: doc.items.filter(i => i.kind === "part").length, tracks: doc.items.filter(i => i.kind === "track").reduce((s, t) => s + t.points.length - 1, 0),
  vias: doc.items.filter(i => i.kind === "via").length, pours: doc.items.filter(i => i.kind === "polygon" && !i.cutout).length,
  nets: new Set(doc.items.flatMap(i => [i.net, ...Object.values(i.pinNets || {})]).filter(Boolean)).size
});

// Preferred via sizes and DRC bounds are independently authored (Task 63 F1).
{
  for(const f of ["router","format-2-codec","format-2-units","format-2-values","format-2-model"])
    require(require("../support/app-source-paths.cjs").appFile(f+".js"));
  const native=A.project("Via classes"), d=A.sheet("pcb","F1");
  native.documents=[d];
  d.outline=[[0,0],[20,0],[20,14],[0,14]];
  d.items=[
    ...[[.95,.4],[.76,.4],[.95,.36]].map(([diameter,drill],i)=>({id:"via-"+i,kind:"via",layer:"Multi",net:"POWER",x:10+i*2,y:4,diameter,drill})),
    {id:"signal",kind:"track",layer:"Top",net:"SIGNAL",width:.25,points:[[1,10],[4,10]]}
  ];
  const power={kind:"netclass",value:"Power Class"}, signal={kind:"netclass",value:"Signal Class"}, all={kind:"all"};
  const rule=(name,scope,fields,priority)=>({id:name,name,type:"viaStyle",scope,enabled:true,priority,...fields});
  const preferences=[
    rule("POWER placement",{kind:"net",value:"POWER"},{diameterPreferred:1.1,holePreferred:.45},1),
    rule("SIGNAL placement",signal,{diameterPreferred:.54,holePreferred:.28},2),
    rule("Default placement",all,{diameterPreferred:.54,holePreferred:.28},3)
  ];
  const bounds=[
    rule("POWER limits",power,{diameterMin:.8,holeMin:.37},4),
    rule("SIGNAL limits",signal,{diameterMin:.42,holeMin:.24},5),
    rule("Board diameter",all,{diameterMin:.42},6)
  ];
  R.store(d,native,R.normalize({list:[...preferences,...bounds],netClasses:{"Power Class":["POWER"],"Signal Class":["SIGNAL"]}}));
  function verify(p,checks=true){
    const doc=p.documents.find(d=>d.kind==="pcb"), opts={project:p}, resolve=R.resolver(doc,opts);
    for(const [net,wanted] of [["POWER",[1.1,.45,.8,.37]],["SIGNAL",[.54,.28,.42,.24]]]){
      const {diameter,drill,minDiameter,minDrill}=resolve.viaLimits(net);
      assert.deepEqual([diameter,drill,minDiameter??0,minDrill],checks?wanted:[...wanted.slice(0,2),0,0]);
      const placed=AtriumViaStack.place(doc,{id:"new-via",net,x:4,y:4},{...opts,obeyRules:true});
      assert.deepEqual([placed.diameter,placed.drill],wanted.slice(0,2));
    }
    const plan=AtriumRouter.begin(doc,new Map(),{start:[3,2],layer:"Top",net:"POWER",project:p});
    assert.deepEqual(plan.state.via,{diameter:1.1,drill:.45});
    const result=R.drc(doc,new Map(),R.stored(doc,p),{...opts,types:["viaStyle","holeSize"],scopes:false});
    assert.deepEqual(result.violations.map(v=>[v.actual,v.required]).sort(),checks?[[.36,.37],[.76,.8]]:[]);
  }
  verify(native);
  const M=AtriumFormat2Model, F=AtriumFormat2, stored=M.fromEditor(native);
  const manifestBytes=F.serialize(stored.manifest), manifest=M.parse(manifestBytes), {project:read,members}=M.manifest(manifest);
  const boardBytes=F.serialize(stored.files.find(f=>f.path===members[0].path).file), boardFile=M.parse(boardBytes);
  const readBoard=M.document(boardFile,{name:members[0].name});
  read.documents.push(readBoard);
  assert.deepEqual(F.serialize(F.applyDelta(manifest,M.manifestEdits(manifest,read)).file),manifestBytes);
  assert.deepEqual(F.serialize(F.applyDelta(boardFile,M.documentEdits(boardFile,readBoard,{put:readBoard.items,settings:true})).file),boardBytes);
  verify(read);

  const out=K.exportBoard(native,d), inputs=[file(out.name,out.content),...out.files.map(f=>file(f.name,f.content))];
  const classRows=project=>{
    const {net_settings:net}=JSON.parse(K.exportBoard(project,project.documents[0]).files.find(f=>f.name.endsWith(".kicad_pro")).content);
    return net.classes.map(r=>[r.name,r.via_diameter,r.via_drill]);
  };
  assert.deepEqual(classRows(native),[["Default",.54,.28],["Power Class",1.1,.45],["Signal Class",.54,.28]]);
  const imported=reimport(out);
  // Use the real selected-file link path with the custom rules companion included.
  const linked=I.readSet(inputs), p=A.project("Imported Via classes");
  p.documents=linked.flatMap(r=>r.documents);p.library=linked.flatMap(r=>r.library);
  AtriumImportLink.reconcile(p,p.documents);A.validate(p);
  verify(p);
  assert.deepEqual(classRows(p),classRows(native),"assigned class and actual preferred dimensions survive exchange");
  const projectFile=JSON.parse(out.files.find(f=>f.name.endsWith(".kicad_pro")).content);
  delete projectFile.board.design_settings.rules.min_via_diameter;
  const preferencesOnly=reimport({...out,files:[{name:inputs[1].name,content:JSON.stringify(projectFile)}]});
  verify(preferencesOnly.project,false);
  assert.equal(R.resolver(imported.board,{project:imported.project}).viaLimits("POWER").minDiameter,.42,"project minimum is independent of the class");
  console.log("PASS F1 native bytes, authored via DRC, placement, router and KiCad class/constraint round trip");
}

// ------------------------------------------------------------------ 1. a board with everything
const project = AtriumParts.example(), board = project.documents.find(d => d.kind === "pcb"), defs = defsOf(project);
const o = board.outline;
// Pours: a GND plane on Bottom over the whole board (thermal reliefs, poured around every
// other-net pad, track and via, so its fill has holes), a VDD pour on Top with a higher
// priority and direct connections, a hatched GND pour on Top, and a cut-out.
const gnd = PP.make(o.map(p => [...p]), {net: "GND", layer: "Bottom", name: "GND plane", reliefAirGap: .3, reliefConductorWidth: .35, clearance: .25});
const vdd = PP.make([[2, 2], [12, 2], [12, 10], [2, 10]], {net: "VDD", layer: "Top", connectStyle: "direct", pourIndex: -1, removeDeadCopper: false});
const hatch = PP.make([[20, 12], [34, 12], [34, 20], [20, 20]], {net: "GND", layer: "Top", fillMode: "hatched", hatchPitch: .8, hatchWidth: .25, hatchAngle: 45, removeDeadCopper: false});
const cut = PP.make([[5, 15], [9, 15], [9, 19], [5, 19]], {layer: "Bottom", cutout: true});
board.items.push(gnd, vdd, hatch, cut);
PP.apply(board, defs, {project});
const fills = board.pcbDrawing.pours.filter(r => r.polygon);
assert.ok(fills.some(r => r.count > 1), "the GND plane fill has holes");
// Keep-outs: an all-layer region, a Top-only region and an all-layer keep-out track.
board.items.push({id: "ko-all", kind: "graphic", layer: "Keepout", points: [[30, 2], [34, 2], [34, 6], [30, 6], [30, 2]], fill: true, closed: true, width: 0});
board.items.push({id: "ko-top", kind: "graphic", layer: "Top", keepout: true, points: [[26, 2], [28, 2], [28, 4], [26, 4], [26, 2]], fill: true, closed: true, width: 0});
board.items.push({id: "ko-line", kind: "graphic", layer: "Keepout", points: [[14, 20.5], [20, 20.5]], width: .4});
// Teardrops on pads and vias (clearance checking needs the router; not loaded here).
const drops = AtriumTeardrops.plan(board, defs, {clearance: false});
assert.ok(drops.add.length > 0, "teardrops planned");
AtriumTeardrops.apply(board, drops);
const teardrops = board.items.filter(i => i.teardrop === true || /^teardrop:/.test(i.groupId || ""));
// A net-assigned copper fill, board text and dimensions.
board.items.push({id: "fill-vin", kind: "graphic", layer: "Top", net: "VIN", points: [[1, 12], [3, 12], [3, 14], [1, 14], [1, 12]], fill: true, closed: true, width: 0});
board.items.push({id: "note", kind: "label", x: 4, y: 21, text: "Rev A — round trip", size: 1, layer: "Silk"});
board.items.push(D.dimensionItem("linear", [[0, 0], [36, 0]], {id: "dim-w", offset: -3, layer: "Mechanical 2"}));
board.items.push(D.dimensionItem("aligned", [[0, 1.5], [1.5, 0]], {id: "dim-chamfer", offset: 2, layer: "Mechanical 2"}));
board.items.push(D.dimensionItem("radial", [[18, 11], [20, 11]], {id: "dim-r", layer: "Mechanical 2"}));
// Rules: a Power net class with its own width and clearance, a wider board clearance for one
// net, board minimums, mask expansion and a differential pair.
const rules = R.create();
rules.netClasses = {Power: ["VIN", "VDD", "GND"]};
rules.diffPairs = [{name: "OUT", positive: "BUF", negative: "VOUT"}];
const add = (type, props) => { const t = R.types[type], r = {id: type + "-x" + rules.list.length, type, name: props.name, comment: "", enabled: true, priority: 1, scope: {kind: "all"}, ...(t.two ? {scope2: {kind: "all"}} : {})};
  for (const f of t.fields) r[f.key] = Array.isArray(f.def) ? [...f.def] : f.def && typeof f.def === "object" ? {...f.def} : f.def;
  for (const x of rules.list.filter(x => x.type === type)) x.priority++;
  rules.list.push(Object.assign(r, props)); };
add("width", {name: "PowerWidth", scope: {kind: "netclass", value: "Power"}, min: .4, preferred: .5, max: 2});
add("clearance", {name: "PowerClearance", scope: {kind: "netclass", value: "Power"}, gap: .3});
add("clearance", {name: "VINWide", scope: {kind: "net", value: "VIN"}, gap: .35});
add("diffPairsRouting", {name: "OUTPair", scope: {kind: "diffpair", value: "OUT"}, widthMin: .12, widthPreferred: .15, widthMax: .2, gapMin: .12, gapPreferred: .15, gapMax: .2, maxUncoupled: 3});
add("length", {name: "OUTLength", scope: {kind: "diffpair", value: "OUT"}, min: 0, max: 50});
add("viaStyle", {name: "ComponentVias", scope: {kind: "component", value: "U1"}, holeMin: .25});
rules.list.find(r => r.type === "solderMask").expansion = .05;
R.store(board, project, rules);  // the board's rules in the project rule book; classes and pairs go to the signal model
const frozen = JSON.stringify(project);
const out = K.exportBoard(project, board);
assert.equal(JSON.stringify(project), frozen, "export leaves the project unchanged");
assert.equal(out.content, K.exportBoard(project, board.id).content, "deterministic");
const tree = parse(out.content);
const stamps = [...out.content.matchAll(/\(tstamp ([0-9a-f-]+)\)/g)].map(m => m[1]);
assert.equal(new Set(stamps).size, stamps.length, "unique tstamps");
// Zones in the file.
const zones = kids(tree, "zone"), keepZones = zones.filter(z => kids(z, "keepout").length), copperZones = zones.filter(z => !kids(z, "keepout").length);
const nonCutPours = [gnd, vdd, hatch];
assert.equal(copperZones.length, nonCutPours.length + teardrops.length + 1, "zones: pours + teardrops + net fill");
assert.equal(keepZones.length, 4, "keep-out zones: the cut-out, two keep-out regions and the keep-out track band");
const zoneOf = name => copperZones.find(z => kids(z, "name")[0]?.[1] === name);
const gz = zoneOf("GND plane");
assert.equal(kids(gz, "net_name")[0][1], "GND"); assert.equal(kids(gz, "layer")[0][1], "B.Cu");
assert.deepEqual(kids(gz, "connect_pads")[0].slice(1).filter(x => !Array.isArray(x)), [], "relief: no connect_pads mode");
assert.equal(+kids(kids(gz, "connect_pads")[0], "clearance")[0][1], .25);
const gfill = kids(gz, "fill")[0];
assert.equal(gfill[1], "yes"); assert.equal(+kids(gfill, "thermal_gap")[0][1], .3); assert.equal(+kids(gfill, "thermal_bridge_width")[0][1], .35);
assert.ok(kids(gz, "filled_polygon").length >= 1, "stored fill written");
const vz = copperZones.find(z => kids(z, "net_name")[0][1] === "VDD" && !/Teardrop/.test(kids(z, "name")[0]?.[1] || ""));
assert.equal(kids(vz, "connect_pads")[0][1], "yes"); assert.equal(+kids(vz, "priority")[0][1], 1);
assert.equal(+kids(kids(vz, "fill")[0], "island_removal_mode")[0][1], 1);
const hz = copperZones.find(z => kids(kids(z, "fill")[0], "mode")[0]?.[1] === "hatch");
assert.ok(hz, "hatched zone"); assert.equal(+kids(kids(hz, "fill")[0], "hatch_thickness")[0][1], .25); assert.ok(near(+kids(kids(hz, "fill")[0], "hatch_gap")[0][1], .55));
// Dimensions: linear -> orthogonal, aligned -> aligned, radial -> plain graphics.
const dims = kids(tree, "dimension");
assert.deepEqual(dims.map(d => kids(d, "type")[0][1]).sort(), ["aligned", "orthogonal"]);
assert.equal(out.counts.dimensions, 2);
assert.ok(out.diagnostics.some(m => /Radial and angular/.test(m)));
// Companions: .kicad_pro net classes and .kicad_dru rules.
const pro = JSON.parse(out.files.find(f => f.name.endsWith(".kicad_pro")).content), dru = out.files.find(f => f.name.endsWith(".kicad_dru")).content;
const power = pro.net_settings.classes.find(c => c.name === "Power"), dflt = pro.net_settings.classes.find(c => c.name === "Default");
assert.equal(power.track_width, .5); assert.equal(power.clearance, .3); assert.deepEqual(power.nets.sort(), ["GND", "VDD", "VIN"]);
assert.equal(dflt.clearance, .2);
assert.deepEqual(pro.net_settings.netclass_patterns.map(p => p.pattern).sort(), ["GND", "VDD", "VIN"]);
assert.equal(pro.board.design_settings.rules.solder_mask_clearance, .05);
assert.match(out.content, /\(pad_to_mask_clearance 0\.05\)/);
const druTree = parse("(dru " + dru + ")");
const druRules = kids(druTree, "rule"), ruleNamed = name => druRules.find(r => r[1] === name);
assert.equal(kids(druTree, "version")[0][1], "1");
assert.equal(kids(ruleNamed("PowerWidth"), "condition")[0][1], "A.NetClass == 'Power'");
assert.deepEqual(kids(ruleNamed("PowerWidth"), "constraint")[0].slice(1).map(x => Array.isArray(x) ? x.join(" ") : x), ["track_width", "min 0.4mm", "opt 0.5mm", "max 2mm"]);
assert.equal(kids(ruleNamed("VINWide"), "condition")[0][1], "A.NetName == 'VIN'");
assert.equal(kids(ruleNamed("OUTPair"), "condition")[0][1], "(A.NetName == 'BUF' || A.NetName == 'VOUT')");
assert.ok(kids(ruleNamed("OUTPair"), "constraint").some(c => c[1] === "diff_pair_gap"));
assert.ok(kids(ruleNamed("OUTPair"), "constraint").some(c => c[1] === "diff_pair_uncoupled"));
assert.ok(ruleNamed("OUTLength"), "length rule");
assert.ok(!ruleNamed("ComponentVias"), "component scopes are not guessed");
assert.ok(out.diagnostics.some(m => /components, component classes/.test(m)));
// Priority: later rules win in KiCad, so the highest Waffle priority comes last.
assert.ok(druRules.indexOf(ruleNamed("VINWide")) > druRules.indexOf(ruleNamed("PowerClearance")), "priority order");

// ------------------------------------------------------------------ 2. read it back
const back = reimport(out), b2 = back.board;
const s1 = summary(board), s2 = summary(b2);
// Every pour, teardrop and net fill comes back as a pour; the Waffle-only pour tags (teardrop) do not.
assert.equal(s2.pours, nonCutPours.length + teardrops.length + 1, "pours back");
assert.equal(s2.parts, s1.parts + board.items.filter(i => i.kind === "pad").length, "footprints (free pads become one-pad footprints)");
assert.equal(s2.tracks, s1.tracks, "track segments");
assert.equal(s2.vias, s1.vias, "vias");
assert.equal(s2.nets, s1.nets, "nets");
const polys = b2.items.filter(i => i.kind === "polygon");
// The fill stored above is out of date by now: the keep-outs, teardrops, net fill and rules came
// after it. The file carries the fill the fabrication outputs plot for the board as it stands.
const fillOf = (regions, id) => regions.filter(r => r.polygon === id).reduce((s, r) => s + regionArea(r), 0);
const plotted = PP.outputCopper(board, defs, {project, evaluatedOnly: true});
assert.ok(plotted.filled.includes(gnd.id), "the GND plane is out of date when it is saved");
assert.ok(Math.abs(fillOf(plotted.regions, gnd.id) - fillOf(fills, gnd.id)) > 1, "the stale and the current GND fill differ");
for (const src of nonCutPours) {
  const got = polys.find(p => p.layer === src.layer && p.net === src.net && p.points.length === src.points.length && src.points.every(q => p.points.some(r => nearP(q, r))));
  assert.ok(got, "pour " + (src.name || src.net + " " + src.layer) + " outline");
  assert.equal(got.connectStyle, src.connectStyle === "auto" ? "relief" : src.connectStyle, "connect style");
  assert.equal(got.fillMode, src.fillMode, "fill mode");
  assert.equal(got.removeDeadCopper, src.removeDeadCopper, "island removal");
  if (src.reliefAirGap) assert.ok(near(got.reliefAirGap, src.reliefAirGap), "relief gap");
  if (src.fillMode === "hatched") { assert.ok(near(got.hatchWidth, src.hatchWidth)); assert.ok(near(got.hatchPitch, src.hatchPitch)); assert.equal(got.hatchAngle, src.hatchAngle); }
  if (src.clearance != null) assert.ok(near(got.clearance, src.clearance), "clearance");
  // Saved fill: the same copper area as the outputs' (holes included, fractured into one ring per island).
  const before = fillOf(plotted.regions, src.id);
  const after = fillOf(b2.pcbDrawing?.pours || [], got.id);
  assert.ok(before > 0 && Math.abs(after - before) <= Math.max(1e-3, before * 1e-5), "fill area " + (src.name || src.net) + ": " + before + " -> " + after);
  src.back = got;
}
// Priority order survives: the VDD pour (lowest pour index) still pours first.
assert.ok(vdd.back.pourIndex < gnd.back.pourIndex, "pour order");
// Keep-outs come back as filled keep-out areas: on the Keep-Out layer, or on their one copper layer.
const backKeep = b2.items.filter(i => i.kind === "graphic" && (i.layer === "Keepout" || i.keepout === true));
assert.equal(backKeep.length, keepZones.length, "keep-outs back");
assert.ok(backKeep.every(i => i.fill === true), "keep-outs back as areas, not outlines");
assert.ok(backKeep.some(i => i.layer === "Top" && i.keepout === true), "the single-layer keep-out keeps its layer");
// Net classes come back as per-net rules with the same clearance and width.
assert.ok(back.project.rules, "rules back from the .kicad_pro");
const rq = (doc, p, type, net) => R.query(doc, type, {net}, {project: p});
for (const net of ["VDD", "GND"]) {
  assert.equal(rq(b2, back.project, "clearance", net).gap, rq(board, project, "clearance", net).gap, net + " clearance");
  assert.equal(rq(b2, back.project, "width", net).min, .5, net + " width (KiCad's class width is the preferred width)");
}
assert.equal(rq(b2, back.project, "clearance", "FILTER").gap, .2, "default class");
// Text and the dimension texts' labels survive as board text.
assert.ok(b2.items.some(i => i.kind === "label" && i.text === "Rev A — round trip"), "board text");
// Exporting the import again writes the same KiCad objects.
const again = K.exportBoard(back.project, b2);
for (const k of ["footprints", "pads", "segments", "vias", "zones", "zoneFills"]) assert.equal(again.counts[k], out.counts[k], "re-export " + k);
console.log("PASS KiCad round trip: " + [s2.parts + " footprints", s2.tracks + " segments", s2.vias + " vias", out.counts.zones + " zones (" + out.counts.zoneFills + " stored fills, " +
  teardrops.length + " teardrops)", keepZones.length + " keep-outs", out.counts.dimensions + " dimensions", s2.nets + " nets", druRules.length + " custom rules"].join(", "));

// ------------------------------------------------------------------ 2b. edits and a KiCad source saved back
{
  // An edit after the pour: the save carries the copper the outputs plot, not the fill from before the move.
  const p3 = A.clone(project), b3 = p3.documents.find(d => d.id === board.id), d3 = defsOf(p3);
  const zoneFill = text => kids(kids(parse(text), "zone").find(z => kids(z, "name")[0]?.[1] === "GND plane"), "filled_polygon");
  const first = K.exportBoard(p3, b3), via = b3.items.find(i => i.kind === "via" && i.net !== "GND");
  via.x += 1.5; via.y += 1;
  const moved = K.exportBoard(p3, b3), want = PP.outputCopper(b3, d3, {project: p3, evaluatedOnly: true}).regions;
  assert.notDeepEqual(zoneFill(moved.content), zoneFill(first.content), "the saved fill follows a moved via");
  const m = reimport(moved), mg = m.board.items.find(i => i.kind === "polygon" && i.name === "GND plane");
  const got = fillOf(m.board.pcbDrawing.pours, mg.id), exact = fillOf(want, gnd.id);
  assert.ok(exact > 0 && Math.abs(got - exact) <= exact * 1e-5, "saved fill after the move: " + exact + " -> " + got);
  console.log("PASS KiCad save after an edit carries the outputs' pour fill");
}
{
  // demo.kicad_pcb (this repository's own fixture): an arc track, an oval through-hole pad, a
  // chamfered rectangle, a trapezoid and a custom pad are saved as the records they were read from.
  const demo = fs.readFileSync(path.join(__dirname, "../fixtures/import/demo.kicad_pcb"), "utf8");
  const src = reimport({name: "demo.kicad_pcb", content: demo}), saved = K.exportBoard(src.project, src.board), t = parse(saved.content);
  const nums = (v, name) => kids(v, name)[0].slice(1).map(Number), netName = id => kids(t, "net").find(n => n[1] === String(id))[2];
  const arcs = kids(t, "arc");
  assert.equal(arcs.length, 1, "one arc track");
  assert.equal(kids(t, "segment").length, kids(parse(demo), "segment").length, "no chords beside it");
  assert.deepEqual([nums(arcs[0], "start"), nums(arcs[0], "end"), nums(arcs[0], "width"), kids(arcs[0], "layer")[0][1], netName(nums(arcs[0], "net")[0])],
    [[20, 20], [25, 25], [.25], "F.Cu", "SIG"]);
  assert.ok(nearP(nums(arcs[0], "mid"), [21.464466, 23.535534], 1e-5), "arc midpoint");
  assert.equal(saved.counts.arcs, 1);
  const padsOf = (tree, ref) => kids(kids(tree, "footprint").find(f => f.some(c => Array.isArray(c) && c[2] === ref && /reference/i.test(c[1]))), "pad");
  const pad = (tree, ref, number) => padsOf(tree, ref).find(q => q[1] === number);
  const oval = pad(t, "J1", "2");
  assert.deepEqual([oval[3], nums(oval, "size"), kids(oval, "drill")[0].slice(1)], ["oval", [1.7, 2.2], ["oval", "1", "1.4"]], "a capsule is KiCad's oval");
  const chamfer = pad(t, "U2", "1");
  assert.deepEqual([chamfer[3], nums(chamfer, "size"), nums(chamfer, "chamfer_ratio"), kids(chamfer, "chamfer")[0].slice(1)], ["chamfered_rect", [1.2, 1.2], [.25], ["top_left"]]);
  const trapezoid = pad(t, "U2", "2");
  assert.deepEqual([trapezoid[3], nums(trapezoid, "size"), nums(trapezoid, "rect_delta")], ["trapezoid", [1, 1.4], [0, .4]]);
  const custom = pad(t, "U2", "3"), poly = kids(kids(custom, "primitives")[0], "gr_poly")[0];
  assert.deepEqual([custom[3], nums(custom, "size"), kids(kids(custom, "options")[0], "anchor")[0][1]], ["custom", [.5, .5], "rect"], "a custom pad keeps its anchor");
  assert.deepEqual(kids(kids(poly, "pts")[0], "xy").map(v => v.slice(1).map(Number)), [[-.5, -.5], [.8, -.5], [.8, .9], [-.5, .5]]);
  assert.ok(!saved.diagnostics.some(m => /64-sided/.test(m)), "no ellipse stands in for a capsule");
  // The other forms, turned: a trapezoid along X, an octagon-like chamfer on every corner, and an
  // anchor that no longer fits its outline. Rounded corners beside a chamfer stay an outline.
  const board2 = `(kicad_pcb (version 20221018) (generator test) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "")
    (footprint "Forms" (layer "F.Cu") (at 10 10 30) (property "Reference" "U9" (at 0 -3) (layer "F.SilkS"))
      (pad "1" smd trapezoid (at 0 0) (size 1.4 1) (rect_delta 0.3 0) (layers "F.Cu"))
      (pad "2" smd chamfered_rect (at 3 0 90) (size 2 1) (chamfer_ratio 0.2) (chamfer top_left top_right bottom_left bottom_right) (layers "F.Cu"))
      (pad "3" smd chamfered_rect (at 6 0) (size 2 1) (roundrect_rratio 0.2) (chamfer_ratio 0.2) (chamfer bottom_right) (layers "F.Cu"))
      (pad "4" smd custom (at 9 0) (size 0.4 0.4) (layers "F.Cu") (options (clearance outline) (anchor circle))
        (primitives (gr_poly (pts (xy -1 -1) (xy 1 -1) (xy 0 1)) (width 0) (fill yes))))
      (pad "5" smd oval (at 12 0) (size 2 1) (layers "F.Cu"))))`;
  const forms = reimport({name: "forms.kicad_pcb", content: board2}), t2 = parse(K.exportBoard(forms.project, forms.board).content);
  const f = number => pad(t2, "U9", number);
  assert.deepEqual([f("1")[3], nums(f("1"), "size"), nums(f("1"), "rect_delta")], ["trapezoid", [1.4, 1], [.3, 0]]);
  assert.deepEqual([f("2")[3], nums(f("2"), "size"), nums(f("2"), "chamfer_ratio"), kids(f("2"), "chamfer")[0].slice(1)],
    ["chamfered_rect", [2, 1], [.2], ["top_left", "top_right", "bottom_left", "bottom_right"]]);
  assert.equal(f("3")[3], "custom", "sampled round corners stay an outline");
  assert.deepEqual([f("4")[3], nums(f("4"), "size"), kids(kids(f("4"), "options")[0], "anchor")[0][1]], ["custom", [.4, .4], "circle"]);
  assert.deepEqual([f("5")[3], nums(f("5"), "size")], ["oval", [2, 1]]);
  const fp = forms.project.library.find(d => d.footprint?.pads.some(q => q.number === "4")).footprint;
  fp.pads.find(q => q.number === "4").poly = [[.5, .5], [2, .5], [1, 2]];  // the outline moved off its anchor
  const off = pad(parse(K.exportBoard(forms.project, forms.board).content), "U9", "4");
  assert.deepEqual([nums(off, "size"), kids(kids(off, "options")[0], "anchor")[0][1]], [[.01, .01], "circle"], "an anchor outside its outline is not written");
  console.log("PASS KiCad source saved back: arc track, oval, chamfered, trapezoid and custom pads in their own records");
}

// ------------------------------------------------------------------ 3. fracture and project export
{
  const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const ring = K.fracture([square(0, 0, 10), square(2, 2, 2).reverse(), square(6, 6, 2), square(2, 6, 1)]);
  assert.ok(near(Math.abs(area(ring)), 100 - 4 - 4 - 1, 1e-9), "fractured area");
  const zipOut = K.exportProject(project, board);
  const names = zipOut.files.map(f => f.name).sort();
  const base = K.nameFor(board.name, "");
  assert.deepEqual(names, [base + ".kicad_dru", base + ".kicad_pcb", base + ".kicad_pro", base + ".kicad_sch"].sort());
  assert.ok(zipOut.bytes instanceof Uint8Array && zipOut.bytes[0] === 0x50 && zipOut.bytes[1] === 0x4b, "zip");
  // The root sheet and the board import as one linked project.
  const res = I.readSet(zipOut.files.filter(f => /\.kicad_(pcb|sch|pro)$/.test(f.name)).map(f => file(f.name, f.content)));
  const p = A.project("Zip"); p.documents = res.flatMap(r => r.documents); p.library = res.flatMap(r => r.library); AtriumImportLink.reconcile(p, p.documents); A.validate(p);
  const sch = p.documents.find(d => d.kind === "schematic"), pcb = p.documents.find(d => d.kind === "pcb");
  const linked = sch.items.filter(i => i.kind === "part").filter(s => pcb.items.some(b => b.kind === "part" && b.link === s.link)).length;
  assert.equal(linked, sch.items.filter(i => i.kind === "part").length, "every symbol links to its footprint");
  console.log("PASS KiCad project export: " + names.join(", ") + "; " + linked + " linked parts");
}

// ------------------------------------------------------------------ 4. real designs (optional)
const at = process.argv.indexOf("--real");
if (at >= 0) {
  // A directory (Node) or the .kicad_pcb files themselves (any runner; jsc cannot list folders).
  const found = [];
  const walk = dir => { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (fs.statSync(p).isDirectory()) walk(p); else if (n.endsWith(".kicad_pcb")) found.push(p); } };
  for (const arg of process.argv.slice(at + 1)) { if (arg.startsWith("--")) break; if (arg.endsWith(".kicad_pcb")) found.push(arg); else walk(arg); }
  for (const f of found.sort()) {
    const text = fs.readFileSync(f, "utf8"), pro = f.replace(/\.kicad_pcb$/, ".kicad_pro");
    const set = [file(path.basename(f), text)];
    if (fs.existsSync(pro)) set.push(file(path.basename(pro), fs.readFileSync(pro, "utf8")));
    const res = I.readSet(set), p = A.project("Real"); p.documents = res.flatMap(r => r.documents); p.library = res.flatMap(r => r.library); AtriumImportLink.reconcile(p, p.documents);
    const b = p.documents.find(d => d.kind === "pcb"), x = K.exportBoard(p, b), y = reimport(x), s = summary(b), t = summary(y.board);
    const fillArea = d => (d.pcbDrawing?.pours || []).reduce((sum, r) => sum + regionArea(r), 0);
    const fa = fillArea(b), fb = fillArea(y.board);
    const line = path.basename(f) + ": parts " + s.parts + "→" + t.parts + ", segments " + s.tracks + "→" + t.tracks + ", vias " + s.vias + "→" + t.vias +
      ", pours " + s.pours + "→" + t.pours + ", nets " + s.nets + "→" + t.nets + ", fill " + fa.toFixed(2) + "→" + fb.toFixed(2) + " mm²";
    console.log(line);
    assert.equal(t.parts, s.parts, line); assert.equal(t.tracks, s.tracks, line); assert.equal(t.vias, s.vias, line);
    assert.equal(t.pours, s.pours, line); assert.equal(t.nets, s.nets, line);
    assert.ok(Math.abs(fa - fb) <= Math.max(.01, fa * 1e-4), line);
    // Net classes (read from the source .kicad_pro) survive the exported .kicad_pro.
    let ruled = 0;
    if (p.rules) for (const net of new Set(b.items.flatMap(i => [i.net, ...Object.values(i.pinNets || {})]).filter(Boolean))) {
      for (const [type, key] of [["clearance", "gap"], ["width", "min"]]) assert.equal(rq(y.board, y.project, type, net)?.[key], rq(b, p, type, net)?.[key], line + " " + net + " " + type);
      ruled++;
    }
    if (ruled) console.log("  net class clearance and width equal on " + ruled + " nets");
  }
  console.log("PASS " + found.length + " real KiCad boards round trip");
}
