"use strict";
// Import report accounting (translators.js notApplicable, sch-import.js): Altium bookkeeping that has no
// meaning in Waffle is reported apart from real losses. Pin UniqueIDs, model containers and preview image
// lists are not applicable; the copy of another part of a multi-part component is not applicable when that
// part is placed somewhere in the project, and dropped when it is not. Alternate footprints stay dropped.
// Fixtures: synthetic ASCII SchDocs built below.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["obsolete-project","model","sch-objects","hierarchy","board-shape","board-shape-sources","net-intent","signals","altium-rules","pcb-draw","component-classes","query","rules","project-rules","pcb-pours","stackup",
  "pdf-fonts","altium-typefaces","altium-ids","source-file","sch-import","pcb-import","pcb-appearance","library-import-altium",
  "sexpr","import-kicad","import-eagle","sch-appearance","import-link","io","import-rules","translator-table","translator-registry","translator-provenance","translator-adapters","translators"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const T = AtriumTranslators, R = AtriumTranslatorRegistry;
const encoded = (name, text) => ({name, bytes: new TextEncoder().encode(text)});
// Records in order; a child names its owner by key and belongs to part 1 unless it says otherwise.
function schDoc(records) {
  const at = new Map(records.map((r, i) => [r.key, i]));
  return "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=" + records.length + "\r\n" + records.map(r =>
    "|" + Object.entries({RECORD: r.record, ...(r.owner ? {OWNERINDEX: at.get(r.owner), OWNERPARTID: 1} : {}), ...r.f}).map(([k, v]) => k + "=" + v).join("|")).join("\r\n") + "\r\n";
}
const pin = (owner, key, number, part, x, y, more = {}) => ({owner, key, record: 2, f: {OWNERPARTID: part, PINCONGLOMERATE: 0, PINLENGTH: 20, "LOCATION.X": x, "LOCATION.Y": y, NAME: "P" + number, DESIGNATOR: number, ...more}});
// A two-gate component placed as gate `current`: both gates' pins are in the record set, as Altium writes them.
const dual = (key, ref, current, x, y) => [
  {key, record: 1, f: {LIBREFERENCE: "DUAL", CURRENTPARTID: current, PARTCOUNT: 3, "LOCATION.X": x, "LOCATION.Y": y, UNIQUEID: key.toUpperCase().padEnd(8, "X")}},
  pin(key, key + "p1", "1", 1, x - 10, y), pin(key, key + "p2", "2", 2, x + 10, y),
  {owner: key, record: 34, f: {OWNERPARTID: -1, TEXT: ref, "LOCATION.X": x, "LOCATION.Y": y + 20}}];
const sheet = {record: 31, f: {}};
const A = schDoc([sheet,
  ...dual("u1", "U1", 1, 100, 500),
  {owner: "u1p1", record: 41, f: {NAME: "PinUniqueId", TEXT: "ABCDEFGH"}},
  {owner: "u1p1", record: 41, f: {NAME: "Signal", TEXT: "kept by the original only"}},
  pin("u1", "u1alt", "3", 1, 100, 520, {OWNERPARTDISPLAYMODE: 1}),
  {owner: "u1", key: "impl", record: 44, f: {}},
  {owner: "impl", record: 45, f: {MODELNAME: "ALT0805", MODELTYPE: "PCBLIB"}},
  {owner: "impl", key: "model", record: 45, f: {MODELNAME: "SO8", MODELTYPE: "PCBLIB", ISCURRENT: "T"}},
  {owner: "model", record: 46, f: {}}, {owner: "model", key: "params", record: 48, f: {}},
  {owner: "params", record: 41, f: {NAME: "Available Preview Images", TEXT: "x"}},
  ...dual("u2", "U2", 1, 400, 500)]);
const B = schDoc([sheet, ...dual("v1", "U1", 2, 100, 500)]);
const {report} = T.import([encoded("A.SchDoc", A), encoded("B.SchDoc", B)]);
const row = kind => report.kinds.find(r => r.kind === kind);
const refs = (kind, file) => [...R.references(row(kind))].filter(r => !file || r.source.file === file);
const statusOf = (kind, file, index) => refs(kind, file).find(r => r.source.object === "ASCII record#" + index);

// Pins: each gate imports where it is placed; U2 gate 2 is placed nowhere and its pin is a real loss.
// A.SchDoc: 0 sheet, 1 U1, 2 U1 pin 1, 3 U1 pin 2, ...; B.SchDoc: 0 sheet, 1 U1, 2 gate 1 pin, 3 gate 2 pin.
assert.equal(statusOf("Pin", "A.SchDoc", 2).status, "kept");
assert.deepEqual([statusOf("Pin", "A.SchDoc", 3).status, statusOf("Pin", "A.SchDoc", 3).reason], ["notApplicable", "Copy of another part of a multi-part component. That part imports where it is placed."]);
assert.equal(statusOf("Pin", "B.SchDoc", 2).status, "notApplicable");
assert.equal(statusOf("Pin", "B.SchDoc", 3).status, "kept");
const u2gate2 = statusOf("Pin", "A.SchDoc", 16);
assert.equal(u2gate2.status, "dropped", "a gate placed nowhere stays a loss");
assert.match(u2gate2.reason, /not placed in the selected files/);
// The alternate (De Morgan) display mode has no Waffle representation: dropped.
assert.match(statusOf("Pin", "A.SchDoc", 7).reason, /alternate display mode/);
assert.equal(statusOf("Pin", "A.SchDoc", 7).status, "dropped");
// Bookkeeping: the pin UniqueID is not applicable; another pin parameter is a loss.
assert.equal(statusOf("Parameter", "A.SchDoc", 5).status, "notApplicable");
assert.equal(statusOf("Parameter", "A.SchDoc", 6).status, "dropped");
assert.equal(statusOf("Parameter", "A.SchDoc", 13).status, "notApplicable", "the model's preview image list");
for (const kind of ["Implementation list", "Implementation map", "Parameter map"]) assert.deepEqual([row(kind).notApplicable, row(kind).dropped], [1, 0], kind);
// The current footprint is the association; the alternate read before it is a loss, not an approximation.
assert.deepEqual([statusOf("Implementation", "A.SchDoc", 9).status, statusOf("Implementation", "A.SchDoc", 9).reason], ["dropped", "Alternate footprint. Waffle keeps the component's current footprint."]);
assert.equal(statusOf("Implementation", "A.SchDoc", 10).status, "approximated");
// Rows keep their v1 shape: the count appears only where it is nonzero, and totals still add up.
for (const r of report.kinds) {
  assert.equal(r.kept + r.approximated + r.dropped + (r.notApplicable || 0), [...R.references(r)].reduce((n, x) => n + x.count, 0), r.kind);
  if (!r.notApplicable) assert.ok(!("notApplicable" in r), r.kind);
}
assert.equal(report.version, 1);
assert.equal(row("Pin").notApplicable, 2);
console.log("PASS import report accounting: " + report.kinds.reduce((n, r) => n + (r.notApplicable || 0), 0) + " not applicable, " + report.kinds.reduce((n, r) => n + r.dropped, 0) + " dropped");
