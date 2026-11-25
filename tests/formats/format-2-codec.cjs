"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
for (const module of ["source-file", "format-2-codec", "format-2-units"]) require(require("../support/app-source-paths.cjs").appFile(module + ".js"));
const F = AtriumFormat2, U = AtriumFormat2Units;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const text = file => decoder.decode(F.serialize(file));
const fixture = name => fs.readFileSync(path.join(__dirname, "../fixtures/format-2/golden", name), "utf8");

const manifest = F.parse(fixture("Sensor Board.waffle"));
const sheet = F.parse(fixture("Power.wsch"), {kind: "schematic", id: "s1", knownKinds: ["netlabel"]});
assert.equal(manifest.byteLength, 160);
assert.equal(sheet.byteLength, 121);
assert.equal(F.sha256(F.serialize(sheet)), "97ff75921360fc03cc25687c26d8635d8ab222241d0fa2cfe1af94e8f2300e7c");
assert.deepEqual(F.manifestMembers(manifest), [{path: "Power.wsch", id: "s1", kind: "schematic", name: "Power"}]);
const member = {path: "Power.wsch", sha256: F.sha256(F.serialize(sheet))};
assert.equal(F.projectDigest(manifest, [member]), "0b1e6a5e9b241a9ffb2f1fd92fbafb656d1cd6f3f64e908c7c591d55c8135f64");
assert.throws(() => F.projectDigest(manifest, []), /Missing project member/);
assert.throws(() => F.projectDigest(manifest, [member, {...member, path: "POWER.wsch"}]), /Duplicate/);
assert.throws(() => F.projectDigest(manifest, [member, {...member, path: ".waffle/local/hash"}]), /outside/);
const additional = {...member, path: "日本語/Étage.wsch"};
assert.equal(F.projectDigest(manifest, [additional, member]), F.projectDigest(manifest, [member, additional]));
assert.throws(() => F.portablePath("E\u0301tage.wsch"), /portable/);
assert.equal(F.pathKey("Straße.wsch"), F.pathKey("STRASSE.wsch"));
for (const bad of ["a/../b", "a//b", "/a", "a\\b", "NUL.txt", "a/.Git/config", "a/b."]) assert.throws(() => F.portablePath(bad));
for (const suffix of ["wsch","WPCB","wDrAw","WPANEL","wlib"]) {
  const filename = "Owned." + suffix;
  assert.equal(F.portablePath("Docs/" + filename), "Docs/" + filename);
  assert.throws(() => F.portablePath("Docs/" + filename + "/Nested/Power.wsch"), /used as a directory/);
}
assert.equal(F.canonical({z: "e\u0301", kind: "test", formatVersion: "2.0", id: "id",
  "\u{10000}": "/", "\ue000": "\n\t\u2028\u2029", "2": true, "10": false}),
  '{"kind":"test","formatVersion":"2.0","id":"id","10":false,"2":true,"z":"é","":"\\u000a\\u0009\\u2028\\u2029","𐀀":"/"}');

for (const bad of [
  "\ufeff" + fixture("Power.wsch"),
  fixture("Power.wsch").slice(0, -1),
  fixture("Power.wsch") + "\n",
  fixture("Power.wsch").replace('"id":"n1"', '"id":"n1","id":"n1"'),
  fixture("Power.wsch").replace('"text":"SENSE"', '"text":"\\ud800"'),
  fixture("Power.wsch").replace("1270000", "1.27"),
  fixture("Power.wsch").replace("1270000", "1e3"),
  fixture("Power.wsch").replace("1270000", "9007199254740992"),
  fixture("Power.wsch").replace("1270000", "-0"),
  fixture("Power.wsch").replace("SENSE", "\\u0053ENSE"),
  fixture("Power.wsch").replace('"at":[', '"at": ['),
  fixture("Power.wsch") + '{"kind":"netlabel","id":"n1"}\n',
]) assert.throws(() => F.parse(bad), /native|Unicode|format|JSON/i);
assert.throws(() => F.parse(Uint8Array.of(0xff, 10)), /UTF-8/);

const nested = F.edit(sheet, {put: [{...sheet.get("n1"), values: JSON.parse(
  '{"10":true,"2":false,"__proto__":{"safe":null},"id":"z","kind":"owner"}',
)}]});
const parsedNested = F.parse(text(nested));
assert.equal(text(parsedNested), text(nested), "integer-index properties require their UTF-8 order");
assert.ok(Object.isFrozen(parsedNested.get("n1").values.__proto__));
assert.throws(() => F.parse(text(nested).replace('"10":true,"2":false', '"2":false,"10":true')), /Noncanonical/);
assert.throws(() => F.parse(text(nested).replace('"safe":null', '"safe":null,"safe":null')), /Noncanonical/);

const escaped = F.edit(sheet, {put: [{...sheet.get("n1"), text: '𐀀 é / "\\ \n\u2028', values: {"𐀀": true, "": false}}]});
assert.equal(text(F.parse(encoder.encode(text(escaped)))), text(escaped));
assert.throws(() => F.parse(text(escaped).replace("\\u2028", "\u2028")), /Noncanonical/);
assert.throws(() => F.parse(text(escaped).replace("\\u000a", "\\n")), /Noncanonical/);
assert.throws(() => F.parse(text(escaped).replace('"":false,"𐀀":true', '"𐀀":true,"":false')), /Noncanonical/);

const withDepth = depth => fixture("Power.wsch").replace('"text":"SENSE"', '"text":"SENSE","value":' +
  "[".repeat(depth) + "0" + "]".repeat(depth));
assert.equal(text(F.parse(withDepth(511))), withDepth(511));
assert.throws(() => F.parse(withDepth(512)), /nested too deeply/);

const crlfBytes = encoder.encode(fixture("Power.wsch").replace(/\n/g, "\r\n"));
const crlf = F.parse(crlfBytes);
assert.equal(crlf.transport, "crlf");
assert.equal(text(crlf), text(sheet));
assert.notEqual(F.sha256(crlfBytes), member.sha256);
const move = {put: [{...sheet.get("n1"), at: [1397000, 2540000]}]};
assert.equal(F.applyDelta(crlf, move).splices, null);
assert.equal(F.applyDelta(crlf, {}).file, crlf);
assert.equal(decoder.decode(F.serializePhysical(crlf)), decoder.decode(crlfBytes));
assert.equal(F.applyDelta(sheet, move).changedRows, 1);
assert.equal(F.applyDelta(sheet, move).splices.length, 1);
assert.equal(Object.hasOwn(F.edit(sheet, move).header, "requires"), false);

for (const kind of [...Object.keys(F.documentSuffix), "library"]) {
  const records = [{kind:"probe",id:"z"}, {kind:"probe",id:"a"}];
  const file = F.create({kind,formatVersion:F.FORMAT,id:"owner"},records);
  const wire = text(file), first = JSON.parse(wire.split("\n")[0]);
  assert.deepEqual(first, {kind,formatVersion:F.FORMAT,id:"owner",requires:[]});
  assert.deepEqual(Array.from(F.parse(wire).records(), row => row.id), ["a","z"]);
  assert.throws(() => F.parse(wire.replace('{"kind":"probe","id":"a"}\n{"kind":"probe","id":"z"}',
    '{"kind":"probe","id":"z"}\n{"kind":"probe","id":"a"}')), /unique and sorted/);
}
const contour = [{kind:"arc",c:[1270000,2540000],r:635000,start:82500000000,sweep:-45000000000}];
const preciseBoard = F.create({kind:"pcb",formatVersion:F.FORMAT,id:"board"},[
  {kind:"documentSetting",id:"geometry",key:"profile",value:contour},
]);
assert.deepEqual(F.parse(text(preciseBoard)).get("geometry").value, contour);

function patch(base, changes) {
  const input = F.serialize(base);
  const parts = [];
  let at = 0, length = 0;
  for (const {offset, remove, insert} of changes) {
    assert.ok(offset >= at);
    const prefix = input.subarray(at, offset), payload = encoder.encode(insert);
    parts.push(prefix, payload);
    length += prefix.length + payload.length;
    at = offset + remove;
  }
  parts.push(input.subarray(at));
  const out = new Uint8Array(length + input.length - at);
  at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return decoder.decode(out);
}
const pcb = F.create({kind: "pcb", formatVersion: "2.0", id: "pcb"}, [
  {kind: "part", id: "p2", at: [1000000, 4200000], ref: "A"},
  {kind: "part", id: "ξ", at: [2000000, 6500000], ref: "B"},
]);
let saved = pcb;
for (const n of [1, 2]) {
  const next = F.applyDelta(saved, {put: [{...saved.get("p2"), at: [1000000 + n * 127000, 4200000]}]});
  assert.equal(next.changedRows, 1);
  assert.equal(next.headerChanged, false);
  assert.equal(next.splices.length, 1);
  assert.equal(patch(saved, next.splices), text(next.file));
  assert.equal(saved.get("ξ"), next.file.get("ξ"), "unmodified rows are shared");
  assert.equal(Array.from(F.lines(saved)).filter((line, i) => line !== Array.from(F.lines(next.file))[i]).length, 1);
  saved = next.file;
}
const added = F.applyDelta(saved, {put: [{kind: "track", id: "tr", points: [[0, 0], [1000, 5]]}]});
assert.equal(added.splices[0].remove, 0);
assert.equal(patch(saved, added.splices), text(added.file));
assert.equal(pcb.get("p2").at[0], 1000000, "captured state remains unchanged");
assert.notEqual(F.projectDigest(manifest, [ {...member, sha256: F.sha256(F.serialize(F.edit(sheet, move)))} ]), F.projectDigest(manifest, [member]));

// A full write must keep row order, mixed line endings and opaque tokens on both sides of the tree.
const writeHeader = '{"kind":"pcb","formatVersion":"2.0","id":"board","requires":[]}\r\n';
const writeInput = writeHeader +
  '{"kind":"track","id":"a","width":100000}\n' +
  '{ "kind":"futureTrack", "id":"b", "payload":2e1 }\r\n' +
  '{"kind":"track","id":"\ue000","width":225000}\r\n' +
  '{"kind":"futureTrack","id":"\u{10000}","payload":"\\u0041"}\n';
const writeFile = F.parse(encoder.encode(writeInput), {knownKinds:["track"]});
const writeEdit = F.edit(writeFile, {put:[{...writeFile.get("\ue000"),width:250000}]});
const physicalText = file => decoder.decode(F.serializePhysical(file));
const editedInput = writeInput.replace("225000", "250000");
assert.equal(physicalText(writeFile), writeInput);
assert.equal(text(writeFile), writeInput.replace(/\r\n/g, "\n"));
assert.equal(physicalText(writeEdit), editedInput);
assert.equal(text(writeEdit), editedInput.replace(/\r\n/g, "\n"));
assert.equal(physicalText(F.parse(writeHeader)), writeHeader);

const future = F.parse(text(F.create({...sheet.header, formatVersion: "2.1"}, [
  {...sheet.get("n1"), unknownValue: {z: [0, "preserved"]}}, {id: "new", kind: "future"}])), {knownKinds: ["netlabel"]});
assert.equal(future.isOpaque("new"), true);
assert.throws(() => F.edit(future, {remove: ["new"]}), /newer reader/);
assert.match(text(F.edit(future, {put: [{...future.get("n1"), text: "N"}]})), /{"kind":"future","id":"new"}\n/);
const compatibleMajor = F.parse(text(F.create({...sheet.header, formatVersion: "3.0", compatibleWith: "2.0"}, [sheet.get("n1")])));
assert.equal(compatibleMajor.readOnly, true);
assert.throws(() => F.edit(compatibleMajor, move), /read-only/);
const opaqueBytes = '{"kind":"waveform","formatVersion":"2.1","id":"w1"}\n{"kind":"futureNode","id":"n2","value":"retained"}\n';
assert.throws(() => F.parse(opaqueBytes), /Unknown native file kind/);
const opaque = F.parse(opaqueBytes, {kind: "waveform", id: "w1", opaque: true});
assert.equal(opaque.readOnly, true);
assert.equal(text(opaque), opaqueBytes);
assert.throws(() => F.edit(opaque, {remove: ["n2"]}), /read-only/);
const futureReference = {kind: "document", id: "w1", docKind: "waveform", name: "Trace", path: "Trace.wwave"};
const futureProject = F.create({...manifest.header, formatVersion: "2.1"}, [...manifest.records(), futureReference]);
assert.deepEqual(F.manifestMembers(futureProject)[1], {path: "Trace.wwave", id: "w1", kind: "opaque", fileKind: "waveform", name: "Trace"});
assert.throws(() => F.manifestMembers(F.edit(manifest, {put: [futureReference]})), /Invalid manifest/);

const requiredHeader = {...sheet.header, requires:["sizing-v9", "new-pads"], readerRequires:{"sizing-v9":"2.8"}};
const requiring = F.canonical(requiredHeader) + "\n" + sheet.rawRecord("n1");
const locked = F.parse(requiring);
assert.equal(locked.readOnly, true);
assert.deepEqual(locked.unsupportedFeatures,[{token:"sizing-v9",minimumReaderVersion:"2.8"},
  {token:"new-pads",minimumReaderVersion:null}]);
assert.match(F.unsupportedMessage(locked), /sizing-v9\. A reader supporting native format 2\.8 is required.*new-pads\. The file declares native format 2\.0/);
assert.throws(() => F.edit(locked,move), /read-only/);
assert.throws(() => F.create(requiredHeader), /Unsupported required feature sizing-v9/);
assert.throws(() => F.edit(sheet,{header:requiredHeader}), /requires a newer reader/);
assert.throws(() => F.parse(F.canonical({...requiredHeader, readerRequires:{unlisted:"2.9"}})+"\n"), /required reader/);
assert.throws(() => F.parse(F.canonical({...requiredHeader, readerRequires:{"sizing-v9":"27.4.1"}})+"\n"), /formatVersion/);
assert.throws(() => F.parse(F.canonical({...requiredHeader, requires:["sizing-v9", "sizing-v9"]})+"\n"), /required feature list/);
const continued = F.canonical({...sheet.header, requires:["continuation-parts-v1"]}) + "\n";
assert.throws(() => F.parse(Uint8Array.from([...encoder.encode(continued), 255]), {features:["continuation-parts-v1"]}),
  error => error.code === "unsupported-feature" && error.message.includes("continuation-parts-v1"));

const permissive = {knownKinds:["netlabel"], nativeField(_kind, path) { return path[0] === "at" ? "integer" : undefined; }};
assert.throws(() => F.parse(fixture("Power.wsch").replace('"kind"', '"\\u006bind"'), permissive), /structural field/);
assert.throws(() => F.parse(fixture("Power.wsch").replace('"schematic"', '"schem\\u0061tic"'), permissive), /structural value/);
const extension = '"futureData" : { "z" : 1.20e2, "\\u0061": ["\\u0062", 1e400] }';
const label = '{"kind":"netlabel","id":"n1","at":[1270000,2540000],' + extension + ',"text":"SENSE"}\r\n';
const optional = '{ "id" : "zOpaque", "kind" : "futureRank", "order": null, "payload" : 99999999999999999999999 }\n';
const physicalHeader = sheet.rawRecord(sheet.header.id).replace(/}\n$/, String.raw`,"x-header": {"\ud800":"\udfff","mass":1e400}}`+"\r\n");
const mixed = physicalHeader + label + optional;
const retained = F.parse(encoder.encode(mixed),permissive);
assert.equal(retained.retainsSyntax, true);
assert.equal(retained.isOpaque("zOpaque"), true);
assert.equal(retained.readOnly, false);
assert.equal(retained.rawRecord("n1"),label);
assert.equal(retained.rawRecord("zOpaque"),optional);
assert.deepEqual(retained.projectRecord("n1").futureData,{z:120});
assert.equal(retained.get("n1").futureData.a[1],Infinity);
assert.throws(() => F.edit(retained,{remove:["zOpaque"]}), /newer reader/);
const tokens = F.rowTokens(retained,"n1"), token = tokens.entries.find(entry => entry.key === "futureData");
assert.equal(tokens.text.slice(token.begin,token.end),extension);
const editedRetained = F.edit(retained,{put:[{...retained.get("n1"),text:"NEW",order:"K"}]});
assert.equal(decoder.decode(F.serializePhysical(editedRetained)), mixed.replace('"text":"SENSE"','"text":"NEW","order":"K"'));
assert.equal(text(editedRetained), decoder.decode(F.serializePhysical(editedRetained)).replace(/\r\n/g,"\n"));
assert.throws(() => F.parse(mixed.replace('"z" : 1.20e2','"a" : 1.20e2'),permissive), /duplicate key/);
assert.throws(() => F.parse(mixed.replace('1270000,2540000','1270000.0,2540000'),permissive), /exact safe integer/);
assert.throws(() => F.parse(mixed.replace('1270000,2540000','1e400,2540000'),permissive), /exact safe integer/);

assert.deepEqual(U.length("0.00000254"), {value: 3, residual: {numerator: "-23", denominator: "50"}});
assert.equal(U.length("0.0000005").value, 0);
assert.equal(U.length("-0.0000015").value, -2);
assert.equal(U.length("0.0000025").value, 2);
assert.equal(U.angle("-90").value, 270000000000);
assert.equal(U.angle("-360", {signed: true}).value, -360000000000);
assert.equal(U.decimal("+001.250e-2"), "0.0125");
assert.equal(U.decimal("-0.000"), "0");
assert.equal(U.isDecimal("-0.01"), true);
assert.equal(U.isDecimal("0.10"), false);
assert.throws(() => U.length("9007199254.740992"), /interoperable/);

// Advance a deterministic edit stream through rotations, insertions, deletions and reuse.
let file = pcb, expected = new Map(Array.from(pcb.records(), record => [record.id, record]));
let seed = 17;
for (let index = 0; index < 200; index++) {
  seed = (seed * 48271) % 2147483647;
  const id = "track-" + seed % 51;
  const record = {id, kind: "track", points: [[index, 1], [seed, 2]], net: "µ"};
  const change = seed % 3 === 0 ? {remove: [id]} : {put: [record]};
  if (change.remove) expected.delete(id);
  else expected.set(id, record);
  const next = F.applyDelta(file, change);
  assert.equal(text(next.file), text(F.create(pcb.header, expected.values())));
  assert.equal(patch(file, next.splices), text(next.file));
  file = next.file;
}
console.log("format-2-codec: canonical, byte splices, version and exact unit vectors passed");
