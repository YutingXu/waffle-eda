"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const app = path.resolve(__dirname,"../../app"), fixture = name => fs.readFileSync(path.join(__dirname,"../fixtures",name));
require("../../app/project/obsolete-project.js");
require("../../app/translator-table.js");
require("../../app/formats/translator-registry.js");
require("../../app/formats/translators.js");

const R = AtriumTranslatorRegistry, table = JSON.parse(fs.readFileSync(path.join(app,"translators.json"),"utf8"));
assert.deepEqual(R.list(),table);
for (const direction of ["import","export"]) {
  const capable = table.filter(row => row[direction]), extensions = [...new Set(capable.flatMap(row => row.extensions))];
  assert.deepEqual(R.list(direction),capable);
  assert.deepEqual(R.extensions(direction),extensions);
  assert.equal(R.accept(direction),extensions.join(","));
  for (const row of capable) {
    assert.ok(row.modules[direction].length && row.adapter[direction],row.id);
    assert.ok(Object.isFrozen(R.get(row.id)));
  }
}
const detect = (name, value) => R.detect(name,typeof value === "string" ? new TextEncoder().encode(value) : value)?.id;
const legacy = fixture("compat/projects/v1.4-sample.atrium");
assert.throws(()=>detect("renamed.json",legacy),{code:"pre-release-format",message:AtriumObsoleteProject.note});
assert.equal(R.get("legacy"),null);
assert.equal(R.forName("Project.atrium"),null);
assert.ok(!R.extensions().includes(".atrium"));
assert.ok(R.isProject("Project.waffle") && R.isProject("Project.zip") && !R.isProject("Project.atrium"));
assert.throws(()=>AtriumTranslators.export("legacy",{}),/legacy has no export translator/);
assert.equal(detect("renamed.xml",fixture("import/demo-eagle.brd")),"eagle");
assert.equal(detect("renamed.brd",fixture("import/demo.kicad_pcb")),"kicad");
assert.equal(detect("board geometry",fixture("import/root.kicad_sch")),"kicad");
assert.equal(detect("tray",fixture("mcad/tray.step")),"step");
assert.equal(detect("sheet.json",'{"head":{"format":"atrium","docType":"1"},"shape":[]}'),"easyeda");
assert.equal(detect("connections.net","(export (version D))"),"netlist-kicad");
assert.equal(detect("connections.NET","[\nR1\n]"),"netlist-protel");
assert.equal(detect("rates.csv","Date,Rate\n2026-01-01,1"),undefined);
assert.equal(detect("ports.txt","Net,Designator,Pin\nCLK,U1,2"),"netlist-csv");
assert.equal(detect("future.waffle",'{"kind":"project","formatVersion":"2.0"}\n{"id":"one"}'),undefined);
assert.equal(detect("future.waffle",'{"kind":"project","formatVersion":"2.1","format":"waffle"}\n{"id":"one"}'),undefined);
assert.equal(R.forName("SHEET.SCHDOC").id,"altium");
assert.ok(R.isLibrary("parts.KICAD_SYM") && R.isProject("power.PrjPcb"));
assert.equal(R.get("odb").import,false);
assert.equal(R.get("odb").export,true);
assert.equal(R.forName("film.gbr"),null);
assert.throws(()=>AtriumTranslators.export("odb",{}),/Enable ODB\+\+ output in Experimental features/);
assert.throws(()=>AtriumTranslators.import([{name:"empty.odb",bytes:new Uint8Array()}]),
  {message:R.get("odb").label + " has no import translator."});
console.log("PASS shared translator discovery, content signatures, filters and unsupported directions");
