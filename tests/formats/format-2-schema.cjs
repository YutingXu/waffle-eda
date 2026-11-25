"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const module of ["model", "source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model", "import-sidecars"]) {
  require(require("../support/app-source-paths.cjs").appFile(module + ".js"));
}
const {checkSchema, nativeRowSchema} = require("../../integrations/vscode/lib/validate.js");
const schemaPath = path.join(__dirname, "../../integrations/vscode/schema/waffle-folder-record.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const F = AtriumFormat2, M = AtriumFormat2Model, S = AtriumImportSidecars;
const root = path.join(__dirname, "../fixtures/format-2");
const bytes = (dir, file) => fs.readFileSync(path.join(root, dir, file), "utf8");
const lines = text => text.trimEnd().split("\n").map(JSON.parse);
const def = name => ({$defs: schema.$defs, $ref: "#/$defs/" + name});

function validate(row, name, hint = row.kind) {
  assert.deepEqual(checkSchema(row, def(name)), [], hint);
}
function rejects(row, name, hint = row.kind) {
  assert.ok(checkSchema(row, def(name)).length > 0, hint);
}
function checkCorpus() {
  const projects = JSON.parse(fs.readFileSync(path.join(root, "projects.json"), "utf8"));
  const pending = projects.map(({directory, manifest}) => ({directory, member: manifest}));
  const seen = new Set();
  let count = 0, opaque = 0;
  while (pending.length) {
    const {directory, member, archived, sidecar} = pending.pop();
    const key = path.join(directory, member);
    if (seen.has(key)) continue;
    seen.add(key);
    const text = bytes(directory, member), rows = lines(text), header = rows[0];
    const file = sidecar ? (S.parse(text), {header, isOpaque: () => false}) : M.parse(text, {opaque: true});
    for (let i = 0; i < rows.length; i++) {
      const profile = nativeRowSchema(schema, file, rows[i], i === 0);
      if (profile.$ref.endsWith("/opaqueRecord")) opaque++;
      assert.deepEqual(checkSchema(rows[i], profile), [], key + ":" + (i + 1));
      count++;
    }
    if (!sidecar) for (const ref of M.dependencies(file, {archived})) {
      if (ref.kind !== "model" && ref.kind !== "asset") pending.push({
        directory, member: ref.path, archived: ref.kind === "archived", sidecar: ref.kind === "import-index",
      });
    }
  }
  assert.ok(seen.size >= 30 && count >= 150 && opaque > 0, [seen.size, count, opaque].join("/"));
  return {files: seen.size, count, opaque};
}

function checkOwnerShapes() {
  const id = "019ab000-0000-7000-8abc-000000000001";
  validate(id, "uuidV7", "new native ID");
  for (const invalid of [id.toUpperCase(), id.replace("-7000-", "-4000-"), id.replace("-8abc-", "-cabc-")]) {
    rejects(invalid, "uuidV7", "non-v7 ID");
  }
  for (const kind of [...Object.keys(F.documentSuffix), "library"]) {
    const legacy = {kind, formatVersion: F.FORMAT, id: "old-id", ...(kind === "library" ? {name: "Probe"} : {})};
    validate(legacy, "header");
    rejects(legacy, "amendedOwnerHeader", "fresh writer needs explicit requires");
    const produced = F.create({...legacy, id}).header;
    validate(produced, "amendedOwnerHeader");
    assert.deepEqual(produced.requires, []);
    assert.equal(M.parse(F.canonical(legacy) + "\n").header.requires, undefined);
  }

  const workshop = lines(bytes("workshop", "Board.wpcb"));
  const track = workshop.find(row => row.kind === "track");
  const pin = {kind: "pin", id: "p", value: {number: "1", x: 0, y: 10000}};
  validate(track, "pcbRecord");
  validate(pin, "libraryRecord");
  rejects(pin, "pcbRecord");
  rejects({...pin, value: {...pin.value, x: 0.01}}, "libraryRecord");
  rejects({...track, points: [[1, 2, 3], [2, 3]]}, "pcbRecord");
  rejects({...track, points: [[1, 2], [Number.MAX_SAFE_INTEGER + 1, 3]]}, "pcbRecord");
  rejects({...track, arc: {kind: "arc", c: [0, 0], r: 1000, start: 0, sweep: 0}}, "pcbRecord");
  validate({...track, arc: {kind: "arc", c: [0, 0], r: 1000, start: 0, sweep: -90000000000}}, "pcbRecord");
  rejects({kind: "pad", id: "p", at: [1, 2], w: 1, h: 1}, "libraryRecord");
  validate({kind: "pad", id: "p", value: {x: 0, y: 0, w: 1, h: 1}}, "libraryRecord");
  rejects({kind: "layer", id: "L", value: {name: "Top", type: "Signal", thickness: "35um"}}, "pcbRecord");
  rejects({kind: "shape", id: "s", value: {kind: "circle", x: 0, y: 0, r: 1}}, "libraryRecord");
  validate({kind: "shape", id: "s", side: "symbol", value: {kind: "circle", x: 0, y: 0, r: 1}}, "libraryRecord");
  rejects({kind: "document", id: "s", docKind: "pcb", name: "Power", path: "Power.wsch"}, "projectRecord");
  rejects({kind: "document", id: "s", docKind: "pcb", name: "Power", path: "../Power.wpcb"}, "projectRecord");
  rejects({kind: "rule", id: "r", value: {type: "clearance", scope: {languageVersion: 1, source: "object"}}}, "projectRecord");
  validate({kind: "signal", id: "bus", value: {id: "bus", kind: "bus", name: "DATA", members: []}}, "projectRecord");
  validate({kind: "tag", id: "tag", value: {name: "Clock", color: "#000a5f"}}, "projectRecord");
}

function checkOptionalMetadataShapes() {
  const [header,...rows] = lines(bytes("butter-project-metadata","Project Metadata.waffle"));
  const metadata = new Map(rows.filter(row=>F.isOptionalManifestKind(row.kind)).map(row=>[row.kind,row]));
  assert.equal(metadata.size,7);
  validate(header,"butterOptionalProjectHeader");
  rejects({...header,formatVersion:"2.0"},"butterOptionalProjectHeader");
  rejects({...header,requires:["notebook.table.v1"]},"butterOptionalProjectHeader");

  const invalid = [
    ["savedQuery", value=>{delete value.scope.documentId; value.scope.instanceId="orphan";}],
    ["savedView", value=>{value.camera.scale="1.5";}],
    ["savedView", value=>{value.camera.scale={$number:"-1"};}],
    ["savedView", value=>{value.selection.push(value.selection[0]);}],
    ["slide", value=>{delete value.source.frameId;}],
    ["link", value=>{value.target.fragment="datasheet:page=0";}],
    ["linkAnchor", value=>{value.kind="net";}],
    ["datasheetRef", value=>{value.sourceURL="https://user@docs.example.invalid/data.pdf";}],
    ["datasheetAnnotation", value=>{value.points=[[10,20],[30,40]];}],
  ];
  for (const [kind,makeInvalid] of invalid) {
    const row=structuredClone(metadata.get(kind));
    makeInvalid(row.value);
    rejects(row,"projectRecord",kind+" known fields");
    assert.throws(()=>M.manifest(F.create(header,rows.map(prior=>prior.id===row.id?row:prior),
      M.readOptions("project",header.id))),/invalid/i,kind);
  }
  for (const row of metadata.values()) {
    validate(row,"projectRecord");
    rejects(row,"schematicRecord");
  }
  const table=lines(bytes("butter-table-query","Parts.wsch")).find(row=>row.kind==="tableCell");
  validate(table,"schematicRecord");
  rejects(table,"pcbRecord");
  const {content,...emptyCell}=table;
  rejects(emptyCell,"schematicRecord","a sparse table cell needs content or style");
}

function checkCompatibility() {
  const header = {kind: "schematic", formatVersion: F.FORMAT, id: "sheet", requires: []};
  const label = {kind: "netlabel", id: "a", at: [1, 2], text: "GND", "x-extension": {width: 2.5}};
  const opaque = {kind: "extensionTrace", id: "b", order: {ownedBy: "extension"}, formatVersion: "extension-1"};
  const raw = F.canonical(header) + "\n" + JSON.stringify(label) + "\n" + JSON.stringify(opaque) + "\n";
  const file = M.parse(raw);
  assert.equal(file.readOnly, false);
  assert.equal(file.isOpaque(opaque.id), true);
  assert.equal(file.isOpaque(label.id), false);
  assert.deepEqual(checkSchema(label, nativeRowSchema(schema, file, label, false)), []);
  assert.deepEqual(checkSchema(opaque, nativeRowSchema(schema, file, opaque, false)), []);
  rejects(opaque, "schematicRecord", "unrecognized payload requires explicitly selected opaque envelope");
  rejects({kind: "netlabel", id: "bad", at: [1.5, 2], text: "GND"}, "schematicRecord");
  assert.throws(() => M.parse(F.canonical(header) + "\n" + '{"kind":"extensionTrace","id":"b","id":"c"}\n'), /duplicate/i);

  const required = {...header, requires: ["example-unavailable"], readerRequires: {"example-unavailable": "2.1"}};
  validate(required, "header");
  const readOnly = M.parse(F.canonical(required) + "\n");
  assert.equal(readOnly.readOnly, true);
  assert.throws(() => F.create(required, [], M.readOptions("schematic", required.id)), /example-unavailable/);
  rejects({...required, readerRequires: {"example-unavailable": "2.01"}}, "header");
  rejects({...header, requires: ["x", "x"]}, "header");
  rejects({...header, requires: [17]}, "header");
  const continuation = {...header, requires: ["continuation-parts-v1"]};
  rejects(continuation, "header");
  assert.throws(() => M.parse(F.canonical(continuation) + "\n"), /continuation-parts-v1/);
}

const counts = checkCorpus();
checkOwnerShapes();
checkOptionalMetadataShapes();
checkCompatibility();
console.log("format-2-schema:", counts.files, "native files,", counts.count, "rows,", counts.opaque,
  "opaque rows, and writer/negative compatibility vectors passed");
