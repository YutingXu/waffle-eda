"use strict";
// Source decisions from the same readers used by File > Open. An optional argument
// selects the pinned public Corne board, hierarchy and libraries from a local Git cache.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const app = path.join(__dirname, "../../app");
if (!globalThis.AtriumTranslators && fs.existsSync(path.join(app, "translator-worker-modules.js"))) {
  require("../../app/translator-worker-modules.js");
  for (const name of AtriumTranslatorWorkerModules["import-formats"]) {
    if (name === "vendor/cfb.min.js") globalThis.CFB = require(require("../support/app-source-paths.cjs").appFileFrom(app, name));
    else require(require("../support/app-source-paths.cjs").appFileFrom(app, name));
  }
  for (const name of ["obsolete-project", "translator-table", "translator-registry", "translator-provenance", "translator-adapters", "translators"])
    require(require("../support/app-source-paths.cjs").appFileFrom(app, name + ".js"));
}
if (!globalThis.AtriumKiCadImport) for (const name of ["model", "rules", "board-shape","board-shape-sources", "sch-objects", "source-file", "pcb-pours", "sexpr", "import-kicad", "library-import-kicad"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const K = AtriumKiCadImport, L = AtriumLibraryImportKiCad, F = AtriumImportFormats;
const fixed = run => Atrium.withRevisionIds("b".repeat(64), run);
const file = (name, content, relative = name) => ({name, path: relative, bytes: new TextEncoder().encode(content)});
function recorder() {
  const rows = [], outputs = [], notes = [], rejected = new WeakSet();
  function add(kind, status, source, reason, target) {
    assert.ok(["kept", "approximated", "dropped"].includes(status));
    assert.ok(source.file && source.object);
    if (status !== "kept") assert.ok(reason, source.object);
    rows.push({kind, status, source, reason, target});
  }
  return {rows, outputs, notes, add, track: (k, s, ref, obj, why) => add(k, s, ref, why, obj),
    note: message => notes.push(message), reject: target => rejected.add(target), rejected,
    produced: (domain, source, item) => outputs.push({domain, source, item})};
}
function read(files, fidelity, options = {}) {
  return fixed(() => {
    F.resetBudget();
    const results = files.map(f => {
      const api = L.handles(f.name) ? L : K;
      return F.scrub(api.read(f.name, f.bytes, {utf8: F.utf8, fidelity}), fidelity);
    });
    K.link(results, files, {fidelity});
    L.link(results, files, {fidelity, ...options});
    return results;
  });
}
const ofKind = (e, kind) => e.rows.filter(r => r.kind === kind);
const statuses = (e, kind) => ofKind(e, kind).map(r => r.status);
{
  const shapes=["input","output","bidirectional","tri_state","passive","future",null], audit=recorder();
  const nodes=shapes.map((s,n)=>'(global_label "S'+n+'" (at '+n+' 5) (uuid global-'+n+') '+(s?'(shape '+s+')':'')+')');
  read([file("Shapes.kicad_sch","(kicad_sch (version 20250114) "+nodes.join(" ")+")")],audit);
  const rows=ofKind(audit,"offsheet");
  assert.deepEqual(rows.map(r=>r.status),["kept","kept","kept","approximated","approximated","approximated","kept"]);
  assert.ok(rows.every((r,n)=>r.source.file==="Shapes.kicad_sch" && r.source.object.includes("global-"+n)));
  assert.match(rows[3].reason,/bidirectional/);assert.match(rows[4].reason,/outline/);assert.match(rows[5].reason,/unknown/i);
}
const schematic = file("main.kicad_sch", `(kicad_sch (version 20250114)
 (lib_symbols (symbol "X:A" (symbol "A_1_1" (pin input line (at 0 0) (length 1) (name IN) (number 1))
  (bezier (pts (xy 0 0) (xy 1 0) (xy 1 1) (xy 0 1))) (future_art))))
 (symbol (lib_id "X:A") (uuid aaaa) (at 1 1) (property Reference "U1"))
 (symbol (lib_id "X:A") (uuid aaaa) (at 5 5) (property Reference "U1"))
 (symbol (lib_id "Missing") (uuid bbbb)) (future_sheet_feature (uuid dead))
 (sheet (uuid cccc) (at 0 0) (size 10 6) (property "Sheetfile" "child.kicad_sch") (pin Z tri_state (at 0 3)))
 (sheet (uuid cccd) (at 0 0) (size 10 6) (property "Sheetfile" "unselected.kicad_sch"))
 (bus_alias "data" (members "D0")) (wire (pts (xy 1 1) (xy 2 2))))`);
const board = file("main.kicad_pcb", `(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
 (setup (pad_to_mask_clearance .05) (pad_to_paste_clearance -.025) (solder_mask_min_width .08))
 (net 1 "VCC") (net 2 "GND") (net 3 "Unused")
 (footprint "S:Pkg" (at 1 2) (layer F.Cu) (uuid face) (pad 1 smd rect (at 1 1) (size 1 1) (layers F.Cu) (net 1 VCC))
  (pad 2 thru_hole oval (at 1 3) (size 3 2) (layers "*.Cu") (drill oval 2 1 (offset .1 0)))
  (pad 3 smd rect (at 3 3) (size 1 1) (layers F.Cu) (clearance .5)) (model "missing.step"))
 (segment (start 1 1) (end 2 2) (width .25) (layer F.Cu) (net 2) (uuid d001))
 (segment (start 2 2) (end 3 3) (width .25) (layer "Unknown") (uuid d002))
 (segment (end 3 3) (width .25) (layer F.Cu) (uuid d003))
 (arc (start 0 0) (mid 1 1) (end 2 0) (width .2) (layer F.Cu) (uuid d004))
 (via micro (at 2 2) (size .5) (drill .2) (layers F.Cu B.Cu) (uuid d005))
 (zone (net 1) (layer F.Cu) (polygon (pts (xy 0 0) (xy 10 0) (xy 0 12)))
    (filled_polygon (layer F.Cu) (pts (xy 1 1) (xy 9 1) (xy 1 9))) (filled_polygon (layer B.Cu) (pts (xy 1 1) (xy 9 1) (xy 1 9))))
 (dimension (uuid d006)) (future_pcb_feature (uuid d007)))`);
const project = file("main.kicad_pro", JSON.stringify({net_settings: {classes: [{name:"Default", clearance:.2}, {name:"Power", track_width:.6, via_diameter:1}, {name:"Unused", clearance:.8}],
  netclass_assignments:{GND:["Power", "Default"]}, netclass_patterns:[{pattern:"V*", netclass:"Power"},{pattern:"Z*",netclass:"Unused"}]},
  board:{design_settings:{rules:{min_clearance:.3}}}, future_settings:{a:1}}));
{
  const files = [schematic, file("child.kicad_sch", "(kicad_sch (version 20250114))"), board, project];
  const sink = recorder(), results = read(files, sink);
  assert.deepEqual(results, read(files), "source observations leave the parsed native projects byte-equivalent");
  const placements = ofKind(sink, "part").filter(r => r.source.file === schematic.name);
  assert.deepEqual(placements.map(r => r.status), ["kept", "kept", "dropped"]);
  assert.ok(placements[0].source.object.includes("aaaa"));
  assert.notEqual(placements[0].source.object, placements[1].source.object, "duplicate IDs and designators remain distinct source occurrences");
  assert.equal(ofKind(sink, "pin").length, 1, "electrical pin source counted once across repeated placements");
  assert.deepEqual(statuses(sink, "sheet-link"), ["kept", "dropped"]);
  assert.deepEqual(statuses(sink, "sheet-entry"), ["approximated"]);
  assert.deepEqual(statuses(sink, "bus-alias"), ["dropped"]);
  assert.deepEqual(statuses(sink, "track"), ["kept", "dropped", "dropped", "kept"], "arc tracks stay true arcs");
  assert.deepEqual(statuses(sink, "pad"), ["kept", "approximated", "approximated"]);
  const offsetPad = ofKind(sink, "pad")[1];
  assert.equal(offsetPad.target.slotLength, 2);
  assert.match(offsetPad.reason, /Pad copper offsets were ignored/);
  assert.doesNotMatch(offsetPad.reason, /ellipse/, "a KiCad oval is the same capsule in the editor");
  assert.doesNotMatch(offsetPad.reason, /slotted holes import as round/i);
  assert.deepEqual(statuses(sink, "pad-field"), ["dropped"]);
  assert.deepEqual(statuses(sink, "via"), ["approximated"]);
  assert.deepEqual(statuses(sink, "pour-fill"), ["kept", "dropped"]);
  assert.deepEqual(statuses(sink, "netclass"), ["kept", "kept", "dropped"]);
  assert.deepEqual(statuses(sink, "netclass-assignment"), ["approximated"]);
  assert.deepEqual(statuses(sink, "netclass-pattern"), ["approximated", "dropped"]);
  assert.deepEqual(statuses(sink, "board-rule"), ["dropped"]);
  const plotSettings = ofKind(sink, "board-setting").filter(row => row.source.file === board.name);
  assert.deepEqual(plotSettings.map(row => [row.source.object.split("/").at(-1).split(" ")[0], row.status]),
    [["pad_to_mask_clearance", "kept"], ["pad_to_paste_clearance", "kept"], ["solder_mask_min_width", "dropped"]]);
  assert.deepEqual(statuses(sink, "unknown"), ["dropped", "dropped", "dropped"]);
  const native = results.flatMap(r => r.documents).flatMap(d => d.items.map(i => i.id)).sort();
  assert.deepEqual(sink.outputs.map(r => r.item.id).sort(), native, "all actual editor objects have an originating source");
}
{
  const symbol = file("L.kicad_sym", `(kicad_symbol_lib (version 20241118) (symbol "S" (property "Reference" "U") (property "Footprint" "One:Common")
   (symbol "S_1_1" (pin input line (at 0 0) (length 1) (name IN) (number 1))))
   (symbol "S") (symbol "Inherited" (extends S)) (symbol "Missing" (extends None)) (symbol "P" (power)))`);
  const module = `(footprint "Common" (layer F.Cu) (pad "1" smd rect (at 0 0) (size 1 1) (layers F.Cu))
    (model "part.wrl" (offset (xyz 1 2 3))) (model "other.step"))`;
  const selected = [symbol, file("Common.kicad_mod", module, "One.pretty/Common.kicad_mod"),
    file("Common.kicad_mod", module.replace("size 1 1", "size 2 1"), "Other.pretty/Common.kicad_mod")];
  const sink = recorder(), origins = new Map();
  const results = read(selected, sink, {libraryOrigins: origins});
  assert.deepEqual(results, read(selected));
  const lib = results[0].library, s = lib.find(d => d.name === "S"), inherited = lib.find(d => d.name === "Inherited");
  assert.equal(results[0].pairing.paired, 2);
  assert.deepEqual(statuses(sink, "symbol-definition"), ["dropped", "kept", "approximated", "dropped", "dropped"]);
  assert.deepEqual(statuses(sink, "footprint-link"), ["kept", "kept"]);
  assert.deepEqual(statuses(sink, "model3d"), ["approximated", "dropped", "approximated", "dropped"]);
  assert.equal(ofKind(sink, "pin").length, 1, "inheriting a body does not duplicate its source pin");
  assert.deepEqual(s.footprint.pads.map(p => p.w), [1]);
  assert.equal(s.source.footprint.sha256, AtriumSourceFile.sha256(selected[1].bytes));
  assert.deepEqual(origins.get(inherited.id).map(f => f.path), ["L.kicad_sym", "One.pretty/Common.kicad_mod"]);
  assert.ok(ofKind(sink, "pad").every(r => r.source.file.endsWith(".pretty/Common.kicad_mod")));
  const unchanged = read(selected, recorder(), {existing:lib});
  assert.equal(unchanged[0].pairing.skipped, 3);
  assert.equal(unchanged[0].library.length, 0);
}
{
  const source = `(footprint "Slotted" (layer F.Cu)
    (pad "1" thru_hole rect (at 0 0 15) (size 3 3) (drill oval 2 .6 (offset 0 0)) (layers "*.Cu" "*.Mask")))`;
  const sink = recorder();
  const first = L.readFootprint(source, {file: "Slotted.kicad_mod", fidelity: sink});
  assert.deepEqual(statuses(sink, "pad"), ["kept"]);
  assert.deepEqual(first.def.footprint.pads.map(pad => [pad.drill, pad.slotLength, pad.plated]), [[.6, 2, true]]);
  const symbol = file("Pins.kicad_sym", `(kicad_symbol_lib (version 20241118)
    (symbol "Pin" (property "Reference" "J") (property "Footprint" "Slotted")
      (symbol "Pin_1_1" (pin passive line (at 0 0) (length 1) (name "pin") (number "1")))))`);
  for (const axisSizes of ["1.5 .6", ".6 2"]) {
    const inputs = [symbol, file("Slotted.kicad_mod", source, "First.pretty/Slotted.kicad_mod"),
      file("Slotted.kicad_mod", source.replace("oval 2 .6", "oval " + axisSizes), "Second.pretty/Slotted.kicad_mod")];
    const {report} = L.pair(inputs);
    assert.equal(report.ambiguous.length, 1, "different slot length or axis makes same-name footprints distinct");
    assert.equal(report.identical.length, 0);
  }
}
{
  const omitted = recorder();
  const r = L.pair([file("F.kicad_mod", '(footprint F (layer F.Cu) (pad "1" smd rect (at 0 0) (size 1 1) (layers F.Cu)))')],
    {footprints: false, fidelity: omitted});
  assert.equal(r.library.length, 0);
  assert.deepEqual(statuses(omitted, "footprint-definition"), ["dropped"]);
  assert.deepEqual(statuses(omitted, "pad"), ["dropped"]);
  const broken = recorder();
  read([file("broken.kicad_sch", `(kicad_sch (lib_symbols (symbol A (symbol A_1_1
   (pin input line (at 1 1) (length 2) (name IN) (number 1)) (polyline (pts (arc (mid 0 1) (end 1 1)))))))
   (symbol (lib_id A) (uuid bad1) (at 0 0)))`)], broken);
  assert.deepEqual(statuses(broken, "part"), ["dropped"]);
  assert.deepEqual(statuses(broken, "pin"), ["dropped"], "partial geometry is discarded when its containing definition fails");
}
{
  const audit=recorder(), source=file("legacy.kicad_pcb", `(kicad_pcb (version 20171130)
    (net 1 "POWER") (net_class Power "" (via_dia 1.1) (via_drill .45) (add_net "POWER"))
    (via (at 4 5) (size .76) (drill .4) (layers "F.Cu" "B.Cu") (net 1)))`);
  const legacy=read([source],audit)[0].documents[0];
  const limits=AtriumRules.resolver(legacy).viaLimits;
  assert.deepEqual([limits("POWER").diameter,limits("POWER").drill,limits("POWER").minDrill,limits("POWER").ring],[1.1,.45,0,0]);
  assert.deepEqual(statuses(audit,"netclass"),["kept"]);
  const custom=file("legacy.kicad_dru",`# native KiCad comments
(version 1)
(rule "All holes" (constraint hole_size (min .5mm)))
(rule "Power via" (condition "A.Type == 'Via' && A.hasNetclass('Power')")
  (constraint via_diameter (min 0.8mm)) (constraint hole_size (min .42mm)))
(rule "Unsupported conditional hole" (condition "A.intersectsArea('Dense')") (constraint hole_size (min .7mm)))`);
  const sink=recorder(), linked=read([custom,source],sink)[1].documents[0];
  const via=AtriumRules.resolver(linked).viaLimits("POWER");
  assert.deepEqual([via.minDiameter,via.minDrill],[.8,.42],"later via-only bore rule overrides a generic hole constraint");
  assert.deepEqual(statuses(sink,"custom constraint"),["dropped","kept","kept","kept"]);
  assert.match(ofKind(sink,"custom constraint")[0].reason,/Unsupported custom rule condition/);
  assert.throws(()=>F.readSet([custom]),/matching .kicad_pcb/);
}
if (globalThis.AtriumTranslators) {
  const rejected = file("scrub.kicad_pcb", `(kicad_pcb (version 20240108)
    (segment (start 1 1) (end 2 2) (layer F.Cu) (width .25) (uuid aa01))
    (segment (start 0 0) (end 2000000 0) (layer F.Cu) (width .25) (uuid aa02))
    (footprint "F" (at 0 0) (layer F.Cu) (uuid aa03)
      (pad 1 smd rect (at 1 1) (size 1 1) (layers F.Cu))
      (pad 2 smd rect (at 1 1) (size -3 1) (layers F.Cu))))`);
  const {model, report} = fixed(() => AtriumTranslators.import([rejected]));
  const track = report.kinds.find(r => r.kind === "track"), pad = report.kinds.find(r => r.kind === "pad");
  assert.equal(track.kept, 1); assert.equal(track.dropped, 1);
  assert.ok(track.references.some(r => r.status === "dropped" && /aa02/.test(r.source.object)));
  assert.equal(pad.kept, 1); assert.equal(pad.dropped, 1);
  assert.equal(report.modelObjects.find(r => r.kind === "track").count, 1);
  assert.equal(model.documents[0].items.filter(i => i.kind === "track").length, 1);
}
console.log("PASS KiCad source identities, hierarchical links, project rules, real conversion branches and paired library origins");

// One completed document is attributed once. Board and project exports of one polyline
// agree, rules stay out of those counts, and the Altium sibling keeps its STEP sidecar.
for (const name of ["parts","hierarchy","stackup","net-intent","signals","altium-rules","query","component-classes","pcb-appearance","pcb-text-rich","pcb-text","pcb-draw","designator-place","zip","schematic-output","kicad-export","kicad-schematic","altium-export","translator-provenance","translator-exports"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
{
  const model = Atrium.project("Board"), doc = model.documents.find(d => d.kind === "pcb");
  doc.name = "board"; doc.outline = [[0,0],[20,0],[20,10],[0,10]];
  const poly = {id:"P1",kind:"track",layer:"Top",net:"N1",width:.25,points:[[1,1],[6,1],[6,4],[9,4]]};
  doc.items = [poly];
  doc.bodyModels = [{id:"step",file:"board.step",stepText:"ISO-10303-21;\nEND-ISO-10303-21;\n"}];
  const sibling = Atrium.project("Sibling"), other = sibling.documents.find(d => d.kind === "pcb");
  other.name = "sibling"; other.outline = [[0,0],[8,0],[8,8],[0,8]];
  other.items = [{id:"P2",kind:"track",layer:"Top",net:"N2",width:.2,points:[[1,1],[3,2]]}];
  const run = (id, value, options, bare) => {
    const rows = [], fidelity = {add:(kind,status,source,reason,count=1) => rows.push({kind,status,source,reason,count}), note(){}};
    const saved = globalThis.AtriumRules;
    if (bare) globalThis.AtriumRules = undefined;
    try { return {rows, out:AtriumTranslatorExports[id].export(value, options, fidelity)}; }
    finally { globalThis.AtriumRules = saved; }
  };
  const board = run("kicad", model, {scope:"document", documentId:doc.id, primaryOnly:true});
  const project = run("kicad", model, {scope:"project"});
  const selected = run("altium", model, {scope:"document", documentId:doc.id}, true);
  const packed = run("altium", model, {scope:"project"}, true);
  const siblingOut = run("altium", sibling, {scope:"document", documentId:other.id}, true);
  const seg = rows => rows.find(r => r.kind === "KiCad segments" && r.source.object === doc.id);
  assert.equal(seg(board.rows).count, poly.points.length - 1);
  assert.deepEqual(seg(board.rows), seg(project.rows));
  assert.equal(board.rows.find(r => r.kind === "PCB document" && r.status === "kept").reason, "Written to board.kicad_pcb.");
  assert.equal(project.rows.find(r => r.kind === "PCB document" && r.status === "kept").reason, "Written to board.kicad_pcb.");
  assert.equal(board.rows.find(r => r.kind === "track" && r.status === "kept").source.object, doc.id + "/P1");
  assert.deepEqual(board.out.files.map(f => f.name), ["board.kicad_pcb"]);
  for (const result of [board, project, selected, packed, siblingOut]) assert.ok(!result.rows.some(r => r.kind.endsWith(" rules")));
  const altiumTracks = rows => rows.find(r => r.kind === "Altium tracks");
  assert.equal(altiumTracks(selected.rows).count, poly.points.length - 1);
  assert.deepEqual(altiumTracks(selected.rows), altiumTracks(packed.rows));
  assert.ok(selected.rows.some(r => r.kind === "STEP sidecar" && r.status === "kept" && r.source.file === "board.step"));
  assert.ok(packed.rows.some(r => r.kind === "STEP sidecar" && r.status === "kept" && r.source.file === "board.step"));
  assert.equal(siblingOut.rows.find(r => r.kind === "track" && r.status === "kept").source.object, other.id + "/P2");
  assert.equal(altiumTracks(siblingOut.rows).count, 1);
  const textOf = result => result.out.files.find(f => f.name.endsWith(".kicad_pcb")).text;
  const emitted = [];
  for (let i = 1; i < poly.points.length; i++) {
    const stamp = AtriumKiCad.uid(doc.id + "\u001fP1/segment/" + i);
    assert.ok(textOf(board).includes(stamp) && textOf(project).includes(stamp));
    emitted.push({id:"T" + i, sourcePolyline:"P1"});
  }
  const owned = (document, list) => {
    const polylines = new Set(document.items.filter(i => i.kind === "track").map(item => item.id));
    for (const track of list) if (!polylines.has(track.sourcePolyline)) throw Error("mixed ownership: board.kicad_pcb track " + track.id + " source polyline " + track.sourcePolyline + " is not a polyline of document " + document.id + " (" + [...polylines].join(",") + "); document provenance still records " + document.id);
  };
  owned(doc, emitted);
  owned(other, [{id:"U1", sourcePolyline:"P2"}]);
  assert.throws(() => owned(doc, emitted.map((track, index) => index === 1 ? {id:"T2", sourcePolyline:"P2"} : track)), /mixed ownership: board\.kicad_pcb track T2 source polyline P2/);
}

if (process.argv[2] === "--corne") {
  // python3 tests/real-history/fetch.py populates the read-only public cache.
  // node tests/formats/translator-kicad.cjs --corne [path/to/corne-cache]
  const corpus = String.raw`
import base64, json, sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'tests/real-design-tour'))
import fixtures
repo, rev, stem, *_ = fixtures.KICAD['corne']
reader = fixtures.History(Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / '.cache/waffle/project-history' / repo)
tree = reader.tree(rev)
paths = [stem + ext for ext in ('.kicad_pro', '.kicad_sch', '.kicad_pcb')]
paths += ['pcbs/common/left.kicad_sch','pcbs/common/right.kicad_sch']
paths += sorted(p for p in tree if p.endswith(('.kicad_sym','.kicad_mod')))
print(json.dumps([{'path': p, 'bytes': base64.b64encode(reader.bytes(tree[p])).decode('ascii')} for p in paths]))
`;
  const json = require("node:child_process").execFileSync("python3", ["-c", corpus, ...process.argv.slice(3)], {cwd:path.join(__dirname, "../.."), maxBuffer:16*1024*1024});
  const inputs = JSON.parse(json).map(f => ({name:path.basename(f.path), path:f.path, bytes:new Uint8Array(Buffer.from(f.bytes, "base64"))}));
  const designs = inputs.filter(f => !L.handles(f.name)), libraries = inputs.filter(f => L.handles(f.name));
  assert.equal(designs.length, 5); assert.equal(libraries.length, 30);
  for (const [label, files] of [["design", designs], ["libraries", libraries]]) {
    const evidence = recorder(), results = read(files, evidence);
    assert.deepEqual(results, read(files), "Corne with and without fidelity observations");
    const docs = results.flatMap(r => r.documents);
    if (label === "design") {
      assert.deepEqual(docs.map(d => d.items.length).sort((a,b) => a-b), [2,463,464,4625]);
      assert.equal(ofKind(evidence, "part").length, 358);
      assert.equal(ofKind(evidence, "pad").length, 950);
      assert.deepEqual(statuses(evidence, "sheet-link"), ["kept", "kept"]);
      assert.equal(evidence.outputs.length, docs.reduce((n,d) => n+d.items.length, 0));
    } else {
      assert.equal(results.flatMap(r => r.library).length, 37);
      assert.equal(ofKind(evidence, "footprint-definition").length, 29);
      assert.equal(ofKind(evidence, "symbol-definition").length, 13);
      assert.equal(ofKind(evidence, "model3d").length, 18);
    }
    if (globalThis.AtriumTranslators) {
      const {model, report, provenance} = fixed(() => AtriumTranslators.import(files));
      const actual = new Map();
      for (const d of model.documents) for (const i of d.items) {
        const key = d.kind + "/" + i.kind;
        actual.set(key, (actual.get(key) || 0) + 1);
      }
      assert.deepEqual(new Map(report.modelObjects.map(r => [r.documentKind + "/" + r.kind, r.count])), actual);
      assert.deepEqual(provenance.files.map(f => f.sha256), files.map(f => AtriumSourceFile.sha256(f.bytes)));
    }
    console.log("PASS pinned Corne " + label + " (" + files.length + " original files, " + evidence.rows.length + " observed source records)");
  }
}
