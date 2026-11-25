"use strict";
// Altium SchLib + PcbLib pairs into complete components (app/library/library-import-altium.js): symbols join the
// footprint their PCB model names inside the selected files only, with provenance (file, SHA-256, entry)
// and draft state; ambiguous, unmatched and unused entries and pin/pad mismatches are reported; a
// re-import of the same files is nothing new. Fixtures: tests/fixtures/library (ASCII SchLib/PcbLib).
const assert = require("node:assert/strict"), fs = require("node:fs");
for (const m of ["vendor/cfb.min", "model", "parts", "sch-import", "altium-rules", "pcb-pours", "pcb-import", "source-file", "io", "library-import-altium", "library-store", "library-panel"]) require(require("../support/app-source-paths.cjs").appFile(m));
const A = Atrium, P = AtriumLibraryImportAltium, S = AtriumLibraryStore;
const dir = __dirname + "/../fixtures/library/";
const read = names => names.map(n => { const bytes = new Uint8Array(fs.readFileSync(dir + n)); return {name: n, sha256: AtriumSourceFile.sha256(bytes), library: AtriumIO.read(n, bytes).library}; });

{
  const files = read(["Lab.SchLib", "Lab.PcbLib"]);
  const before = JSON.stringify(files.map(f => f.library));
  const {library, report} = P.pair(files);
  assert.equal(JSON.stringify(files.map(f => f.library)), before, "the parsed files are not changed");
  const by = n => library.find(d => d.name === n);
  const opamp = by("LMV321");
  assert.ok(opamp.symbol && opamp.footprint, "a complete component");
  assert.equal(opamp.footprint.name, "SOT23-5"); assert.equal(opamp.footprint.pads.length, 5);
  assert.equal(opamp.state, "draft");
  assert.deepEqual([opamp.source.kind, opamp.source.file, opamp.source.entry], ["altium-schlib", "Lab.SchLib", "LMV321"]);
  assert.equal(opamp.source.sha256, files[0].sha256); assert.match(opamp.source.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([opamp.source.footprint.kind, opamp.source.footprint.file, opamp.source.footprint.entry, opamp.source.footprint.sha256], ["altium-pcblib", "Lab.PcbLib", "SOT23-5", files[1].sha256]);
  assert.ok(A.validate({format: "atrium", version: 1, name: "x", library: library.map(d => JSON.parse(JSON.stringify(d))), documents: [A.sheet("schematic", "s")]}));
  // Pins match pads by number; the SOT-223 tab (pad 4) has no pin and is reported.
  assert.deepEqual(report.mismatches, [{name: "LDO_ADJ", noPad: [], noPin: ["4"]}]);
  assert.ok(!S.health([opamp]).issues.some(x => /unmapped/.test(x.code)), "the op-amp's pins and pads all map");
  // A footprint in none of the selected files is reported, never searched for elsewhere.
  assert.deepEqual(report.unmatched, [{symbol: "MYSTERY", footprint: "QFN99"}]);
  assert.equal(by("MYSTERY").footprint, undefined);
  // A footprint no symbol uses stays available on its own.
  assert.deepEqual(report.unused.map(u => u.footprint), ["TESTPAD"]);
  assert.ok(by("TESTPAD").footprint && !by("TESTPAD").symbol);
  assert.deepEqual([report.paired, report.symbolOnly, report.footprintOnly, report.components], [3, 1, 1, 5]);
  assert.ok(report.notes.some(n => /inside the selected files only/.test(n)));
  console.log("PASS SchLib + PcbLib: complete components with provenance, draft state, mismatches, unmatched and unused entries");
}
{
  // Two PcbLibs: R0603 differs (ambiguous: symbol kept alone, both files named); SOT23-5 is identical (used once).
  const files = read(["Lab.SchLib", "Lab.PcbLib", "Extra.PcbLib"]);
  const {library, report} = P.pair(files);
  assert.deepEqual(report.ambiguous, [{symbol: "RES_0603", footprint: "R0603", files: ["Lab.PcbLib", "Extra.PcbLib"]}]);
  assert.equal(library.find(d => d.name === "RES_0603").footprint, undefined);
  assert.deepEqual(report.identical, [{footprint: "SOT23-5", files: ["Lab.PcbLib", "Extra.PcbLib"]}]);
  assert.equal(library.filter(d => d.name === "SOT23-5").length, 0, "the identical copy is not left over as a separate footprint");
  // Re-importing the same files into a project that has them is nothing new.
  const again = P.pair(files, {existing: library});
  assert.equal(again.library.length, 0); assert.equal(again.report.skipped, library.length);
  console.log("PASS ambiguous footprints across files are reported, identical ones used once; a re-import is recognised");
}
{
  // The File › Open path: SchLib and PcbLib together become one paired library; anything else is untouched.
  const names = ["Lab.SchLib", "Lab.PcbLib"], files = read(names);
  const all = files.map(f => ({documents: [], library: f.library, notes: []}));
  const out = P.apply(all, names.map(name => ({name})), {sha256: files.map(f => f.sha256)});
  assert.equal(out[0].library.length, 5); assert.equal(out[1].library.length, 0);
  assert.ok(out[0].notes.some(n => /Paired 3 symbols/.test(n)));
  const single = all.slice(0, 1); assert.equal(P.apply(single, names.slice(0, 1).map(name => ({name}))), single, "a SchLib alone is not paired");
  // The paired components survive a project save and validate.
  const p = A.project("Lib", []); p.library.push(...out[0].library);
  A.validate(JSON.parse(JSON.stringify(p)));
  console.log("PASS File › Open pairing and project round trip");
}
{
  // A two-part SchLib symbol (dual op-amp): both parts are gates, shared power pins (part 0) on each,
  // the De Morgan display mode left out; it pairs with its SOIC-8 and places as U1A and U1B.
  const files = read(["Dual.SchLib", "Dual.PcbLib"]);
  const sym = files[0].library[0];
  assert.equal(sym.symbol.parts, 2, "two gates");
  const gate = n => sym.symbol.pins.filter(q => (q.part || 0) === n).map(q => q.number).sort();
  assert.deepEqual([gate(1), gate(2), gate(0)], [["1", "2", "3"], ["5", "6", "7"], ["4", "8"]]);
  assert.ok(sym.symbol.shapes.some(s => s.part === 1) && sym.symbol.shapes.some(s => s.part === 2), "body graphics per gate");
  assert.equal(sym.symbol.shapes.filter(s => s.kind === "path" && s.closed && s.part === 1).length, 1, "the De Morgan view is not mixed in");
  assert.ok((sym.schDrawing?.pins || []).every(t => t.part === undefined || t.part === 1 || t.part === 2));
  assert.ok(AtriumLibrary.validateDef(sym).ok, AtriumLibrary.validateDef(sym).errors.join("; "));
  assert.equal(A.gate(sym.symbol, {unit: 2}).pins.filter(q => q.part === 2).length, 3);
  assert.ok(!A.gate(sym.symbol, {unit: 2}).pins.some(q => q.part === 1), "gate B shows only its own pins and the shared ones");
  const {library, report} = P.pair(files);
  assert.equal(report.paired, 1); assert.deepEqual(report.mismatches, []);
  assert.equal(library[0].footprint.pads.length, 8);
  console.log("PASS multi-part SchLib symbols import every part as a gate, shared pins on each, pairing with the footprint");
}

// Equal pad geometry cannot resolve a choice between different source bodies.
{
  const files = read(["Lab.SchLib", "Lab.PcbLib", "Extra.PcbLib"]);
  const hit = files.find(f => f.name === "Extra.PcbLib").library.find(d => d.footprint?.name === "SOT23-5");
  hit.footprint.bodies3d = [{type: "extruded", minZ: 0, maxZ: 2, rings: [[[0,0],[2,0],[0,2]]]}];
  const result = AtriumLibraryImportAltium.pair(files);
  assert.ok(result.report.ambiguous.some(r => r.footprint === "SOT23-5"));
}
