"use strict";
// Waffle's bill of materials against the one Altium Designer generated for the same project (an
// external oracle). Fixture: the PiDP-11 I/O Expander (tests/fixtures/altium/pidp11-io-expander,
// BSD-2-Clause, see NOTICE). Its RevA release ships Assembly/Bill of Materials.xlsx, made by
// Sources/Assembly.OutJob with VariantName=Default; its readings are in altium-reports-reva.json.
//
// The PrjPcb defines that variant ([ProjectVariant1] "Default") with six parts Not Fitted: the
// address jumpers A0-A2, the second header J2 and the optional pull-ups R2 and R3. The project is
// imported as File › Import › Altium does and its BOM is collected with Altium's variant. Then, per
// manufacturer part number: the quantity, description and manufacturer equal Altium's line.
//
// Lines from the project's ActiveBOM document (packaging, labels, cables, the bare PCB) have no
// schematic component, and the BomDoc is neither in the fixture nor imported: they are listed in
// BOMDOC_ONLY and asserted to be absent from Waffle's BOM.
// Run: node tests/formats/bom-altium-report.cjs   (or scripts/test-jsc.sh bom-altium-report)
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const {appFile} = require("../support/app-source-paths.cjs");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "polygon-pour", "import-link", "source-file", "sch-import",
  "altium-rules", "pcb-pours", "pcb-import", "io", "connectivity", "variants", "zip", "bom"]) require(appFile(f + ".js"));
const REPORTS = require("../support/altium-reports.cjs"), A = Atrium, B = AtriumBOM, V = AtriumVariants;
const ref = REPORTS.reference(), FIX = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
const VARIANT = "Default";

// ActiveBOM-only lines (description | manufacturer part number): no component in the schematic.
const BOMDOC_ONLY = ["LABEL SHIPPING 6X4IN MOQ200|DK-1241", "BAG STATIC METAL-IN 2X4\"|10024", "LABEL ESD/STATIC 2X2 500PC|06722",
  "TAPE DBL COAT CLR 1/2\"X 1\" 25/PK|3M 4910 0.5\" X 1\"-25", "CABLE ASSY 5V 12CM MOQ100|MTO", "CABLE ASSY I2C 18CM MOQ100|MTO",
  "PCB FR4 2-LAYER MATTE BLACK HASL MOQ5|MTO", "CONN HEADER R/A 4POS 2.54MM|10129379-904003BLF", "BAG RECLOSEABLE 2MIL 2X3IN MOQ1000|S-1291",
  "DESSICANT SILICA GEL 1/2G MOQ6000|S-8032", "LABEL SERIAL NUMBER 1/2X3/4IN MOQ22400|S-16986", "MAILER POLY BUBBLE 6X10IN BLACK MOQ250|S-22402"];

// ---------------------------------------------------------------- Altium's BOM lines
const rows = ref.bom.rows, head = rows.findIndex(r => r.includes("Quantity") && r.includes("Manufacturer Part Number"));
assert.ok(head >= 0, "the Altium BOM has a header row");
const col = name => rows[head].indexOf(name);
const altium = rows.slice(head + 1).filter(r => /^\d+$/.test(r[col("Quantity")]))
  .map(r => ({qty: +r[col("Quantity")], description: r[col("Description")], manufacturer: r[col("Manufacturer")], mpn: r[col("Manufacturer Part Number")]}));
assert.equal(altium.length, 25, "25 Altium BOM lines");
const lineKey = l => l.description + "|" + l.mpn;
for (const k of BOMDOC_ONLY) assert.ok(altium.some(l => lineKey(l) === k), "BOMDOC_ONLY entry is an Altium line: " + k);
const components = altium.filter(l => !BOMDOC_ONLY.includes(lineKey(l)));

// ---------------------------------------------------------------- Waffle's BOM with Altium's variant
const FILES = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"];
const read = FILES.map(name => AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(FIX, name)))));
const p = A.project("PiDP-11 I/O Expander"); p.documents = []; p.library = [];
for (const r of read) { p.documents.push(...(r.documents || [])); p.library.push(...(r.library || [])); }
const manifest = read.find(r => r.manifest)?.manifest;
if (manifest?.parameters) p.parameters = {...manifest.parameters};
AtriumImportLink.reconcile(p, p.documents);
A.validate(p);
const variant = V.list(p).find(v => v.name.toLowerCase() === VARIANT.toLowerCase()) || null;
const collected = B.collect(p, {variant: variant ? variant.id : null}), bom = B.build(collected);
const value = (row, key) => String(row.values[key] ?? "");
const waffle = new Map();
for (const row of bom.rows || bom) {
  const mpn = value(row, "mpn"), line = waffle.get(mpn) || {qty: 0, refs: [], description: value(row, "description"), manufacturer: value(row, "manufacturer")};
  line.qty += row.parts.length; line.refs.push(...row.parts.map(e => e.ref)); waffle.set(mpn, line);
}

// ---------------------------------------------------------------- compare per part number
const diffs = [];
for (const l of components) {
  const w = waffle.get(l.mpn);
  if (!w) { diffs.push(l.mpn + ": missing (Altium " + l.qty + " x " + l.description + ")"); continue; }
  if (w.qty !== l.qty) diffs.push(l.mpn + ": quantity " + w.qty + " (" + w.refs.join(" ") + "), Altium " + l.qty);
  if (w.description !== l.description) diffs.push(l.mpn + ": description " + JSON.stringify(w.description) + ", Altium " + JSON.stringify(l.description));
  if (w.manufacturer !== l.manufacturer) diffs.push(l.mpn + ": manufacturer " + JSON.stringify(w.manufacturer) + ", Altium " + JSON.stringify(l.manufacturer));
}
for (const [mpn, w] of waffle) if (!components.some(l => l.mpn === mpn)) diffs.push(mpn + ": extra line " + w.qty + " (" + w.refs.join(" ") + ")");
for (const k of BOMDOC_ONLY) assert.ok(!waffle.has(k.split("|")[1]), "an ActiveBOM-only line has a schematic component: " + k);
assert.deepEqual(diffs, [], "Waffle's BOM differs from Altium's (variant " + VARIANT + (variant ? "" :
  " was not imported: the PrjPcb's [ProjectVariant1] marks A0, A1, A2, J2, R2 and R3 Not Fitted") + "):\n  " + diffs.join("\n  "));
console.log("PASS bom-altium-report: " + components.length + " component lines equal Altium's BOM (variant " + VARIANT + "), " +
  BOMDOC_ONLY.length + " ActiveBOM-only lines" + (ref.verified ? "; extract verified against the release files" : ""));
