"use strict";
// Output job sets (app/formats/output-jobs.js): format and validation, presets with
// board-house layouts, the headless runner, manifest checksums, DRC/ERC
// thresholds, ZIP packaging, path safety and the asynchronous runner.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "altium-rules", "rules", "connectivity", "drc", "messages", "erc", "parts", "spatial", "pcb-appearance", "pcb-pours", "stackup", "board-shape",
  "rigid-flex", "zip", "variants", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "bom", "step-export", "kicad-export", "kicad-schematic", "ipc2581", "panel", "waivers", "drc-waivers", "output-jobs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const J = AtriumOutputJobs, Z = AtriumZip, date = new Date(Date.UTC(2026, 10, 18, 12, 0, 0));
const text = d => typeof d === "string" ? d : new TextDecoder().decode(d);
const project = () => AtriumParts.example();
// The sample passes DRC (tests/checks/sample-drc.cjs). flawed() puts U1's pin-1 dot back over pad 1's mask opening,
// giving exactly one Silk To Solder Mask violation for the gate tests below.
const flawed = () => { const p = project(); p.library.find(d => d.footprint?.name === "SOT-23-5").footprint.shapes.find(s => s.kind === "circle").x = -0.44; return p; };
// ZIP central directory reader: [{name, data}] (stored or not, data only when stored).
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22, out = [];
  assert.equal(v.getUint32(end, true), 0x06054b50);
  let cd = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const method = v.getUint16(cd + 10, true), size = v.getUint32(cd + 20, true), n = v.getUint16(cd + 28, true), local = v.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cd + 46, cd + 46 + n)), start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.push({name, data: method === 0 ? bytes.subarray(start, start + size) : null});
    cd += 46 + n + v.getUint16(cd + 30, true) + v.getUint16(cd + 32, true);
  }
  return out;
}

// ---- SHA-256 (FIPS 180-4 vectors) ------------------------------------------
assert.equal(J.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
assert.equal(J.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(J.sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
assert.equal(J.sha256("a".repeat(1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
assert.equal(J.sha256("é"), J.sha256(new Uint8Array([0xc3, 0xa9])), "strings hash as UTF-8");
const padded = Uint8Array.of(0xff, 0x61, 0x62, 0x63, 0xff);
assert.equal(J.sha256(new DataView(padded.buffer, 1, 3)), J.sha256("abc"), "only visible view bytes are hashed");
const portion = padded.subarray(1, 4);
portion.subarray = () => { throw Error("A byte view need not supply a working subarray method"); };
assert.equal(J.sha256(portion), J.sha256("abc"));
assert.equal(J.sha256(new Uint16Array(padded.buffer, 2, 1)), J.sha256("bc"), "multibyte views hash physical bytes");
assert.equal(J.sha256(padded.buffer), J.sha256("[object ArrayBuffer]"));
assert.equal(J.sha256(null), J.sha256(""));
assert.equal(J.sha256(123), J.sha256("123"));
assert.equal(J.sha256("\ud800"), J.sha256("\ufffd"), "text follows the output encoder's replacement policy");

// ---- Format, validation, storage ----------------------------------------------
assert.throws(() => J.normalise(null), /must be an object/);
assert.throws(() => J.normalise({name: "", outputs: []}), /needs a name/);
assert.throws(() => J.normalise({name: "x".repeat(81), outputs: []}), /needs a name/);
assert.throws(() => J.normalise({name: "A"}), /outputs must be a list/);
assert.throws(() => J.normalise({name: "A", outputs: [{kind: "Gerber!"}]}), /needs a kind/);
assert.throws(() => J.normalise({name: "A", outputs: Array.from({length: 65}, () => ({kind: "readme"}))}), /at most 64/);
{
  const n = J.normalise({name: "  Mine ", junk: 1, zip: "yes", outputs: [{kind: "gerber", id: "same", options: {units: "in", f: () => 1, deep: {a: {b: {c: {d: 1}}}}, n: NaN}}, {kind: "bom", id: "same", enabled: false, label: "BOM"}]});
  assert.equal(n.name, "Mine"); assert.equal(n.zip, false); assert.equal(n.folder, "{project}-{rev}-{date}");
  assert.equal(n.junk, 1, "a field this build doesn't know is kept (a newer Waffle may have written it; docs/format-versioning.md)");
  assert.equal(n.outputs[0].options.units, "in"); assert.ok(!("f" in n.outputs[0].options)); assert.equal(n.outputs[0].options.n, null);
  assert.deepEqual(n.outputs[0].options.deep, {a: {}}, "options are cut at depth three");
  assert.notEqual(n.outputs[0].id, n.outputs[1].id, "output ids are unique");
  assert.equal(n.outputs[1].enabled, false); assert.equal(n.outputs[1].label, "BOM");
  assert.deepEqual(J.normalise(JSON.parse(JSON.stringify(n))), n, "normalise is idempotent");
  const p = project();
  J.save(p, n); J.save(p, {...n, outputs: []});
  assert.equal(J.list(p).length, 1, "saving a set with the same name replaces it");
  assert.equal(J.find(p, "MINE").outputs.length, 0, "names match without case");
  assert.equal(J.remove(p, "mine"), true); assert.ok(!("outputJobs" in p), "the key goes away with the last set");
  assert.ok(Atrium.validate(JSON.parse(JSON.stringify({...p, outputJobs: [n]}))), "a project with job sets stays valid");
}

// ---- Templates and path safety ------------------------------------------------
assert.equal(J.expand("{project}-{rev}-{date}/{nope}", {project: "A/B:C", rev: "2", date: "2026-11-18"}), "A-B-C-2-2026-11-18/{nope}");
assert.equal(J.joinPath("../x", "./y/..", "a\\b", "", "c.txt"), "x/y/a/b/c.txt");

// ---- Presets --------------------------------------------------------------------
const presets = J.presets();
assert.deepEqual(presets.map(p => p.name), ["JLCPCB order", "PCBWay order", "Generic fab + assembly", "Release (placeholders resolved)", "Documentation only", "Everything"]);
// v1 preset names stay runnable (MCP run_output_job, scripts) but are no longer listed.
assert.deepEqual(J.presets({legacy: true}).slice(6).map(p => p.name), ["Full release", "Review pack"]);
assert.equal(J.resolve(project(), "Full release").zip, true);
for (const s of presets) assert.deepEqual(J.normalise(s).outputs.map(o => o.kind), s.outputs.map(o => o.kind));
assert.equal(AtriumFabProfiles.outputLayout("jlcpcb-2l").vendor, "JLCPCB");
assert.equal(AtriumFabProfiles.outputLayout("PCBWay").pnp.style, "altium");
assert.equal(AtriumFabProfiles.outputLayout("oshpark-2l"), null);

// Auxiliary films can contain artwork entirely owned by placed footprints.
{
  const F = AtriumFabOutputs, C = require("./gerber-compare.cjs");
  const p = project(), pcb = p.documents.find(d => d.kind === "pcb");
  const top = pcb.items.find(i => i.ref === "C1"), bottom = pcb.items.find(i => i.ref === "U1");
  Object.assign(top, {x:5, y:4, angle:0});
  Object.assign(bottom, {x:12, y:7, angle:90, layer:"Bottom"});
  pcb.items = [top, bottom];
  function addArtwork(part, layer, points, width) {
    const def = structuredClone(p.library.find(d => d.id === part.def));
    def.id = part.def = "mechanical-" + part.ref;
    def.footprint.shapes = [{kind:"path", layer, points, width}];
    p.library.push(def);
  }
  addArtwork(top, "Mechanical 13", [[0,0], [2,0]], .1);
  addArtwork(bottom, "Mechanical 15", [[1,0], [1,2]], .2);
  const base = F.build(p, pcb, {date, origin:"absolute"});
  const auxiliary = /^GM1[35]$/;
  assert.deepEqual(F.gerberLayers(base.model).filter(l => auxiliary.test(l.ext)).map(l => [l.ext, l.count]).sort(),
    [["GM13", 1], ["GM15", 1]]);
  assert(!base.files.some(f => /\.GM1[35]$/.test(f.name)), "placed-only mechanical films are opt-in");
  const job = {name:"Mechanical artwork", outputs:[{kind:"gerber", options:{
    origin:"absolute", layers:{GM13:true, GM15:true}, drill:false, readme:false
  }}]};
  J.save(p, job);
  const saved = J.run(p, job.name, {date});
  assert.equal(saved.report.ok, true);
  for (const [ext, path] of [["GM13", [[5,-4], [7,-4]]], ["GM15", [[12,-8], [10,-8]]]]) {
    const film = saved.files.find(f => f.name.endsWith("." + ext));
    const parsed = C.parseGerber(text(film.data));
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.draws.length, 1);
    assert.deepEqual(parsed.draws[0].points, path, "placed artwork keeps its layer and world coordinates");
  }
}

// ---- JLCPCB order --------------------------------------------------------------
{
  const p = flawed(), frozen = JSON.stringify(p), out = J.run(p, "JLCPCB order", {date});
  assert.equal(JSON.stringify(p), frozen, "running never modifies the project");
  const r = out.report, folder = "Sensor interface-1-JLCPCB-2026-11-18";
  assert.equal(r.folder, folder); assert.equal(r.job, "JLCPCB order"); assert.equal(r.preset, true); assert.equal(r.board, "Sensor board");
  // Fabrication files take the fab dialog's stem (the project name slugified: "Sensor-interface"); reports keep the board name.
  assert.deepEqual(out.files.map(f => f.name), [folder + "/Reports/Sensor board DRC.html", folder + "/Sensor-interface-Gerber.zip", folder + "/BOM-Sensor-interface.csv",
    folder + "/CPL-Sensor-interface.csv", folder + "/Sensor-interface-Order-Notes.txt", folder + "/README.txt", folder + "/SHA256SUMS"]);
  assert.match(text(out.files[4].data), /^Order notes: Sensor board \(JLCPCB\)/);
  // The flawed board has one DRC violation, so the order fails its 0-violation gate.
  assert.equal(r.ok, false); assert.deepEqual(r.failed, ["drc"]);
  assert.equal(r.outputs[0].status, "failed"); assert.match(r.outputs[0].message, /^1 rule violation \(more than 0\)\.$/);
  const gerberZip = unzip(out.files[1].data).map(e => e.name);
  assert.ok(gerberZip.includes("Sensor-interface.GTL") && gerberZip.includes("Sensor-interface-Plated.TXT") && !gerberZip.some(n => /Readme|csv|svg/i.test(n)), gerberZip.join());
  const bom = text(out.files[2].data).split("\r\n");
  assert.equal(bom[0], "Comment,Designator,Footprint,LCSC Part #", "JLC BOM header, no byte-order mark or title block");
  assert.equal(bom.filter(Boolean).length, 1 + 7);
  assert.ok(r.outputs[2].warnings.some(w => /no LCSC part number/.test(w)));
  const cpl = text(out.files[3].data).split("\r\n");
  assert.equal(cpl[0], "Designator,Mid X,Mid Y,Layer,Rotation");
  assert.match(cpl.find(l => l.startsWith("\"C1\"")), /^"C1",\d+\.\d{4}mm,\d+\.\d{4}mm,Top,270$/);
  // Manifest: every other file with its SHA-256 and size.
  const readme = text(out.files[5].data), sums = text(out.files[6].data).trim().split("\n");
  assert.equal(sums.length, 5);
  for (const f of out.files.slice(0, 5)) {
    const rel = f.name.slice(folder.length + 1), sha = J.sha256(f.data);
    assert.ok(sums.includes(sha + "  " + rel), rel + " in SHA256SUMS");
    assert.ok(readme.includes(sha), rel + " in README");
  }
  assert.match(readme, /\[FAILED\] Design rule check report/);
  // Report rows carry sizes and checksums.
  const row = r.outputs.find(o => o.kind === "pnp");
  assert.deepEqual(row.files.map(f => f.name), ["CPL-Sensor-interface.csv"]);
  assert.equal(row.files[0].sha256, J.sha256(out.files[3].data));
  // Deterministic for a fixed date.
  const again = J.run(flawed(), "JLCPCB order", {date});
  assert.deepEqual(again.files.map(f => J.sha256(f.data)), out.files.map(f => J.sha256(f.data)));
}

// ---- Full release: one ZIP, every output kind --------------------------------
{
  const p = project();
  AtriumBOM.saveView(p, {name: "Purchasing", columns: ["comment", "quantity", "designator"], groupBy: ["comment"]});
  const set = {...J.presets({legacy: true}).find(s => s.name === "Full release"), name: "Release", revision: "B2"};
  set.outputs = set.outputs.map(o => o.kind === "bom" && o.options.format === "xlsx" ? {...o, options: {...o.options, view: "Purchasing"}} : o);
  set.outputs = set.outputs.map(o => o.kind === "drc" ? {...o, options: {failOver: 5}} : o);
  const out = J.run(p, set, {date}), r = out.report;
  assert.equal(r.ok, true, JSON.stringify(r.outputs.filter(o => o.status === "error" || o.status === "failed")));
  assert.equal(out.files.length, 1); assert.equal(out.files[0].name, "Sensor interface-B2-2026-11-18.zip");
  assert.equal(r.zip.sha256, J.sha256(out.files[0].data));
  const names = unzip(out.files[0].data).map(e => e.name);
  for (const n of ["Gerber/Sensor-interface.GTL", "Gerber/Sensor-interface-Fabrication-Readme.txt", "Assembly/Pick Place for Sensor-interface.csv", "Assembly/Sensor-interface-Assembly-Top.svg",
    "BOM/Sensor interface-BOM.xlsx", "BOM/Sensor interface-BOM.csv", "3D/Sensor board.step", "IPC-2581/Sensor board.ipc2581.xml", "KiCad/Sensor board.kicad_pcb",
    "Reports/Sensor board DRC.html", "Reports/Sensor interface ERC.html", "README.txt", "SHA256SUMS"]) assert.ok(names.includes("Sensor interface-B2-2026-11-18/" + n), n + " in " + names.join());
  assert.ok(names.some(n => n.endsWith(".kicad_sch")), "schematic sheets exported");
  assert.equal(r.outputs.find(o => o.kind === "pdf").status, "skipped", "PDF is skipped without AtriumPDF");
  assert.match(r.outputs.find(o => o.kind === "ipc2581").summary, /structural check passed/);
  assert.match(r.outputs.find(o => o.id === "bom").summary, /view Purchasing/);
  assert.equal(r.revision, "B2");
  const fileOnly = J.run(p, set, {date, files: false});
  assert.deepEqual(fileOnly.files, [{name: "Sensor interface-B2-2026-11-18.zip"}], "files:false returns names only");
}

// ---- DRC waivers: the report and the gate leave waived violations out -------------
{
  const p = flawed(), board = p.documents.find(d => d.kind === "pcb"), defs = new Map(p.library.map(d => [d.id, d]));
  const found = AtriumRules.drc(board, defs, AtriumRules.stored(board, p) || AtriumRules.defaults(), {project: p}).violations;
  assert.equal(found.length, 1, "the flawed board has one violation");
  AtriumDRCWaivers.add(board, found[0], {note: "Pin-1 dot accepted by the fab"});
  const gate = {name: "Gate", folder: "", outputs: [{kind: "drc", options: {failOver: 0}}, {kind: "drc", id: "json", options: {failOver: 0, format: "json"}}]};
  const r = J.run(p, gate, {date}), [html, json] = r.files.map(f => text(f.data));
  assert.equal(r.report.ok, true, "a waived violation does not fail the 0-violation gate");
  assert.match(r.report.outputs[0].summary, /^0 violations \(1 waived\), /);
  assert.match(html, /Rule violations: <b>0<\/b>/); assert.match(html, /Waived violations <small>\(1\)<\/small>/); assert.match(html, /Pin-1 dot accepted/);
  const j = JSON.parse(json);
  assert.deepEqual([j.total, j.violations.length, j.waived.length, j.waived[0].note], [0, 0, 1, "Pin-1 dot accepted by the fab"]);
  // Waivers v2: a measured violation's waiver holds while the value is no worse, so a nudge keeps it;
  // one held until-changed (every waiver made before v2) turns stale and stops hiding the violation.
  const moved = () => board.items.find(i => i.id === AtriumDRCWaivers.list(board)[0].objects[0]);
  const holds = AtriumDRCWaivers.list(board)[0].holds;
  moved().x += 0.01;
  if (holds === "while-not-worse") assert.equal(J.run(p, gate, {date}).report.ok, true, "a nudge that is no worse keeps the waiver");
  AtriumDRCWaivers.add(board, AtriumRules.drc(board, defs, AtriumRules.stored(board, p) || AtriumRules.defaults(), {project: p}).violations[0], {note: "again", holds: "until-changed"});
  moved().x += 0.01;
  assert.equal(J.run(p, gate, {date}).report.ok, false, "an until-changed waiver is stale after its object changed");
}

// ---- Failures, thresholds, skips -----------------------------------------------
{
  const p = flawed();
  const base = {name: "Gate", folder: "", outputs: [{kind: "drc", options: {failOver: 0}}, {kind: "gerber", options: {}}, {kind: "erc", options: {failOver: null, format: "json"}},
    {kind: "bom", options: {view: "Missing"}}, {kind: "future-kind"}, {kind: "assembly", enabled: false}, {kind: "readme", options: {sums: false}}]};
  const r = J.run(p, base, {date}).report, st = r.outputs.map(o => o.kind + ":" + o.status);
  assert.deepEqual(st, ["drc:failed", "gerber:ok", "erc:ok", "bom:error", "future-kind:skipped", "assembly:skipped", "readme:ok"]);
  assert.match(r.outputs[3].message, /no BOM view called Missing/);
  assert.match(r.outputs[4].message, /Unknown output kind/);
  assert.equal(r.ok, false); assert.deepEqual(r.failed.length, 2);
  const erc = JSON.parse(text(J.run(p, {...base, outputs: [base.outputs[2]]}, {date}).files[0].data));
  assert.equal(typeof erc.passed, "boolean");
  // stopOnFailure skips everything after the first failure (the README still runs).
  const stop = J.run(p, {...base, stopOnFailure: true}, {date}).report;
  assert.deepEqual(stop.outputs.map(o => o.status), ["failed", "skipped", "skipped", "skipped", "skipped", "skipped", "ok"]);
  // A raised threshold passes; no board means board outputs are skipped.
  assert.equal(J.run(p, {name: "OK", outputs: [{kind: "drc", options: {failOver: 3}}]}, {date}).report.ok, true);
  const sch = project(); sch.documents = sch.documents.filter(d => d.kind !== "pcb");
  const noBoard = J.run(sch, {name: "S", outputs: [{kind: "gerber"}, {kind: "erc"}, {kind: "bom", options: {source: "schematic"}}]}, {date}).report;
  assert.deepEqual(noBoard.outputs.map(o => o.status), ["skipped", "ok", "ok"]);
  assert.throws(() => J.run(p, "Nope"), /no output job set called Nope.*JLCPCB order \(preset\)/);
  assert.throws(() => J.run(p, {name: "B", board: "missing", outputs: []}), /board missing is not in the project/);
  assert.throws(() => J.run(p, base, {date: "yesterday"}), /ISO 8601/);
  // Two outputs writing the same path: the later one is kept, with a warning.
  const dup = J.run(p, {name: "D", folder: "", outputs: [{kind: "bom"}, {kind: "bom"}]}, {date});
  assert.equal(dup.files.length, 1); assert.ok(dup.report.outputs[1].warnings.some(w => /Two outputs wrote/.test(w)));
  // Path traversal in templates stays inside the folder.
  const trav = J.run(p, {name: "T", folder: "../../{project}", outputs: [{kind: "pnp", folder: "../..", options: {name: "../../evil.csv"}}]}, {date});
  assert.deepEqual(trav.files.map(f => f.name), ["Sensor interface/evil.csv"]);
}

// ---- Asynchronous runner with progress and an asynchronous PDF -----------------
globalThis.__testDone = (async () => {
  const p = project(), events = [];
  globalThis.AtriumPDF = {build: async (proj, o) => ({name: proj.name + ".pdf", data: new Uint8Array([37, 80, 68, 70, 45]), board: o.board})};
  try {
    const set = {name: "Review", folder: "{job}", outputs: [{kind: "pdf"}, {kind: "assembly"}, {kind: "readme"}]};
    const sync = J.run(p, set, {date}).report.outputs[0];
    assert.equal(sync.status, "error"); assert.match(sync.message, /runAsync/);
    const out = await J.runAsync(p, set, {date}, e => events.push(e.phase + ":" + e.kind));
    assert.deepEqual(events, ["start:pdf", "done:pdf", "start:assembly", "done:assembly", "start:readme", "done:readme"]);
    assert.equal(out.report.ok, true);
    assert.deepEqual(out.files.map(f => f.name), ["Review/PDF/Sensor interface.pdf", "Review/Assembly/Sensor-interface-Assembly-Top.svg", "Review/README.txt", "Review/SHA256SUMS"]);
    assert.ok(text(out.files[3].data).includes(J.sha256(new Uint8Array([37, 80, 68, 70, 45])) + "  PDF/Sensor interface.pdf"));
  } finally { delete globalThis.AtriumPDF; }
  // Consecutive requests share only the matching panel geometry, even within a variant.
  const panels = project(), board = panels.documents.find(d => d.kind === "pcb");
  const first = AtriumPanel.create(panels,{board:board.id,rows:1,cols:1});
  const second = AtriumPanel.create(panels,{board:board.id,rows:1,cols:2,name:"Two-up"});
  panels.documents.push(first,second);
  const variant = AtriumVariants.create(panels,{name:"Assembly alternate"}).id;
  const films = {name:"Dated panels", outputs:[{kind:"gerber",options:{variant,drill:false,readme:false}}, {kind:"ipc2581",options:{variant}}]};
  const session = J.session(panels, films, {panel:first.id,date});
  const filesOf = async job => (await Promise.all(job.set.outputs.map(out => job.generate(out)))).flatMap(result => result.files);
  const before = await filesOf(session);
  for (const [panel, stamp] of [[first,new Date(+date + 86400000)],[second,new Date(+date + 86400000)]]) {
    session.ctx.panel = panel;
    session.ctx.date = stamp;
    const files = await filesOf(session);
    assert.deepEqual(files, await filesOf(J.session(panels,films,{panel:panel.id,date:stamp})));
    assert.notEqual(files.find(f=>f.name.endsWith(".GTO")).data, before.find(f=>f.name.endsWith(".GTO")).data);
  }
  // describe() plans without generating.
  const d = J.describe(p, "Full release", {date});
  assert.equal(d.zip, "Sensor interface-1-2026-11-18.zip");
  assert.equal(d.outputs.find(o => o.kind === "pdf").available, false);
  // Speed: the full release on a dense board.
  const big = project(), pcb = big.documents.find(x => x.kind === "pcb");
  for (let i = 0; i < 3000; i++) pcb.items.push({id: "bv" + i, kind: "via", x: 2 + (i % 60) * .4, y: 2 + Math.floor(i / 60) * .4, diameter: .3, drill: .15, layer: "Multi", net: "N" + (i % 20)});
  const t0 = Date.now(), res = J.run(big, {name: "Big", outputs: [{kind: "gerber"}, {kind: "ipc2581"}, {kind: "readme"}]}, {date}), ms = Date.now() - t0;
  assert.ok(res.report.outputs.every(o => o.status !== "error"), JSON.stringify(res.report.outputs.map(o => o.message)));
  assert.ok(ms < 5000, "dense job took " + ms + " ms");
  // The real PDF path: print.js through the editor's renderer, synchronous and headless.
  for (const m of ["sch-appearance", "canvas", "path-record", "pdf", "print"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const pdf = J.run(project(), {name: "P", folder: "", outputs: [{kind: "pdf", options: {paper: "A3", name: "{project}-{rev}"}}]}, {date});
  assert.equal(pdf.report.outputs[0].status === "ok" || pdf.report.outputs[0].status === "warning", true, JSON.stringify(pdf.report.outputs[0]));
  assert.equal(pdf.files[0].name, "PDF/Sensor interface-1.pdf");
  assert.equal(text(pdf.files[0].data.subarray(0, 8)), "%PDF-1.4");
  const pagesProject = project(), sheet = pagesProject.documents.find(d=>d.kind==="schematic");
  sheet.sheet={infinite:true};
  sheet.items=["First","Second"].map((text,k)=>({id:"frame"+k,kind:"textframe",role:"frame",text,x:-350+450*k,y:0,w:100,h:70}));
  for (const layout of ["frames","fit","tile"]) {
    const options={documents:[sheet.id],infiniteLayout:layout,infiniteScale:1.25,compress:false};
    const set={name:"Pages",outputs:[{kind:"pdf",options}]};
    J.save(pagesProject,set);
    const restored=JSON.parse(JSON.stringify(pagesProject)), saved=J.find(restored,"Pages");
    assert.equal(saved.outputs[0].options.infiniteLayout,layout);
    const out=J.run(restored,"Pages",{date}), expected=AtriumPrint.build(restored,{...options,date,title:restored.name});
    assert.equal(out.report.outputs[0].status,"ok");
    assert.deepEqual(out.files[0].data,expected.bytes());
  }
  for(const options of [{infiniteLayout:"unknown"},{infiniteScale:NaN},{infiniteScale:0}])
    assert.throws(()=>J.save(pagesProject,{name:"Invalid",outputs:[{kind:"pdf",options}]}),/tile scale/);
  console.log("PASS output-jobs: format, presets (JLCPCB, PCBWay, Full release, Review pack), manifest, thresholds, zip, paths, async + PDF; dense job " + ms + " ms");
})();
