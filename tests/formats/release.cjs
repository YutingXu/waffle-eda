"use strict";
// Release (app/formats/release.js): package names, pre-flight gates and overrides, versioned packages with
// release.json and RELEASE.md, vendor bundles, zip packages, per-variant releases, the input-hash
// cache, release records and compare, v1 job-set migration, the worker's module list and the
// Gerber thumbnail renderer (app/formats/release-preview.js, DOM-free part).
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "altium-rules", "rules", "connectivity", "drc", "messages", "erc", "parts", "spatial", "pcb-appearance", "pcb-pours", "stackup", "board-shape",
  "rigid-flex", "zip", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "variants", "bom", "step-export", "kicad-export", "kicad-schematic", "ipc2581", "panel", "waivers", "drc-waivers", "output-jobs",
  "vendor/zipjs-deflate", "odb-eda", "odb", "release-worker-modules", "release", "release-preview", "translator-provenance", "import-sidecars"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const J = AtriumOutputJobs, R = AtriumRelease, date = new Date(Date.UTC(2026, 10, 19, 12, 0, 0));
const text = d => typeof d === "string" ? d : new TextDecoder().decode(d);
const project = () => AtriumParts.example();
const flawed = () => { const p = project(); p.library.find(d => d.footprint?.name === "SOT-23-5").footprint.shapes.find(s => s.kind === "circle").x = -0.44; return p; };
const output = (run, pattern) => run.files.find(f => pattern.test(f.name));
const sha = (run, pattern) => J.sha256(output(run,pattern).data);
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22, out = [];
  let cd = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const size = v.getUint32(cd + 20, true), n = v.getUint16(cd + 28, true), local = v.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cd + 46, cd + 46 + n)), start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.push({name, data: bytes.subarray(start, start + size)});
    cd += 46 + n + v.getUint16(cd + 30, true) + v.getUint16(cd + 32, true);
  }
  return out;
}

globalThis.__testDone = (async () => {
  // ---- Names, revisions, variants ------------------------------------------------
  {
    const p = project();
    assert.equal(R.packageName(p, J.resolve(p, "JLCPCB order"), {date}), "Sensor interface-1-2026-11-19", "no variant segment without variants");
    p.revision = "B";
    assert.equal(R.revisionOf(p, {}), "B", "project.revision is the revision hook");
    p.revision = {letter: "C"};
    assert.equal(R.packageName(p, {}, {date}), "Sensor interface-C-2026-11-19");
    assert.equal(R.packageName(p, {revision: "D"}, {date, variant: "Lite"}), "Sensor interface-D-Lite-2026-11-19");
    assert.deepEqual(R.targets(p, {}), [{ref: undefined, key: "", name: ""}]);
    const lite = AtriumVariants.create(p, {name: "Lite"});
    assert.deepEqual(R.targets(p, {}).map(t => t.name), ["Base"], "the active variant: none, so the base design");
    AtriumVariants.setActive(p, lite.id);
    assert.deepEqual(R.targets(p, {}).map(t => t.name), ["Lite"]);
    assert.deepEqual(R.targets(p, {variants: "all"}).map(t => t.name), ["Base", "Lite"]);
    assert.deepEqual(R.targets(p, {}, ["lite", "base"]).map(t => t.ref), [lite.id, null]);
    assert.throws(() => R.targets(p, {}, ["Nope"]), /no assembly variant called Nope/);
  }

  // ---- Migration: v1 job sets keep working ----------------------------------------
  {
    const p = project();
    // A v1 set as an older Waffle saved it: a fork of the JLCPCB preset, and a plain zip job.
    const v1 = {name: "My JLC", version: 1, folder: "{project}-{rev}-JLCPCB-{date}", zip: false, fabProfile: "jlcpcb-2l", outputs: [
      {id: "drc", kind: "drc", enabled: true, options: {failOver: 0, format: "html"}},
      {id: "gerber", kind: "gerber", enabled: true, folder: "", options: {units: "mm", drillUnits: "mm", readme: false, pack: "{stem}-Gerber.zip"}},
      {id: "bom", kind: "bom", enabled: true, folder: "", options: {style: "jlc", format: "csv", source: "pcb", name: "BOM-{stem}.csv"}},
      {id: "pnp", kind: "pnp", enabled: true, folder: "", options: {style: "jlc", units: "mm", name: "CPL-{stem}.csv"}},
      {id: "readme", kind: "readme", enabled: true, options: {}}]};
    const zipped = {name: "Zipped", version: 1, folder: "{project}-{rev}", zip: true, outputs: [{kind: "gerber"}, {kind: "readme"}]};
    p.outputJobs = [JSON.parse(JSON.stringify(v1)), zipped];
    const m = J.migrate(v1);
    assert.equal(m.version, 2); assert.deepEqual(m.package, {mode: "vendor", vendor: "JLCPCB"}, "a JLCPCB-style v1 set reads as a JLCPCB bundle");
    assert.deepEqual(J.migrate(zipped).package, {mode: "zip"});
    assert.deepEqual(J.migrate({name: "F", outputs: []}).package, {mode: "folder"});
    assert.deepEqual(J.normalise(JSON.parse(JSON.stringify(m))), m, "migration is idempotent");
    // Same files, byte for byte, before and after migration.
    const a = J.run(p, v1, {date}), b = J.run(p, m, {date});
    assert.deepEqual(b.files.map(f => f.name), a.files.map(f => f.name));
    assert.deepEqual(b.files.map(f => J.sha256(f.data)), a.files.map(f => J.sha256(f.data)));
    assert.deepEqual(J.run(p, "Zipped", {date}).files.map(f => f.name), ["Sensor interface-1.zip"]);
    // The model accepts a project with v2 sets and release records.
    assert.ok(Atrium.validate(JSON.parse(JSON.stringify({...p, outputJobs: [m], releases: []}))));
  }

  // ---- Vendor packages fill in the board house's layout -----------------------------
  {
    const p = project();
    const set = {name: "Bare", folder: "out", package: {mode: "vendor", vendor: "PCBWay"}, outputs: [{kind: "gerber"}, {kind: "bom"}, {kind: "pnp"}]};
    const names = J.run(p, set, {date}).files.map(f => f.name);
    assert.deepEqual(names, ["out/Sensor-interface-Gerber.zip", "out/Sensor-interface-BOM.csv", "out/Sensor-interface-PickPlace.csv"], names.join());
    // An explicit option or folder wins over the vendor layout.
    const own = J.run(p, {...set, outputs: [{kind: "bom", folder: "B", options: {name: "parts.csv"}}]}, {date}).files.map(f => f.name);
    assert.deepEqual(own, ["out/B/parts.csv"]);
  }

  // ---- Pre-flight: gates, fix targets, overrides -----------------------------------
  {
    const p = flawed(), board = p.documents.find(d => d.kind === "pcb");
    const defs = new Map(p.library.map(d=>[d.id,d]));
    const initial = AtriumDRC.batch(board,defs);
    assert.equal(initial.total,1);
    const type = initial.violations[0].type;
    board.ruleCheckSelection = {batch:[type],online:[type]};
    assert.equal(AtriumDRC.batch(board,defs).total,0);
    const pf = R.preflight(p, "JLCPCB order", {});
    assert.deepEqual(pf.checks.map(c => c.id), ["drc", "erc", "bom", "variants", "placeholders", "git", "outputs"]);
    const st = Object.fromEntries(pf.checks.map(c => [c.id, c.status]));
    assert.equal(st.drc, "fail"); assert.equal(st.variants, "skip"); assert.equal(st.git, "skip");
    assert.ok(["warn", "fail"].includes(st.bom), "starter parts have no MPN or LCSC number: " + st.bom);
    const drc = pf.checks[0];
    assert.match(drc.summary, /^1 violation on Sensor board\.$/);
    assert.ok(drc.items[0].target.doc && drc.items[0].target.id, "a DRC problem says where it is");
    assert.equal(drc.fix.action, "drc");
    assert.equal(pf.ok, false);
    assert.deepEqual(R.blocking(pf.checks, []).map(c => c.id).filter(id => id === "drc"), ["drc"]);
    assert.deepEqual(R.blocking(pf.checks, [{check: "drc", reason: "  "}]).map(c => c.id).filter(id => id === "drc"), ["drc"], "an override needs a reason");
    assert.ok(!R.blocking(pf.checks, [{check: "drc", reason: "Fab accepts the pin-1 dot"}]).some(c => c.id === "drc"));
    // Unsaved and uncommitted changes.
    assert.equal(R.preflight(project(), "JLCPCB order", {unsaved: true}).checks.find(c => c.id === "git").status, "fail");
    assert.equal(R.preflight(project(), "JLCPCB order", {git: {available: true, commit: "a".repeat(40), dirty: true}}).checks.find(c => c.id === "git").status, "fail");
    const clean = R.preflight(project(), "JLCPCB order", {git: {available: true, commit: "b".repeat(40), branch: "main", dirty: false}}).checks.find(c => c.id === "git");
    assert.equal(clean.status, "pass"); assert.match(clean.summary, /bbbbbbbbbb on main/);
    // A job set can turn a gate off.
    assert.equal(R.preflight(flawed(), {name: "G", gates: {drc: false}, outputs: [{kind: "gerber"}]}).checks[0].status, "skip");
    // Duplicate designators fail the BOM gate.
    const dup = project(), parts = dup.documents.find(d => d.kind === "schematic").items.filter(i => i.kind === "part");
    parts[1].ref = parts[0].ref;
    assert.equal(R.preflight(dup, "Generic fab + assembly").checks.find(c => c.id === "bom").status, "fail");
  }

  // ---- Release: one versioned package with release.json and RELEASE.md ---------------
  let first;
  {
    const p = flawed(), frozen = JSON.stringify(p);
    await assert.rejects(R.release(p, "JLCPCB order", {date}), /Pre-flight failed: Design rules \(DRC\)/);
    const overrides = [{check: "drc", reason: "Fab accepts the pin-1 dot"}, {check: "bom", reason: "unused"}];
    const out = await R.release(p, "JLCPCB order", {date, overrides, notes: "First build", git: {available: true, commit: "c".repeat(40), branch: "main", dirty: false}, force: true});
    assert.equal(JSON.stringify(p), frozen, "releasing never modifies the project");
    const name = "Sensor interface-1-2026-11-19";
    assert.equal(out.name, name);
    const names = out.files.map(f => f.name);
    for (const n of ["Sensor-interface-Gerber.zip", "BOM-Sensor-interface.csv", "CPL-Sensor-interface.csv", "Sensor-interface-Order-Notes.txt", "README.txt", "SHA256SUMS", "RELEASE.md", "release.json"])
      assert.ok(names.includes(name + "/" + n), n + " in " + names.join());
    const manifest = JSON.parse(text(out.files.find(f => f.name.endsWith("release.json")).data));
    assert.equal(manifest.format, "atrium-release"); assert.equal(manifest.revision, "1"); assert.equal(manifest.git.commit, "c".repeat(40));
    assert.equal(manifest.job.name, "JLCPCB order"); assert.equal(manifest.job.preset, true); assert.deepEqual(manifest.package, {mode: "vendor", vendor: "JLCPCB"});
    assert.match(manifest.rulesHash, /^[0-9a-f]{64}$/); assert.match(manifest.designHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest.overrides.map(o => o.check), ["drc", "bom"]);
    assert.equal(manifest.notes, "First build");
    assert.ok(manifest.tool.version);
    // Every file but release.json is listed with its SHA-256, and the hashes match the bytes.
    const byPath = new Map(out.files.map(f => [f.name.slice(name.length + 1), f]));
    assert.equal(manifest.files.length, out.files.length - 1);
    for (const f of manifest.files) assert.equal(J.sha256(byPath.get(f.path).data), f.sha256, f.path);
    const md = text(byPath.get("RELEASE.md").data);
    assert.match(md, /^# Sensor interface-1-2026-11-19/); assert.match(md, /Overridden: Fab accepts the pin-1 dot/); assert.match(md, /\| Git commit \| c{40} \(main\)/);
    assert.match(md, /- \[ \] \*\*Design rules \(DRC\)\*\*/);
    // The record for project.releases: small, with a BOM snapshot.
    const rec = out.record;
    assert.equal(rec.packages.length, 1); assert.equal(rec.packages[0].files.length, manifest.files.length);
    assert.ok(rec.packages[0].bom.length >= 7);
    assert.ok(JSON.stringify(rec).length < 20000);
    R.add(p, rec); R.add(p, rec);
    assert.equal(R.list(p).length, 1, "adding the same record twice keeps one");
    first = {p, rec};
  }

  // ---- Zip package, the cache, preview runs ----------------------------------------
  {
    const p = project(), cache = R.createCache();
    const out = await R.release(p, "Generic fab + assembly", {date, cache});
    assert.deepEqual(out.files.map(f => f.name), ["Sensor interface-1-2026-11-19.zip"]);
    const inside = unzip(out.files[0].data).map(e => e.name);
    assert.ok(inside.includes("Sensor interface-1-2026-11-19/release.json") && inside.includes("Sensor interface-1-2026-11-19/Gerber/Sensor-interface.GTL"), inside.join());
    assert.equal(out.stats.cached, 0);
    // Same design and options: every output comes from the cache, with identical bytes.
    const again = await R.release(p, "Generic fab + assembly", {date, cache});
    assert.equal(again.stats.page, 0); assert.ok(again.stats.cached >= 6);
    assert.equal(J.sha256(again.files[0].data), J.sha256(out.files[0].data), "cached outputs are byte-identical");
    // A BOM option change regenerates only the BOM.
    const set = J.resolve(p, "Generic fab + assembly");
    set.outputs.find(o => o.kind === "bom").options.format = "html";
    const events = [];
    const prev = await R.generate(p, set, {date, cache, progress: e => e.phase === "done" && events.push(e.kind + (e.row.cached ? ":cached" : ""))});
    assert.equal(prev.stats.page, 1, JSON.stringify(prev.stats));
    assert.ok(events.includes("bom") && events.includes("gerber:cached"), events.join());
    // A board edit regenerates the board outputs but not the ERC.
    p.documents.find(d => d.kind === "pcb").items.push({id: "v-new", kind: "via", x: 5, y: 5, diameter: .6, drill: .3, layer: "Multi", net: "GND"});
    const edited = await R.generate(p, set, {date, cache, progress: () => {}});
    assert.ok(edited.stats.page >= 3 && edited.stats.cached >= 1, JSON.stringify(edited.stats));
    // A cancelled preview reports its skipped work. A cancelled release cannot publish a package.
    const ac = new AbortController();
    ac.abort();
    const erc = globalThis.AtriumERC;
    let cancelled;
    try {
      globalThis.AtriumERC = {...erc, prepareCalculations() { assert.fail("A cancelled preview must not prepare ERC calculations."); }};
      cancelled = await R.generate(project(), "Everything", {date, signal: ac.signal});
    } finally { globalThis.AtriumERC = erc; }
    assert.equal(cancelled.report.ok, false);
    assert.ok(cancelled.report.outputs.length > 0);
    assert.ok(cancelled.report.outputs.every(o => o.status === "skipped" && /Cancelled/.test(o.message)));
    assert.deepEqual(cancelled.files, []);
    assert.deepEqual(cancelled.stats, {cached: 0, worker: 0, page: 0});
    await assert.rejects(R.release(project(), "Everything", {date, signal: ac.signal}), {name:"AbortError",message:"Cancelled."});
  }

  // ---- A worker that cannot start or fails an output: the page makes it, same bytes --
  {
    const p = project(), page = await R.release(p, "Generic fab + assembly", {date});
    const fake = (run, reason = "") => ({for: () => ({reason, run, setProject() {}}), cancel() {}, close() {}});
    // A worker that never started (release.js run() throws "No worker.") leaves every output to the page.
    const noStart = await R.release(p, "Generic fab + assembly", {date, worker: fake(async () => { throw Error("No worker."); }, "no file:// workers here")});
    assert.equal(noStart.stats.worker, 0); assert.match(noStart.stats.workerError, /could not start: no file:\/\/ workers here/);
    assert.equal(J.sha256(noStart.files[0].data), J.sha256(page.files[0].data), "the page fallback makes the same package");
    // An output the worker answers with an error is made again on the page, and the release is complete.
    const failing = await R.release(p, "Generic fab + assembly", {date, worker: fake(async (set, out) => ({status: "error", message: "boom in " + out.kind, files: [], warnings: []}))});
    assert.equal(failing.stats.worker, 0); assert.ok(failing.ok, "no output is left in error"); assert.match(failing.stats.workerError, /boom in/);
    assert.equal(J.sha256(failing.files[0].data), J.sha256(page.files[0].data));
    const odb = {name: "ODB++ release", folder: "", outputs: [{kind: "odb"}]};
    let called = false;
    const legacy = fake(async () => { called = true; return {status: "skipped", files: []}; });
    const cache = R.createCache(), opts = {date, worker: legacy, cache, force: true};
    const preview = (odbEnabled = false) => R.generate(p, odb, {...opts, odbEnabled});
    function disabled(run, report = run.report) {
      assert.equal(report.outputs[0].status, "skipped");
      assert.match(report.outputs[0].message, /disabled in Experimental features/);
      assert.equal(run.stats.cached, 0);
      assert.equal(output(run, /\.tgz$/), undefined);
    }
    let labs = false;
    const prefs = globalThis.AtriumPrefs;
    globalThis.AtriumPrefs = {get:key => key === "butter.odb" ? labs : prefs?.get(key)};
    try {
      disabled(await preview());
      const enabled = await preview(true);
      assert.equal(enabled.report.outputs[0].status, "ok");
      assert.equal(sha(enabled, /\.tgz$/), sha(J.run(p, odb, {date, odbEnabled: true}), /\.tgz$/));
      disabled(await preview());
      labs = true;
      const labsEnabled = await preview();
      assert.equal(labsEnabled.stats.cached, 1);
      assert.equal(sha(labsEnabled, /\.tgz$/), sha(enabled, /\.tgz$/));
      labs = false;
      const releasedOff = await R.release(p, odb, opts);
      disabled(releasedOff, releasedOff.packages[0].report);
      const releasedOn = await R.release(p, odb, {...opts, odbEnabled: true});
      assert.equal(releasedOn.stats.cached, 1);
      assert.equal(sha(releasedOn, /\.tgz$/), sha(R.releaseSync(p, odb, {...opts, odbEnabled: true}), /\.tgz$/));
      assert.equal(called, false, "the file worker has no ODB++ writer");
    } finally { globalThis.AtriumPrefs = prefs; }

    const sourced = {name:"Imported board",folder:"",outputs:[{kind:"gerber"},{kind:"kicad"}]};
    const provenance = [{files:[]}], F = globalThis.AtriumFabOutputs;
    let received;
    globalThis.AtriumFabOutputs = {...F, analyse(project, board, options) {
      received = options.provenance;
      return F.analyse(project, board, options);
    }};
    try {
      const generated = await R.generate(p, sourced, {...opts, provenance});
      assert.ok(generated.report.ok);
      assert.equal(received, provenance, "local Gerber receives the sidecar");
      assert.equal(generated.stats.worker, 0, "the file worker cannot receive the sidecar");
      assert.equal(generated.stats.page, 2);
      assert.equal(called, false);
      assert.equal(sha(generated, /\.GTL$/), sha(J.run(p, sourced, {date, provenance}), /\.GTL$/));
    } finally { globalThis.AtriumFabOutputs = F; }
  }

  // A cached release of unchanged native geometry must see changed retained drill artwork.
  {
    const p = Atrium.project("Retained drill drawing"), board = p.documents.find(d => d.kind === "pcb");
    board.outline = [[0,0],[20,0],[20,15],[0,15]];
    board.items = [{id:"source-hole",kind:"pad",layer:"Multi",x:5,y:5,w:1,h:1,shape:"circle",drill:.6,plated:false}];
    board.sourceDrillDrawing = {tools:[0,1].map(mark => ({mark,diameter:.6,slot:0,plated:false,hits:1}))};
    const panel = AtriumPanel.create(p,{board:board.id,rows:1,cols:1,separation:"vscore",
      rails:{top:false,bottom:false},fiducials:{enabled:false},tooling:{enabled:false}});
    p.documents.push(panel);
    const set = {name:"Panel films",panel:panel.id,outputs:[{kind:"gerber",options:{readme:false}}]};
    const mark = [JSON.stringify(["source-hole","pad"]),0];
    const input = Uint8Array.of(13,46,77);
    const provenance = [{files:[{name:"original.PcbDoc",bytes:input}],
      drillDrawings:[{documentId:board.id,size:1.27,marks:[mark]}]}];
    const drill = out => sha(out,/\.GD1$/);
    const generate = opts => R.generate(p,set,opts);
    const release = opts => R.release(p,set,{...opts,preflight:{checks:[]},force:true});
    for (const run of [generate,release]) {
      const opts = {date,provenance}, cache = R.createCache();
      const first = await run({...opts,cache});
      mark[1] = 1;
      input[0] = 91;
      const changed = await run({...opts,cache}), fresh = await run(opts);
      assert.notEqual(drill(first),drill(fresh),"the changed tool symbol must affect the film");
      assert.equal(drill(changed),drill(fresh),"the same release cache must see the updated source");
      assert.deepEqual([...input],[91,46,77],"the original source bytes stay with the caller");
      mark[1] = 0;
    }
    const ordinary = {date,provenance:[],cache:R.createCache()};
    await generate(ordinary);
    assert.equal((await generate(ordinary)).stats.cached,1,"empty provenance keeps the ordinary output cache");

    const restoreWorker = require("../support/import-worker.cjs")({client:true});
    const {document,AtriumNavHost,AtriumImportReports} = globalThis;
    let hasIndexes = false, loaded = [], reads = 0;
    try {
      const folder = {hasImportIndexes:() => hasIndexes, async ensureImportReports() {
        if (hasIndexes) { loaded = provenance; reads++; }
      }};
      globalThis.document = {baseURI:"file:///application/index.html"};
      globalThis.AtriumNavHost = {project:() => p,folderProject:() => folder};
      globalThis.AtriumImportReports = {provenance:() => loaded};
      const opts = {date,provenance:[],cache:R.createCache()};
      assert.equal((await generate(opts)).stats.worker,1,"the folder runs through the translator client");
      assert.equal((await generate(opts)).stats.cached,1,"a folder without retained sources still uses the cache");
      hasIndexes = true;
      const first = await generate(opts);
      mark[1] = 1;
      const changed = await generate(opts), fresh = await generate({...opts,cache:R.createCache()});
      assert.equal(reads,3,"each indexed preview reads the retained input through the folder session");
      assert.notEqual(drill(first),drill(fresh));
      assert.equal(drill(changed),drill(fresh),"a translated release discovers current folder sources even with empty options");
      const unrelated = {name:"Order notes",panel:panel.id,outputs:[{kind:"notes"}]};
      await R.generate(p,unrelated,opts);
      assert.equal((await R.generate(p,unrelated,opts)).stats.cached,1,"an output that does not use retained sources still uses the cache");
    } finally {
      Object.assign(globalThis,{document,AtriumNavHost,AtriumImportReports});
      restoreWorker();
    }
  }

  // ---- Preview keys sign only the output's inputs, and include the effective selection --
  {
    const p = project(), board = p.documents.find(d => d.kind === "pcb"), sheet = p.documents.find(d => d.kind === "schematic");
    const other = Atrium.clone(board);
    other.id = "other-board";
    for (const item of other.items) if (item.kind === "part") item.value = "Secondary placement";
    p.documents.push(other);
    const cache = R.createCache(), outputJob = (kind,options,fields) => ({name:"Cache proof",folder:"",outputs:[{kind,options}],...fields});
    const job = d => outputJob("bom",{source:"pcb",format:"csv"},{board:d.id});
    const a = await R.generate(p,job(board),{date,cache}), b = await R.generate(p,job(other),{date,cache});
    assert.notEqual(sha(a,/BOM\.csv$/),sha(b,/BOM\.csv$/),"same board names do not identify the BOM");
    assert.match(text(output(b,/BOM\.csv$/).data),/Secondary placement/);
    const panel = AtriumPanel.create(p,{board:board.id,rows:1,cols:2,spacing:3,cells:{"0,1":{board:other.id}}});
    p.documents.push(panel);
    const panelJob = outputJob("gerber",{readme:false},{panel:panel.id});
    const oldPanel = await R.generate(p,panelJob,{date,cache});
    other.items.push({id:"second-board-trace",kind:"track",width:.2,layer:"Top",points:[[2,3],[7,3]],net:"EXTRA"});
    const changedPanel = await R.generate(p,panelJob,{date,cache});
    assert.notEqual(sha(oldPanel,/\.GTL$/),sha(changedPanel,/\.GTL$/),"the second board contributes panel copper");
    assert.equal(sha(changedPanel,/\.GTL$/),sha(await R.generate(p,panelJob,{date}),/\.GTL$/));
    const single = outputJob("gerber",{drill:false,readme:false},{board:board.id});
    const later = new Date(+date + 5000);
    const initial = await R.generate(p,single,{date,cache}), next = await R.generate(p,single,{date:later,cache});
    assert.notEqual(sha(initial,/\.GTL$/),sha(next,/\.GTL$/),"Gerber creation time includes seconds");
    assert.equal(sha(next,/\.GTL$/),sha(await R.generate(p,single,{date:later}),/\.GTL$/));
    const namedJob = name => ({...single,name,outputs:[{kind:"gerber",options:{profileOnly:true,pack:"{job}-{folder}.zip"}}]});
    const named = await R.generate(p,namedJob("One"),{date,cache}), renamed = await R.generate(p,namedJob("Two"),{date,cache});
    assert.notEqual(named.files[0].name,renamed.files[0].name,"file templates read the job even when the output folder does not");
    assert.match(renamed.files[0].name,/Two-\.zip$/);

    let fieldsRead = 0;
    for (let n=0;n<1000;n++) sheet.items.push({kind:"netlabel",id:"unrelated-" + n,x:n,y:0,
      get text() { fieldsRead++; return "Unrelated geometry"; }});
    const notes = outputJob("notes",{}, {board:board.id});
    const first = await R.generate(p,notes,{date,cache});
    fieldsRead = 0;
    const warmed = await R.generate(p,notes,{date,cache,worker:{for() {throw Error("A cache hit started a worker.");}}});
    assert.equal(fieldsRead,0,"a board-only cache hit leaves schematic row bodies unread");
    assert.equal(warmed.stats.cached,1);
    assert.equal(sha(warmed,/Notes\.txt$/),sha(first,/Notes\.txt$/));
  }

  // ---- A pinned variant is part of every assembly and ODB++ cache entry --
  {
    const p = project(), pnp = p.documents.find(d => d.kind === "pcb").items.find(i => i.kind === "part" && i.ref === "R1");
    const lite = AtriumVariants.create(p,{name:"Lite"});
    AtriumVariants.setParts(p,lite.id,[pnp.link || pnp.id],{fitted:false});
    const set = {name:"Pinned variants",folder:"",outputs:[null,lite.id].flatMap((variant,i) =>
      ["pnp","assembly","odb"].map(kind => ({id:kind+"-"+i,kind,folder:i ? "Lite" : "Base",options:{variant}})))};
    const prefs = globalThis.AtriumPrefs, cache = R.createCache(), opts = {date,cache,force:true};
    globalThis.AtriumPrefs = {get:k => k === "butter.odb" ? true : prefs?.get(k)};
    try {
      const pair = await R.generate(p,set,opts);
      assert.match(text(output(pair,/Base\/Pick Place/).data),/"R1"/);
      assert.doesNotMatch(text(output(pair,/Lite\/Pick Place/).data),/"R1"/);
      assert.match(text(output(pair,/Lite\/.*Assembly-Top\.svg$/).data),/Variant Lite/);
      assert.notEqual(sha(pair,/Base\/.*\.tgz$/),sha(pair,/Lite\/.*\.tgz$/));
      assert.equal(pair.stats.cached,0);
      const released = await R.release(p,set,opts);
      assert.equal(released.stats.cached,6,"release reuses all six correct pinned outputs from its preview");
      for (const file of pair.files) {
        const packaged = released.files.find(f => f.name.endsWith("/" + file.name));
        assert.equal(J.sha256(packaged.data),J.sha256(file.data),file.name);
      }
      const sync = R.releaseSync(p,set,opts);
      assert.deepEqual(sync.files.map(f => [f.name,J.sha256(f.data)]),released.files.map(f => [f.name,J.sha256(f.data)]));
    } finally { globalThis.AtriumPrefs = prefs; }
  }

  // ---- Writes during an asynchronous output cannot enter the release cache --
  {
    const p = project(), cache = R.createCache(), previous = globalThis.AtriumNavHost;
    let stamp = 0;
    globalThis.AtriumNavHost = {project:()=>p,authoredRevision:()=>stamp};
    try {
      const set = {name:"Guarded output",outputs:[{kind:"pnp"}]};
      const worker = {for:() => ({async run() {
        stamp++;
        return {files:[{name:"Stale.csv",data:"do not publish"}]};
      }, stop() { assert.fail("Release must leave the supplied worker running."); }})};
      await assert.rejects(R.generate(p,set,{date,cache,worker}),/design changed/);
      assert.equal(cache.size,0);
    } finally { globalThis.AtriumNavHost = previous; }
  }

  // Derived repours can advance the view revision. Authored edits or replacement
  // while settling cannot produce files under the invocation's earlier revision.
  {
    const {parseGerber} = require("./gerber-compare.cjs");
    const set = {name:"While settling",folder:"{rev}",outputs:[{kind:"gerber",options:{profileOnly:true,origin:"absolute"}}]};
    const host = globalThis.AtriumNavHost, pour = globalThis.AtriumPolygonPour;
    let active, view = 0, authored = 0, settled, starts;
    globalThis.AtriumNavHost = {project:() => active, authoredRevision:() => authored, revision:() => view};
    globalThis.AtriumPolygonPour = {...pour, settle:() => new Promise(resolve => { settled = resolve; })};
    const verify = (result, revision, extent) => {
      assert.equal((result.report || result.record).revision,revision);
      const file = output(result,/\.GM1$/);
      assert.ok(file.name.includes(revision));
      assert.deepEqual(parseGerber(text(file.data)).bbox,[-2.05,-22.05,extent,1.05]);
      return file.data;
    };
    try {
      for (const run of [R.generate,R.release]) {
        const p = Atrium.project("Synthetic proof");
        const board = p.documents.find(d => d.kind === "pcb");
        board.outline = [[-2,-1],[21,-1],[21,22],[-2,22]];
        p.revision = "early"; active = p; starts = 0;
        const cache = R.createCache(), opts = {date,cache,preflight:{checks:[]},
          progress:e => { if (e.phase === "start") starts++; }};
        const current = run(p,set,opts);
        view++;
        settled();
        const original = verify(await current,"early",21.05);
        assert.equal(starts,1);
        assert.equal(cache.size,1);
        const warm = run(p,set,opts);
        settled();
        const cached = await warm;
        assert.deepEqual(verify(cached,"early",21.05),original);
        assert.equal(cached.stats.cached,1);

        starts = 0;
        const edited = run(p,set,opts);
        board.outline[1][0] = board.outline[2][0] = 25;
        p.revision = "newest";
        authored++;
        settled();
        await assert.rejects(edited,/design changed/);
        assert.equal(starts,0);
        assert.equal(cache.size,1);

        const retried = run(p,set,opts);
        settled();
        verify(await retried,"newest",25.05);
        assert.equal(starts,1);
        assert.equal(cache.size,2);

        cache.clear(); starts = 0;
        const stale = run(p,set,opts);
        active = Atrium.project("Replacement");
        settled();
        await assert.rejects(stale,/design changed/);
        assert.equal(starts,0);
        assert.equal(cache.size,0);
      }
      globalThis.AtriumPolygonPour = {...pour, settle(_board, _defs, {signal}) {
        return new Promise((_resolve, reject) => signal.addEventListener("abort",
          () => reject(Object.assign(Error("Cancelled."), {name:"AbortError"})), {once:true}));
      }};
      for (const run of [R.generate,R.release]) {
        const ac = new AbortController(), cache = R.createCache();
        const pending = run(active,set,{date,cache,signal:ac.signal,preflight:{checks:[]},
          progress() { assert.fail("Cancelled settlement must not start an output."); }});
        ac.abort();
        await assert.rejects(pending,{name:"AbortError",message:"Cancelled."});
        assert.equal(cache.size,0);
      }
    } finally { globalThis.AtriumNavHost = host; globalThis.AtriumPolygonPour = pour; }
  }

  // ---- Per-variant release: one package per variant ---------------------------------
  {
    const p = project(), lite = AtriumVariants.create(p, {name: "Lite"});
    const r1 = p.documents.find(d => d.kind === "schematic").items.find(i => i.kind === "part" && /^R/.test(i.ref));
    AtriumVariants.setParts(p, lite.id, [r1.link || r1.id], {fitted: false});
    const cache = R.createCache();
    const out = await R.release(p, {name: "Assy", outputs: [{kind: "gerber"}, {kind: "bom", options: {format: "csv"}}, {kind: "pnp"}]}, {date, variants: "all", cache});
    assert.deepEqual(out.packages.map(x => x.name), ["Sensor interface-1-Base-2026-11-19", "Sensor interface-1-Lite-2026-11-19"]);
    const pick = (pkg, re) => out.files.find(f => f.name.startsWith(pkg + "/") && re.test(f.name));
    const [b, l] = out.packages.map(x => x.name);
    assert.equal(J.sha256(pick(b, /\.GTL$/).data), J.sha256(pick(l, /\.GTL$/).data), "copper is the same in every variant");
    assert.ok(out.stats.cached >= 1, "the Lite package reuses the base Gerbers");
    const onlyGerber = {name:"Fabrication",folder:"",outputs:[{kind:"gerber"}]};
    const baseFab = await R.generate(p,onlyGerber,{date,variant:null}), liteFab = await R.generate(p,onlyGerber,{date,variant:lite.id});
    const fingerprints = run => run.files.map(f => [f.name,J.sha256(f.data)]);
    assert.deepEqual(fingerprints(baseFab),fingerprints(liteFab),"fit-only variants do not alter even uncached fabrication notes");
    assert.ok(!text(pick(l, /Pick Place/).data).includes('"' + r1.ref + '"'), "the not-fitted part leaves the Lite pick and place");
    assert.ok(text(pick(b, /Pick Place/).data).includes('"' + r1.ref + '"'));
    assert.equal(JSON.parse(text(pick(l, /release\.json$/).data)).variant.name, "Lite");
    const vc = R.preflight(p, {name: "x", outputs: [{kind: "bom"}]}, {variants: "all"}).checks.find(c => c.id === "variants");
    assert.equal(vc.status, "pass", JSON.stringify(vc));
    lite.parts.ghost = {fitted: false};
    assert.equal(R.preflight(p, {name: "x", outputs: [{kind: "bom"}]}, {variants: "all"}).checks.find(c => c.id === "variants").status, "warn", "stale variant entries warn");
  }

  // ---- Compare two releases ------------------------------------------------------
  {
    const {p, rec} = first, before = JSON.parse(JSON.stringify(p));
    const c1 = p.documents.find(d => d.kind === "schematic").items.find(i => i.kind === "part" && /^C/.test(i.ref));
    c1.value = "22uF";
    for (const d of p.documents) for (const i of d.items) if (i.kind === "part" && i.ref === c1.ref) i.value = "22uF";
    p.revision = "2";
    const second = await R.release(p, "JLCPCB order", {date: new Date(Date.UTC(2026, 10, 20)), overrides: [{check: "drc", reason: "Still fine"}], force: true});
    const cmp = R.compare(rec, second.record, {before, after: p});
    assert.ok(cmp.files.changed.some(f => /BOM-/.test(f.path)), JSON.stringify(cmp.files));
    assert.ok([...cmp.files.same, ...cmp.files.datesOnly].some(f => /Gerber\.zip$/.test(f)), "the Gerber zip only differs in its dates: " + JSON.stringify(cmp.files));
    assert.ok(!cmp.files.changed.some(f => /Gerber|CPL-/.test(f.path)), "copper and placement did not change");
    assert.ok(cmp.notes.some(n => /only in dates/.test(n)));
    assert.equal(cmp.files.added.length + cmp.files.removed.length, 0, JSON.stringify(cmp.files));
    assert.deepEqual(cmp.bom.changed.map(c => [c.ref, c.fields.join()]), [[c1.ref, "comment"]]);
    assert.equal(cmp.design, null, "no diff engine loaded here");
    assert.ok(cmp.notes.some(n => /diff engine/.test(n)));
  }

  // ---- Synchronous release (MCP) makes the same package; groups; BOM cost ---------------
  {
    const p = project(), opts = {date, overrides: [{check: "bom", reason: "starter parts"}]};
    const a = await R.release(p, "Generic fab + assembly", opts), b = R.releaseSync(p, "Generic fab + assembly", opts);
    assert.deepEqual(b.files.map(f => f.name), a.files.map(f => f.name));
    assert.deepEqual(b.files.map(f => J.sha256(f.data)), a.files.map(f => J.sha256(f.data)), "release and releaseSync write the same bytes");
    for (const k of J.ORDER) assert.equal(J.GROUPS.filter(g => g.kinds.includes(k)).length, 1, k + " is in exactly one group");
    p.documents.find(d => d.kind === "schematic").items.find(i => i.kind === "part" && i.ref === "R1").parameters = {"Unit Price": "$0.012"};
    for (const d of p.documents) for (const i of d.items) if (i.kind === "part" && i.ref === "R1") i.parameters = {...(i.parameters || {}), "Unit Price": "$0.012"};
    const cost = J.run(p, {name: "C", folder: "", outputs: [{kind: "bomcost", options: {boards: 10, format: "csv", currency: "USD"}}]}, {date});
    const row = cost.report.outputs[0], csv = text(cost.files[0].data);
    assert.equal(cost.files[0].name, "Reports/Sensor interface BOM cost.csv");
    assert.match(row.summary, /^total 0\.1200 USD for 10 boards, 1\/\d+ lines priced$/, row.summary);
    assert.ok(row.warnings.some(w => /no unit price/.test(w)));
    assert.match(csv, /^Designators,Comment,MPN,Per board,Quantity,Unit price \(USD\),Extended \(USD\)\r\n/);
  }

  // ---- The Release client and worker share one ordered module inventory ------------
  {
    assert.equal(R.WORKER_GLOBALS, globalThis.AtriumReleaseWorkerModules);
    const workerDir = path.dirname(require.resolve("../../app/workers/release-worker.js"));
    const manifest = new Map(R.WORKER_GLOBALS);
    assert.equal(manifest.size, R.WORKER_GLOBALS.length);
    assert.equal(new Set(manifest.values()).size, manifest.size);
    assert.equal(manifest.get("AtriumFabPresetsJLCPCB"), "../fab-presets/jlcpcb.js");
    const profiles = [...manifest.keys()].filter(name => /^AtriumFabPresets/.test(name) || name === "AtriumFabProfiles");
    assert.deepEqual(profiles, ["AtriumFabPresets", "AtriumFabPresetsJLCPCB", "AtriumFabProfiles"]);
    for (const [, f] of R.WORKER_GLOBALS) assert.ok(fs.existsSync(path.resolve(workerDir, f)), f);
  }

  // ---- The DFM gate uses the selected Gerber outputs' mask openings ------------------
  {
    require("../../app/pcb/viastack.js");
    require("../../app/checks/dfm.js");
    const {parseGerber} = require("./gerber-compare.cjs");
    const p = Atrium.project("Mask policy"), board = Atrium.sheet("pcb", "Board");
    board.fabPreset = {id: "jlcpcb-2l"};
    board.outline = [[0, 0], [26, 0], [26, 24], [0, 24]];
    const via = {id:"via", kind:"via", layer:"Multi", fromLayer:"Top", toLayer:"Bottom", x:8, y:10,
      diameter:.7, drill:.3, net:"SIG", tent:{top:false, bottom:true}};
    board.items = [via, ...["Silk", "Bottom silk"].map((layer, i) => ({
      id:i ? "bottom" : "top", kind:"graphic", width:.16, layer, points:[[7.3, 10.62], [8.7, 10.62]]
    }))];
    p.documents = [board];
    const film = (label, maskExpansion, opts = {}) => ({label, folder:label, kind:"gerber", options:{
      maskExpansion, units:"mm", origin:"absolute", overrideExpansions:true, drill:false, readme:false, ...opts
    }});
    const job = (...outputs) => ({name:"Mask jobs", board:board.id, folder:"", outputs,
      gates:{drc:false, erc:false, bom:false, variants:false, placeholders:false, git:false}});
    const gateOf = set => R.preflight(p, set).checks.find(row => row.id === "dfm");
    const standalone = () => AtriumDFM.headless({document_id:board.id, checks:["silkPad"]}, {project:() => p}).issues;
    const readFilm = (release, ext) => parseGerber(text(output(release, new RegExp("\\." + ext + "$")).data));
    const small = film("Small", .03), large = film("Large", .26);
    assert.equal(gateOf(job(small)).status, "pass");
    assert.equal(standalone().length, 0);
    const released = R.releaseSync(p, job(large), {date});
    const gate = gateOf(job(large)), manifest = released.packages[0].manifest.gates.find(row => row.id === "dfm");
    assert.equal(manifest.status, "warn");
    assert.equal(manifest.summary, gate.summary);
    assert.deepEqual(gate.items.map(i => i.target.id), ["top"]);
    assert.match(gate.items[0].text, /overlaps the mask opening/);
    const [mask] = readFilm(released, "GTS").flashes, [stroke] = readFilm(released, "GTO").shapes;
    assert.equal(mask.ap.params[0], 1.22);
    assert.ok(Math.abs(Math.abs(mask.y - stroke.y1) - mask.shapes[0].r - stroke.r + .07) < 1e-9);
    assert.equal(readFilm(R.releaseSync(p, job(small), {date}), "GTS").flashes[0].ap.params[0], .76);

    const multiple = gateOf(job(small, large, film("Inches", .26, {units:"in"}),
      {...film("Disabled", .26), enabled:false}, film("No top mask", .26, {layers:{GTS:false}}),
      film("No top legend", .26, {layers:{GTO:false}}), film("Outline", .26, {profileOnly:true})));
    assert.equal(multiple.items.length, 1, "same physical overlap yields one row across outputs");
    assert.match(multiple.items[0].text, /Gerber outputs: Large, Inches\.$/);

    via.maskExpansion = .26;
    assert.equal(standalone()[0].id, "top");
    assert.match(gateOf(job(small)).items[0].text, /overlaps the mask opening/);
    delete via.maskExpansion;
    delete via.tent;
    assert.equal(gateOf(job(small)).status, "pass", "the job's default tents inherited vias");
    assert.deepEqual(gateOf(job(film("Opened", .26, {tentVias:false}))).items.map(i => i.target.id), ["top", "bottom"]);
    via.ipc4761 = "I";
    via.ipcSides = "top";
    const opened = film("IPC", .26);
    assert.deepEqual(gateOf(job(opened)).items.map(i => i.target.id), ["bottom"]);
    assert.deepEqual(readFilm(R.releaseSync(p, job(opened), {date}), "GTS").flashes, []);
    delete via.ipc4761;
    delete via.ipcSides;
    for (const silk of board.items.slice(1)) for (const point of silk.points) point[1] = 10;
    const scope = (kind, value) => AtriumDesignQueryRecord.selector(kind, value);
    AtriumRules.store(board, p, AtriumRules.normalize({list:[
      {id:"top", type:"solderMask", name:"Top tent", enabled:true, priority:1, scope:scope("layer", "Top"), expansion:.04, tentTop:true},
      {id:"fallback", type:"solderMask", name:"Open fallback", enabled:true, priority:2, scope:scope("all"), expansion:.02, tentBottom:false}
    ]}));
    assert.deepEqual(standalone().map(i => i.id), ["bottom"]);
    for (const units of ["mm", "in"]) {
      const scoped = job(film("Scoped", .03, {overrideExpansions:false, units}));
      assert.deepEqual(gateOf(scoped).items.map(i => i.target.id), ["bottom"]);
      const run = R.releaseSync(p, scoped, {date});
      assert.deepEqual(readFilm(run, "GTS").flashes, []);
      const [bottom] = readFilm(run, "GBS").flashes;
      assert.ok(Math.abs(bottom.shapes[0].r * 2 - .74) < .000026, units + " bottom face uses the fallback's 0.02 mm expansion");
    }

    // The two faces of a through pad use their own applicable rules too.
    board.items[0] = {id:"pad", kind:"pad", number:"1", layer:"Multi", shape:"round", x:8, y:10, w:1, h:1, drill:.4, net:"SIG"};
    AtriumRules.store(board, p, AtriumRules.normalize({list:[
      {id:"top", type:"solderMask", name:"Top expansion", enabled:true, priority:1, scope:scope("layer", "Top"), expansion:.05},
      {id:"bottom", type:"solderMask", name:"Bottom expansion", enabled:true, priority:2, scope:scope("layer", "Bottom"), expansion:.20}
    ]}));
    const scopedPad = R.releaseSync(p, job(film("Through pad", .03, {overrideExpansions:false})), {date});
    assert.equal(readFilm(scopedPad, "GTS").flashes[0].ap.params[0], 1.1);
    assert.equal(readFilm(scopedPad, "GBS").flashes[0].ap.params[0], 1.4);

    // A stroke at the corner is inside the plotted square, outside a rounded radius offset.
    board.items = [
      {id:"land", kind:"pad", number:"1", layer:"Top", shape:"rect", x:10, y:10, w:1, h:1, net:"SIG"},
      {id:"legend", kind:"graphic", layer:"Silk", width:.16, points:[[11.19, 11.19], [11.3, 11.19]]}
    ];
    const corner = job(film("Corner", .7));
    assert.deepEqual(gateOf(corner).items.map(i => i.target.id), ["legend"]);
    const square = readFilm(R.releaseSync(p, corner, {date}), "GTS").flashes[0];
    assert.deepEqual(square.ap.params, [2.4, 2.4]);
    assert.equal(gateOf(job(film("Smaller corner", .1))).status, "pass");

    // A rotated secondary board contributes Gerber artwork and targets its own document.
    const primary = Atrium.sheet("pcb", "Primary");
    primary.outline = board.outline;
    primary.fabPreset = board.fabPreset;
    p.documents.unshift(primary);
    board.items = [via, {id:"secondary-legend", kind:"graphic", width:.16, layer:"Silk", points:[[7.3, 10.62], [8.7, 10.62]]}];
    via.tent = {top:false, bottom:true};
    const panel = AtriumPanel.create(p, {board:primary.id, rows:1, cols:2, alternate:"cols", separation:"vscore", cells:{"0,1":{board:board.id}}});
    p.documents.push(panel);
    const panelJob = output => ({...job(output), board:undefined, panel:panel.id});
    const secondary = gateOf(panelJob(large)).items;
    assert.deepEqual(secondary.map(i => [i.target.doc, i.target.id]), [[board.id, "secondary-legend"]]);
    assert.equal(gateOf(panelJob(small)).status, "pass");
  }

  // ---- Gerber thumbnail (DOM-free part of release-preview.js) ------------------------
  {
    const out = J.run(project(), {name: "G", folder: "", outputs: [{kind: "gerber"}]}, {date});
    const gtl = text(out.files.find(f => /\.GTL$/.test(f.name)).data), svg = AtriumReleasePreview.gerberSVG(gtl);
    assert.match(svg, /^<svg [^>]*viewBox="[-\d. ]+"/); assert.ok((svg.match(/<(path|circle|rect)/g) || []).length >= 10, "draws the pads and tracks, not just one shape");
    assert.ok(!/[<>"']\s*on\w+=|<script/i.test(svg), "no script in the thumbnail");
    assert.equal(AtriumReleasePreview.gerberSVG("not gerber"), "");
    const rows = AtriumReleasePreview.csvRows('a,"b,c",d\r\n1,"2 ""x""",3\r\n', 5);
    assert.deepEqual(rows, [["a", "b,c", "d"], ["1", '2 "x"', "3"]]);
  }
  console.log("PASS release: names, migration, vendor bundles, pre-flight + overrides, manifest, zip, cache, variants, compare, worker list, thumbnails");
})();
