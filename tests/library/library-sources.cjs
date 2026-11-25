"use strict";
// Folder libraries and KiCad library import (app/library/library-sources.js, app/library/library-import-kicad.js):
// KiCad symbols paired with the footprints their Footprint field names, inside the chosen files only;
// derived symbols across a KiCad 10 .kicad_symdir; 3D model references; File › Open of library files;
// the incremental folder index (an edit re-reads only that file; a touched file with the same content is
// hashed, not parsed); stub rows materialised on demand; Altium pairs and Waffle component files in a
// folder; saving into a writable folder; a fuzz pass over malformed input.
// Fixtures: tests/fixtures/kicad (hand-written, no KiCad library files).
const assert = require("node:assert/strict"), fs = require("node:fs");
for (const m of ["vendor/cfb.min", "model", "parts", "sch-objects", "sch-import", "altium-rules", "pcb-pours", "pcb-import", "source-file", "io", "library-import-altium",
  "sexpr", "import-kicad", "catalogue", "component-families", "library-store", "library-panel", "library-import-kicad", "library-sources", "zip"]) require(require("../support/app-source-paths.cjs").appFile(m));
const A = Atrium, K = AtriumLibraryImportKiCad, S = AtriumLibrarySources, L = AtriumLibrary;
const {appFile} = require("../support/app-source-paths.cjs");
const dir = __dirname + "/../fixtures/kicad/";
const FILES = ["Lab_Amp.kicad_sym", "Lab_Package.pretty/SOIC-8_Test.kicad_mod", "Lab_Package.pretty/R_0603_Test.kicad_mod", "Lab_Package.pretty/SOT-223_Test.kicad_mod",
  "Lab_Package.pretty/TestPad_Test.kicad_mod", "Legacy.pretty/DIP-4_Legacy.kicad_mod", "Lab_Logic.kicad_symdir/BUF_Test.kicad_sym", "Lab_Logic.kicad_symdir/BUF_Test_Alt.kicad_sym"];
const text = p => fs.readFileSync(dir + p, "utf8");
const valid = library => A.validate({format: "atrium", version: 1, name: "x", library: JSON.parse(JSON.stringify(library)), documents: [A.sheet("schematic", "s")]});
const run = async () => {
  {
    const files = FILES.map(p => ({name: p.split("/").pop(), path: p, sha256: S.hid(p), text: text(p)}));
    const {library, report} = K.pair(files);
    const by = n => library.find(d => d.name === n);
    assert.ok(valid(library), "every component validates");
    const opa = by("OPA_DUAL");
    assert.deepEqual([opa.symbol.parts, opa.symbol.pins.length, opa.footprint.pads.length, opa.footprint.name], [3, 8, 8, "SOIC-8_Test"]);
    assert.equal(opa.state, "draft");
    assert.deepEqual([opa.source.kind, opa.source.entry, opa.source.footprint.kind, opa.source.footprint.entry], ["kicad-symbol", "Lab_Amp:OPA_DUAL", "kicad-footprint", "Lab_Package:SOIC-8_Test"]);
    assert.equal(opa.category, "Lab Amp");
    assert.equal(opa.parameters.DATASHEET, "https://example.org/opa_dual.pdf");
    assert.equal(opa.parameters.Supply, "1.8-5.5 V");
    assert.equal(opa.parameters.Keywords, "dual opamp test");
    assert.deepEqual(opa.footprint.model3d, {file: "${KICAD8_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8_Test.step", offset: [0, 0, 0], rotation: [0, 0, 0], source: "kicad"});
    assert.ok(opa.footprint.shapes.some(s => s.layer === "Silk"), "silk lines kept");
    // Pins equal pads by number: the op-amp maps fully; the SOT-223 tab is reported, no pin map is invented.
    assert.ok(!AtriumLibraryStore.health([opa]).issues.some(x => /unmapped/.test(x.code)));
    assert.deepEqual(report.mismatches, [{name: "LDO_Test", noPad: [], noPin: ["4"]}]);
    // A derived symbol draws its parent's pins; its own footprint is not among the chosen files.
    assert.equal(by("OPA_DUAL_DFN").symbol.pins.length, 8);
    assert.deepEqual(report.unmatched, [{symbol: "OPA_DUAL_DFN", footprint: "Lab_Package:DFN-8_NotSelected"}]);
    // KiCad 10: one file per symbol in Lab_Logic.kicad_symdir, the parent in a sibling file.
    assert.equal(by("BUF_Test_Alt").symbol.pins.length, 4);
    assert.equal(by("BUF_Test_Alt").category, "Lab Logic");
    // KiCad 5 module form: model offset in inches (at) becomes mm; through-hole pads.
    const dip = by("BUF_Test").footprint;
    assert.deepEqual(dip.model3d.offset, [3.81, 0, 0]);
    assert.ok(dip.pads.every(p => p.drill === .8 && p.layer === "Multi"));
    assert.equal(report.power, 1, "power symbols are Waffle power ports, not components");
    assert.ok(!by("GND_Test"));
    assert.deepEqual(report.unused.map(u => u.footprint), ["TestPad_Test"]);
    assert.deepEqual([report.paired, report.symbolOnly, report.footprintOnly, report.components, report.derived], [5, 1, 1, 7, 2]);
    // A re-import of the same files is nothing new.
    const again = K.pair(files, {existing: library});
    assert.equal(again.library.length, 0); assert.equal(again.report.skipped, 7);
    console.log("PASS KiCad symbols + footprints: paired inside the chosen files, derived symbols (also across a .kicad_symdir), 3D references, mismatches, power symbols skipped");
  }
  {
    // File › Open with library files only: one paired library and the report as notes (sexpr.js importerFor).
    const set = ["Lab_Amp.kicad_sym", "Lab_Package.pretty/SOIC-8_Test.kicad_mod"].map(p => ({name: p.split("/").pop(), bytes: new TextEncoder().encode(text(p))}));
    const results = AtriumImportFormats.readSet(set);
    assert.equal(results[0].library.length, 4);
    assert.equal(results[1].library.length, 0);
    assert.ok(results[0].notes.some(n => /inside the selected files only/.test(n)));
    assert.equal(results[0].library.find(d => d.name === "OPA_DUAL").footprint.pads.length, 8);
    assert.match(results[0].library[0].source.sha256, /^[0-9a-f]{64}$/);
    console.log("PASS File › Open: .kicad_sym and .kicad_mod files become one paired library with the pairing notes");
  }
  {
    // Incremental index: only changed files are read; equal content is hashed, not parsed again.
    const map = new Map(FILES.map((p, i) => [p, {data: text(p), mtime: 1000 + i}]));
    const prov = S.providers.memory(map), folder = {id: "f-test", name: "Lab"};
    const first = await S.refresh(folder, prov, {});
    assert.deepEqual([first.stats.read, first.stats.parsed, prov.reads], [8, 8, 8]);
    assert.equal(first.library.defs.length, 7);
    let r = await S.refresh(folder, prov, {index: first.index});
    assert.deepEqual([r.stats.read, r.stats.parsed, r.stats.unchanged, prov.reads], [0, 0, 8, 8], "an unchanged folder reads nothing");
    // Edit one footprint: that file alone is read and parsed.
    const path = "Lab_Package.pretty/SOT-223_Test.kicad_mod";
    map.set(path, {data: text(path).replace('(pad "4" smd rect (at 3.15 0) (size 2 3.8)', '(pad "4" smd rect (at 3.15 0) (size 2.2 3.8)'), mtime: 5000});
    const before = prov.reads;
    const parsedOnce = [];
    r = await S.refresh(folder, {list: () => prov.list(), read: p => { parsedOnce.push(p); return prov.read(p); }}, {index: r.index});
    assert.deepEqual(parsedOnce, [path], "an edit to one file re-reads only that file");
    assert.deepEqual([r.stats.read, r.stats.parsed, prov.reads - before], [1, 1, 1]);
    // Touch a file without changing it: read and hashed, not parsed.
    map.set("Lab_Amp.kicad_sym", {data: text("Lab_Amp.kicad_sym"), mtime: 9000});
    r = await S.refresh(folder, prov, {index: r.index});
    assert.deepEqual([r.stats.read, r.stats.parsed, r.stats.same], [1, 0, 1]);
    // Remove a file: its rows go; add one back.
    map.delete("Lab_Package.pretty/TestPad_Test.kicad_mod");
    r = await S.refresh(folder, prov, {index: r.index});
    assert.equal(r.stats.removed, 1); assert.equal(r.library.defs.length, 6);
    // Stable ids: the same entry has the same id after every scan.
    assert.equal(r.library.defs.find(d => d.name === "OPA_DUAL").id, first.library.defs.find(d => d.name === "OPA_DUAL").id);
    // Rows are stubs (pins and pads only); materialise reads the row's files and matches a direct import.
    const stub = r.library.defs.find(d => d.name === "BUF_Test_Alt");
    assert.ok(stub.stub && stub.symbol.shapes.length === 0);
    assert.deepEqual(S.needs(stub).sort(), ["Lab_Logic.kicad_symdir/BUF_Test.kicad_sym", "Lab_Logic.kicad_symdir/BUF_Test_Alt.kicad_sym", "Legacy.pretty/DIP-4_Legacy.kicad_mod"]);
    const files = new Map(); for (const p of S.needs(stub)) files.set(p, await prov.read(p));
    const indexStub = r.library.defs.find(d => d.name === "OPA_DUAL");
    assert.ok(AtriumCatalogue.matches(indexStub, "supply:1.8"), "arbitrary KiCad parameters are searchable before materialisation");
    const full = S.materialise(stub, files);
    assert.equal(full.id, stub.id); assert.equal(full.symbol.pins.length, 4); assert.equal(full.footprint.pads.length, 4); assert.ok(full.symbol.shapes.length > 0);
    assert.ok(L.validateDef(full).ok);
    console.log("PASS incremental index: unchanged folders read nothing, an edit re-reads one file, equal content is not parsed, stable ids, stubs materialise on demand");
  }

  {
    const amp = `(kicad_symbol_lib (version 20231120) (symbol "AMP"
      (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "AMP" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "Lib:SOIC-8" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "AMP_1_1"
        (pin passive line (at -2.54 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 2.54 0 180) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
    const fp = x => `(footprint "SOIC-8" (version 20221018) (pad "1" smd rect (at ${x} 0) (size 1 0.6) (layers "F.Cu" "F.Paste" "F.Mask")) (pad "2" smd rect (at ${-x} 0) (size 1 0.6) (layers "F.Cu" "F.Paste" "F.Mask")))`;
    const files = [
      {name: "Amp.kicad_sym", path: "symbols/Amp.kicad_sym", text: amp},
      {name: "SOIC-8.kicad_mod", path: "a/Lib.pretty/SOIC-8.kicad_mod", text: fp(1)},
      {name: "SOIC-8.kicad_mod", path: "b/Lib.pretty/SOIC-8.kicad_mod", text: fp(3)}];
    const map = new Map(files.map(f => [f.path, {data: f.text, mtime: 1}]));
    const folder = {id:"dup-pretty-hunt", name:"Dup"}, provider=S.providers.memory(map);
    const legacyPath=files[2].path;
    const {library: legacy}=await S.refresh(folder,S.providers.memory(new Map([[legacyPath,map.get(legacyPath)]])));
    const legacyStub=legacy.defs[0];
    const full=S.materialise(legacyStub,new Map([[legacyPath,await provider.read(legacyPath)]]),undefined,legacy);
    const linked=L.fromLibrary(legacy,full,A.project("Existing footprint"));
    const {library} = await S.refresh(folder, provider);
    const def = library.defs.find(d => d.name === "AMP");
    assert.equal(library.report.ambiguous.length, 1);
    assert.equal(def.footprint, undefined);
    assert.equal(library.defs.filter(d=>d.name==="SOIC-8"&&d.footprint).length,2);
    assert.equal(library.defs.find(d=>d.stub?.footprint===legacyPath).id,legacyStub.id);
    assert.equal(L.libraryStatus(linked,[library]).src.stub.footprint,legacyPath,
      "an existing library link still resolves to the same physical file");
    assert.equal(new Set(library.defs.map(d=>d.id)).size,library.defs.length);
    const second=files[2].path;
    map.set(second,{data:fp(1).replace('(version 20221018)','(version 20221018) (descr "Matching copy")'),mtime:2});
    const same=await S.refresh({id:"dup-pretty-hunt",name:"Dup"},S.providers.memory(map));
    assert.equal(same.library.report.ambiguous.length,0);
    assert.ok(same.library.defs.find(d=>d.name==="AMP").footprint);
  }

  {
    const notice = "KiCad libraries · CC-BY-SA 4.0 with KiCad-libraries-exception. Test notice.";
    const map = new Map(FILES.map(p => [(p.endsWith("kicad_mod") ? "footprints/" : "symbols/") + p, {data: text(p)}]));
    const provider = S.providers.memory(map), folder = {id: "kit", name: "Local installation"};
    async function read() {
      const lib = (await S.refresh(folder, provider)).library, stub = lib.defs.find(d => d.name === "OPA_DUAL");
      const files = new Map(); for (const path of S.needs(stub)) files.set(path, await provider.read(path));
      return S.materialise(stub, files, lib.attribution, lib);
    }
    provider.rootPath = "/usr/share/kicad";
    let part = await read();
    assert.match(part.source.attribution.sourceUrl, /kicad-symbols/);
    assert.deepEqual(part.source.footprint.attribution, {...L.kiCadCredit("footprints"), modified: true});
    provider.rootPath = undefined;
    map.set("symbols/LICENSE.md", {data: notice}); map.set("footprints/LICENSE.md", {data: "Other library terms"});
    part = await read();
    assert.equal(part.source.attribution.licenceText, notice);
    assert.equal(part.source.footprint.attribution, undefined, "a paired footprint from a separately licensed folder is not relabelled");
    const shared = L.readLibraryFile(L.libraryFile({defs: [part]}).text);
    assert.deepEqual(shared.defs[0].source, part.source);
    map.delete("symbols/LICENSE.md"); assert.equal((await read()).source.attribution, undefined);
    const project = {library: []}, input = FILES.map(path => ({
      name: path.split("/").pop(), path, data: Buffer.from(text(path)).toString("base64"),
      directory: path.endsWith(".kicad_sym") ? "/usr/share/kicad/symbols" : "/chosen/third-party"
    }));
    S.headless("library_import", {components: ["OPA_DUAL"]}, JSON.stringify(input), {mutable: () => project, touched() {}});
    assert.equal(project.library[0].source.attribution.credit, "KiCad library contributors");
    assert.equal(project.library[0].source.footprint.attribution, undefined);
    assert.ok(!JSON.stringify(project.library).includes("/usr/share/"));
    const over = {name: "LICENSE.md", size: S.LIMITS["library-notice"] + 1, arrayBuffer() { throw Error("Unexpected file read"); }};
    await assert.rejects(S.providers.fileList([over]).read(over.name), /too large/);
    console.log("PASS local installation, scoped notices, independent footprint credit, headless import and portable library export");
  }
  {
    // Status and update against a folder library: a project copy of a stub row is compared once it is read.
    const map = new Map(FILES.map(p => [p, {data: text(p), mtime: 1}])), prov = S.providers.memory(map), folder = {id: "f-status", name: "Lab"};
    let r = await S.refresh(folder, prov, {});
    const lib = r.library, stub = lib.defs.find(d => d.name === "R_Test");
    const p = A.project("P");
    const files = new Map(); for (const x of S.needs(stub)) files.set(x, await prov.read(x));
    const full = S.materialise(stub, files);
    const copy = L.addFromLibrary(lib, full, p);
    assert.equal(copy.libraryRef.library, lib.id);
    assert.equal(L.libraryStatus(copy, [lib], p).state, "current", "the indexed source revision matches before any comparison read");
    const legacy = A.clone(copy); delete legacy.libraryRef.folderRevision;
    assert.equal(L.libraryStatus(legacy, [lib], p).state, "current", "existing copies match using their recorded asset checksums");
    copy.parameters.NewField = "edited";
    assert.equal(L.libraryStatus(copy, [lib], p).state, "edited", "a project edit is visible before the source body is read");
    delete copy.parameters.NewField;
    lib.defs[lib.defs.indexOf(stub)] = full;
    assert.equal(L.libraryStatus(copy, [lib], p).state, "current");
    // The footprint changes on disk: after a rescan and read, the project copy has an update.
    map.set("Lab_Package.pretty/R_0603_Test.kicad_mod", {data: text("Lab_Package.pretty/R_0603_Test.kicad_mod").replace("(at -0.825 0) (size 0.8 0.95)", "(at -0.85 0) (size 0.8 0.95)"), mtime: 2});
    r = await S.refresh(folder, prov, {index: r.index});
    const next = r.library.defs.find(d => d.name === "R_Test"), f2 = new Map();
    for (const x of S.needs(next)) f2.set(x, await prov.read(x));
    assert.equal(L.libraryStatus(copy, [r.library], p).state, "update", "the changed land is detected in metadata");
    assert.throws(() => S.materialise(stub, f2, {}, lib), /changed after indexing/, "old index cannot publish newer geometry");
    r.library.defs[r.library.defs.indexOf(next)] = S.materialise(next, f2);
    assert.equal(L.libraryStatus(copy, [r.library], p).state, "update");
    console.log("PASS folder status from indexed revisions, legacy checksums, local edits and changed geometry; obsolete file bytes rejected");
  }
  {
    // Altium SchLib/PcbLib pairs and Waffle component files in one folder; saving writes one component file.
    const lab = n => new Uint8Array(fs.readFileSync(__dirname + "/../fixtures/library/" + n));
    const comp = JSON.parse(JSON.stringify(AtriumParts.catalogue.find(d => d.id === "std-r")));
    comp.id = "atr-1"; comp.name = "Lab resistor"; comp.rev = 2;
    const writes = new Map();
    const map = new Map([["alt/Lab.SchLib", {data: lab("Lab.SchLib"), mtime: 1}], ["alt/Lab.PcbLib", {data: lab("Lab.PcbLib"), mtime: 1}],
      ["components/lab-resistor-atr-1.json", {data: AtriumLibraryStore.serialise(comp), mtime: 1}],
      ["library.json", {data: JSON.stringify({format: "atrium-library-dir", formatVersion: "1.0", id: "lab-lib", name: "Lab library"}), mtime: 1}],
      ["notes/readme.txt", {data: "ignored", mtime: 1}], [".git/config", {data: "ignored", mtime: 1}]]);
    const prov = {...S.providers.memory(map), write: async (path, t) => { writes.set(path, t); map.set(path, {data: t, mtime: 99}); }};
    const folder = {id: "f-mixed", name: "Mixed", writable: true};
    const r = await S.refresh(folder, prov, {});
    assert.equal(r.stats.listed, 4, "only library files are listed (.git and other files are skipped)");
    assert.equal(r.library.id, "lab-lib", "library.json gives the library id");
    const opamp = r.library.defs.find(d => d.name === "LMV321");
    assert.ok(opamp.footprint && opamp.symbol, "a SchLib symbol pairs with its PcbLib footprint inside the folder");
    const files = new Map(); for (const x of S.needs(opamp)) files.set(x, await prov.read(x));
    const full = S.materialise(opamp, files);
    assert.equal(full.footprint.pads.length, 5); assert.equal(full.source.kind, "altium-schlib");
    const atr = r.library.defs.find(d => d.id === "atr-1");
    assert.equal(atr.rev, 2); assert.equal(atr.stub.hash, L.defHash(comp));
    const noBody = AtriumLibraryStore.health([opamp]);
    assert.deepEqual(noBody.issues.map(x => x.code), ["unread-geometry"]);
    assert.equal(AtriumLibraryStore.health([full]).issues.some(x => x.code === "unread-geometry"), false);
    // save(): only on request, into components/<slug>-<id>.json, rev +1 when the content changed.
    S.addFolder({...folder});
    const lib = (await S.scan(folder, {provider: prov})).library;
    const step = fs.readFileSync(__dirname + "/../fixtures/mcad/tray.step", "utf8");
    const project = A.project("Test", [{...comp, value: "22k",
      source: {kind:"kicad-symbol", file:"fixture.kicad_sym", attribution:{credit:"Fixture author"}},
      model3d: {file:"\\\\fixture\\authoring\\tray.step", stepText:step}}]);
    AtriumLibraryStore.hoistAll(project);
    const edited = project.library[0], original = JSON.stringify(project);
    const saved = await S.save(lib, edited, project);
    assert.deepEqual([saved.path, saved.rev, [...writes.keys()]], ["components/lab-resistor-atr-1.json", 3, ["components/lab-resistor-atr-1.json"]]);
    const bytes = writes.get(saved.path), row = JSON.parse(bytes);
    assert.equal(row.value, "22k");
    assert.deepEqual(row.model3d, {file:"tray.step", stepText:step});
    assert.deepEqual(row.source, edited.source);
    const latest = S.library(folder.id);
    assert.equal(latest.id, lib.id);
    const reopened = await S.load(latest, edited.id);
    assert.deepEqual(reopened.model3d, row.model3d);
    const unchanged = await S.save(latest, edited, project);
    assert.deepEqual(unchanged, {path:saved.path, rev:saved.rev, unchanged:true});
    assert.equal(writes.get(saved.path), bytes);
    assert.equal(JSON.stringify(project), original);
    map.set(saved.path, {data: JSON.stringify({...edited, rev: 4, name: "Changed elsewhere"}), mtime: 100});
    await assert.rejects(S.save(latest, {...edited, name: "Stale overwrite"}), /changed/);
    assert.equal(JSON.parse(map.get(saved.path).data).name, "Changed elsewhere");
    await S.removeFolder(folder.id);
    console.log("PASS mixed folder: Altium pairs, Waffle component files and library.json; only library files listed; save writes one file");
  }
  {
    const original = globalThis.AtriumIO;
    const bytes = new Map([["Chip.SchLib", {data: "1", mtime: 1}], ["A.PcbLib", {data: "a", mtime: 1}], ["B.PcbLib", {data: "b", mtime: 1}]]);
    let different = true;
    globalThis.AtriumIO = {read(name) {
      if (name.endsWith(".SchLib")) return {library: [{id: "u", name: "Chip", symbol: {pins: [], shapes: []}, footprintName: "QFN"}]};
      return {library: [{id: "package", name: "QFN", footprint: {name: "QFN", pads: [], shapes: [],
        bodies3d: [{kind: "body", model: "m"}], bodyModels: [{id: "m", file: "body.step", zlib: different && name === "B.PcbLib" ? "second" : "first"}]}}]};
    }};
    try {
      const first = await S.refresh({id: "bodies", name: "Models"}, S.providers.memory(bytes));
      assert.equal(first.library.report.ambiguous.length, 1);
      assert.equal(first.library.defs.filter(d => d.footprint?.model3d).length, 2);
      different = false;
      bytes.set("B.PcbLib", {data: "c", mtime: 2});
      const same = await S.refresh({id: "bodies", name: "Models"}, S.providers.memory(bytes), {index: first.index});
      assert.equal(same.library.report.paired, 1);
      assert.equal(same.library.report.ambiguous.length, 0);
    } finally { globalThis.AtriumIO = original; }
  }
  {
    const libraries = [], providers = [];
    for (let i = 0; i < 5; i++) {
      const folder = {id: "resident-" + i, name: "Folder " + i}, def = {...A.clone(AtriumParts.catalogue[0]), id: "r", name: "Resistor " + i};
      const provider = S.providers.memory(new Map([["components/r.json", {data: JSON.stringify(def), mtime: 1}]]));
      const {library} = await S.scan(folder, {provider});
      await S.load(library, "r");
      libraries.push(library); providers.push(provider);
    }
    assert.ok(libraries[0].defs[0].stub, "opening a fifth source evicts the first source's body and parsed file");
    const reads = providers[0].reads;
    assert.equal((await S.load(libraries[0], "r")).name, "Resistor 0");
    assert.equal(providers[0].reads, reads + 1);
    assert.ok(libraries[1].defs[0].stub);
    for (const l of libraries) await S.removeFolder(l.folder);
    await assert.rejects(S.load(libraries[2], "r"), /removed/);
  }
  {
    // ZIP archives (the downloaded KiCad libraries): listed from the central directory, entries read on demand.
    const zip = AtriumZip.create(FILES.map(p => ({name: "kicad-symbols-0123abc/" + p, data: text(p)})));
    // JSC's shell lacks Blob, but the provider only needs size and sliced bytes.
    const blob = bytes => typeof Blob === "function" ? new Blob([bytes]) : {
      size: bytes.length, slice(start, end) { return {arrayBuffer: async () => bytes.slice(start, end).buffer}; }
    };
    const prov = S.providers.archiveProvider({kicad: blob(zip)});
    const list = await prov.list();
    assert.equal(list.length, 8); assert.ok(list.every(f => f.path.startsWith("kicad/") && f.tag));
    const r = await S.refresh({id: "z", name: "Z"}, prov, {});
    assert.equal(r.library.defs.length, 7);
    const downloadedAgain = AtriumZip.create(FILES.map(p => ({name: "kicad-symbols-9999/" + p, data: text(p), date: new Date(2030, 0, 1)})));
    const again = await S.refresh({id: "z", name: "Z"}, S.providers.archiveProvider({kicad: blob(downloadedAgain)}), {index: r.index});
    assert.equal(again.stats.read, 0, "a new download with the same contents (same CRC and size) reads nothing");
    console.log("PASS ZIP provider: central directory listing, CRC tags, on-demand reads");
  }
  {
    const libFile = (id, name, width) => {
      const d = A.clone(AtriumParts.catalogue[0]); d.id = "shared-entry"; d.name = name; d.footprint.pads[0].w = width;
      return L.libraryFile({id, name, defs: [d], componentFamilies: [{id: "shared-family", name: "AD5940/AD5941", members: [{defId: d.id, part: name}]}]}).text;
    };
    const rec = {id: "portable-folder", name: "Mixed archive folder", kind: "files"};
    S.addFolder(rec);
    const provider = S.providers.memory(new Map([["first.atrlib", {data: libFile("first", "AD5940", .6)}], ["second.atrlib", {data: libFile("second", "AD5941", .8)}]]));
    const {library: lib} = await S.scan(rec, {provider});
    assert.equal(new Set(lib.defs.map(d => d.id)).size, 2);
    assert.equal(AtriumComponentFamilies.memberships(lib).size, 2);
    const second = lib.defs[1], one = S.load(lib, second.id);
    assert.equal(S.load(lib, second.id), one, "one promise owns all reads of the immutable row");
    const part = await one;
    assert.equal(part.name, "AD5941"); assert.equal(part.footprint.pads[0].w, .8);
    const legacy = {id: "shared-entry", hash: L.defHash(part), library: lib.id};
    assert.equal(S.findEntry(lib, legacy.id, legacy.hash).id, second.id, "legacy references need a unique exact hash");
    const owner = A.project("Legacy archive link", []), copy = L.addFromLibrary(lib, part, owner);
    copy.libraryRef = legacy;
    assert.equal(L.addFromLibrary(lib, part, owner), copy, "a legacy nested source link still identifies the same placed package");
    await S.removeFolder(rec.id);
  }
  {
    // Fuzz: malformed KiCad input never hangs or escapes as anything but an Error, and the pairing reports it.
    const seeds = [text("Lab_Amp.kicad_sym"), text("Lab_Package.pretty/SOIC-8_Test.kicad_mod"), text("Legacy.pretty/DIP-4_Legacy.kicad_mod")];
    let seed = 12345;
    const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const mutate = t => {
      const k = rand(7), i = rand(t.length);
      if (k === 0) return t.slice(0, i);
      if (k === 1) return t.slice(0, i) + "(".repeat(rand(400)) + t.slice(i);
      if (k === 2) return t.slice(0, i) + ")" + t.slice(i);
      if (k === 3) return t.slice(0, i) + '"' + t.slice(i);
      if (k === 4) return t.replace(/-?\d+\.\d+/g, () => ["1e308", "NaN", "-1e999", "0x10", ""][rand(5)]);
      if (k === 5) return t.replace(/\(extends "OPA_DUAL"\)/, '(extends "OPA_DUAL_DFN")');
      return t.slice(0, i) + String.fromCharCode(rand(0x2fff)) + t.slice(i + 1);
    };
    const t0 = Date.now();
    let errors = 0, ok = 0;
    for (let n = 0; n < 600; n++) {
      const which = rand(seeds.length), input = mutate(mutate(seeds[which])), name = which === 0 ? "Fuzz.kicad_sym" : "Fuzz.pretty/F.kicad_mod";
      try { which === 0 ? K.readSymbols(input, {file: name}) : K.readFootprint(input, {file: name}); ok++; }
      catch (e) { assert.ok(e instanceof Error, "a thrown value is an Error"); assert.ok(e.message.length > 0); errors++; }
      const r = K.pair([{name: name.split("/").pop(), path: name, text: input}]);
      assert.ok(Array.isArray(r.library) && r.report.notes.length >= 1);
      for (const d of r.library) for (const pad of d.footprint?.pads || []) assert.ok(Number.isFinite(pad.x) && Number.isFinite(pad.y), "no non-finite pad");
      // The folder index records a broken file instead of failing the scan.
      const index = S.emptyIndex();
      assert.ok(["parsed", "error"].includes(S.ingest(index, {path: name, size: input.length, mtime: 1}, input)));
    }
    // Extends cycles and depth, nesting and size limits.
    const cyc = '(kicad_symbol_lib (symbol "A" (extends "B")) (symbol "B" (extends "A")))';
    assert.equal(K.readSymbols(cyc, {file: "c.kicad_sym"}).symbols.length, 0);
    assert.ok(K.readSymbols(cyc, {file: "c.kicad_sym"}).notes.some(x => /circular/.test(x)));
    const chain = "(kicad_symbol_lib " + Array.from({length: 12}, (_, i) => '(symbol "S' + i + '"' + (i ? ' (extends "S' + (i - 1) + '")' : ' (symbol "S0_1_1" (pin input line (at 0 0 0) (length 2.54) (name "A") (number "1")))') + ")").join(" ") + ")";
    assert.ok(K.readSymbols(chain, {file: "d.kicad_sym"}).symbols.length <= K.LIMITS.extendsDepth + 1);
    assert.throws(() => K.readSymbols("(kicad_symbol_lib " + "(a ".repeat(5000) + ")".repeat(5000) + ")", {file: "deep.kicad_sym"}), /nests lists too deeply/);
    assert.throws(() => K.readFootprint("x".repeat(K.LIMITS.footprintFile + 1), {file: "big.kicad_mod"}), /larger than/);
    assert.throws(() => K.readFootprint('(kicad_pcb)', {file: "n.kicad_mod"}), /not a KiCad footprint/);
    assert.ok(Date.now() - t0 < 60000, "fuzz finishes promptly");
    console.log("PASS fuzz: 600 malformed KiCad files (" + errors + " rejected, " + ok + " read), extends cycles and depth, nesting and size limits; no eval");
  }
  {
    // Untrusted downloads are parsed, never run: no eval or Function in the readers.
    for (const f of ["library-import-kicad.js", "library-sources.js", "library-sources-ui.js"]) {
      const src = fs.readFileSync(appFile(f), "utf8");
      assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), f + " has no eval");
    }
    const ui = fs.readFileSync(__dirname + "/../../app/library/library-sources-ui.js", "utf8");
    assert.match(ui, /credentials: "omit", referrerPolicy: "no-referrer"/, "downloads send no cookies or referrer");
    assert.ok(!/headers\s*:/.test(ui), "downloads add no custom headers");
    console.log("PASS readers have no eval; the KiCad download sends no credentials, referrer or custom headers");
  }
};
globalThis.__testDone = run().catch(e => { console.error(e); process.exitCode = 1; });
