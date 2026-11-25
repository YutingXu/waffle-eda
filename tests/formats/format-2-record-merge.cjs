"use strict";

const assert = require("node:assert/strict");
require("../../app/project/source-file.js");
require("../../app/project/obsolete-project.js");
require("../../app/formats/format-2-codec.js");
require("../../app/formats/format-2-units.js");
require("../../app/formats/format-2-values.js");
require("../../app/formats/format-2-model.js");
require("../../app/formats/import-sidecars.js");
require("../../app/formats/format-2-closure.js");
require("../../app/project/folder-project-engine.js");
require("../../app/formats/format-2-git.js");
require("../../app/history/merge3.js");
const F = globalThis.AtriumFormat2;
const {mergeRecords, run} = globalThis.AtriumFormat2Git;
const M3 = globalThis.AtriumMerge3;

const sheet = {kind:"schematic", formatVersion:"2.0", id:"sheet", requires:[]};
const label = (id, fields = {}) => ({kind:"label", id, at:[0, 0], text:"A", ...fields});
const line = row => F.canonical(row) + "\n";
const contents = (header, ...rows) => line(header) + rows.sort((a, b) => F.compare(a.id, b.id)).map(line).join("");
const clean = (base, ours, theirs, wanted) => assert.deepEqual(mergeRecords(base, ours, theirs), {text:wanted, conflicts:[]});

const baseline = contents(sheet, label("item"), label("remove"));
const left = contents(sheet, label("item", {at:[4, 2]}), label("left"));
const right = contents(sheet, label("item", {text:"B"}), label("remove"), label("right"));
const expected = contents(sheet, label("item", {at:[4, 2], text:"B"}), label("left"), label("right"));
clean(baseline, left, right, expected);
clean(baseline, right, left, expected);
clean(baseline, left, left, left);
clean(baseline, baseline, "", "");
clean("", left, left, left);

const sortedOurs = contents(sheet, label("Z"), label("\u{10000}"));
const sortedTheirs = contents(sheet, label("a"), label("\ue000"));
clean(contents(sheet), sortedOurs, sortedTheirs, contents(sheet, label("Z"), label("a"), label("\ue000"), label("\u{10000}")));

const conflict = (base, ours, theirs, id, fields = []) => {
  const merged = mergeRecords(base, ours, theirs);
  assert.equal(merged.text, null);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].id, id);
  assert.deepEqual(merged.conflicts[0].fields, fields);
};
conflict(baseline, left, contents(sheet, label("item", {at:[9, 2]}), label("remove")), "item", ["at"]);
conflict(baseline, left, contents(sheet, label("item", {angle:3}), label("remove")), "item", ["angle", "at"]);
conflict(baseline, left, contents(sheet, label("item"), label("remove", {text:"Changed"})), "remove");
conflict(baseline, left, contents(sheet, label("item"), label("remove"), label("left", {text:"Same ID"})), "left");
conflict(baseline, left, contents({...sheet, id:"another"}), "sheet");
conflict(baseline, left, contents({...sheet, formatVersion:"2.1"}), "sheet");

const board = {kind:"pcb", formatVersion:"2.0", id:"board"};
const resistor = (fields = {}) => contents(board, {kind:"part", id:"resistor", at:[10_000_000, 10_000_000],
  angle:0, layer:"Top", def:"resistor-top", ref:"R1", value:"10k", ...fields});
const bottom = {layer:"Bottom", def:"resistor-bottom"}, rotated = {angle:270_000_000_000};
clean(resistor(), resistor(bottom), resistor(rotated), resistor({...bottom, ...rotated}));
clean(resistor(), resistor(rotated), resistor(bottom), resistor({...bottom, ...rotated}));
const moved = {at:[12_000_000, 10_000_000]}, labelOffset = {valueAt:[1_000_000, 2_000_000]};
clean(resistor(), resistor(moved), resistor(rotated), resistor({...moved, ...rotated}));
clean(resistor(), resistor(labelOffset), resistor(moved), resistor({...labelOffset, ...moved}));
conflict(resistor(), resistor(moved), resistor({at:[10_000_000, 14_000_000]}), "resistor", ["at"]);
conflict(resistor(), resistor({value:"22k"}), resistor({value:"47k"}), "resistor", ["value"]);
conflict(resistor(), resistor({...bottom, ...rotated}), resistor({angle:180_000_000_000}), "resistor", ["angle"]);
conflict(resistor(), resistor({mirror:true}), resistor(rotated), "resistor", ["angle", "mirror"]);

const continued = {...sheet, formatVersion:"2.1", "x-owner":{opaque:"\u00e9"}};
const future = {kind:"futureThing", id:"other", coordinates:[123, 456], "x-content":{"escaped":"æ\r\n"}};
const original = contents(continued, label("item", {"x-row":[true, "ø"]}), future);
const ours = contents({...continued, entryPoint:"Top"}, label("item", {"x-row":[true, "ø"], text:"New"}), future);
const theirs = contents(continued, label("item", {"x-row":[false, "ø"]}), future, label("same"));
clean(original, ours, theirs,
  contents({...continued, entryPoint:"Top"}, label("item", {"x-row":[false, "ø"], text:"New"}), future, label("same")));
conflict(original, contents(continued, label("item"), {...future, x:1}),
  contents(continued, label("item"), {...future, y:1}), "other");

const extension = ' "x-bytewise" : { "escaped":"\\u0061", "number":9007199254740997321 } ';
const opaque = '{"kind":"futureThing","id":"opaque", "data":[1.20e4,"\\u0061"]}\n';
const withExactFields = (record, rawExtension = extension) => line(continued) +
  line(record).slice(0, -2) + "," + rawExtension + "}\n" + opaque;
clean(withExactFields(label("item")), withExactFields(label("item", {at:[8, 0]})),
  withExactFields(label("item", {text:"B"}), extension.replace("9007199254740997321", "9007199254740997999")),
  withExactFields(label("item", {at:[8, 0], text:"B"}), extension.replace("9007199254740997321", "9007199254740997999")));
const partWithExactFields = fields => resistor(fields).replace('"2.0"', '"2.1"').slice(0, -2) +
  "," + extension + "}\n" + opaque.replace('"opaque"', '"z-opaque"');
clean(partWithExactFields(), partWithExactFields(bottom), partWithExactFields(rotated),
  partWithExactFields({...bottom, ...rotated}));

const crlf = text => text.replace(/\n/g, "\r\n");
clean(crlf(baseline), crlf(left), crlf(right), crlf(expected));

const project = {kind:"project", formatVersion:"2.0", id:"project", name:"Project"};
const member = id => ({kind:"document", id, docKind:"schematic", name:"Sheet", path:"Sheet.wsch"});
conflict(contents(project), contents(project, member("a")), contents(project, member("b")), "project");
assert.throws(() => mergeRecords(contents(sheet), contents(sheet), "invalid\n"), /Invalid JSON/);
assert.throws(() => mergeRecords(contents(sheet), contents(sheet), contents(sheet), "pcb"), /file kind/);

async function reviewStage(inputs, formatVersion, document = sheet) {
  const encoder = new TextEncoder(), objects = {};
  function put(text) {
    const bytes = encoder.encode(text), hash = F.sha256(bytes);
    objects[hash] = bytes;
    return hash;
  }
  const manifest = "Project.waffle", name = document.kind === "pcb" ? "Board" : "Sheet", path = name + F.documentSuffix[document.kind];
  const root = put(contents({...project, formatVersion}, {...member(document.id), docKind:document.kind, name, path}));
  const revisions = ["base", "ours", "theirs"].map((revision, index) => {
    const doc = put(inputs[index]);
    return {revision, blob:doc, manifest, files:{[manifest]:root, [path]:doc}};
  });
  return (await run({bundle:{objects, revisions}, reviewStages:[{path, stages:["base", "ours", "theirs"]}]})).value;
}

(async () => {
  const competing = contents(sheet, label("item", {angle:3}), label("remove"));
  const review = await reviewStage([baseline, left, competing], "2.0");
  assert.equal(review.exact, false);
  assert.deepEqual(review.atomic.map(({owner, id, fields}) => ({owner, id, fields})),
    [{owner:"sheet", id:"item", fields:["angle", "at"]}]);
  assert.equal(review.stages[0].project.documents[0].id, "sheet");
  assert.deepEqual(await reviewStage([original, ours, theirs], "2.1"), {exact:true});
  const separate = await reviewStage([resistor(), resistor(bottom), resistor(rotated)], "2.0", board);
  assert.deepEqual(separate.atomic, []);
  const reviewMerge = review => M3.merge(...review.stages.map(stage => stage.project), {nativeConflicts:review.atomic});
  const cleanPart = reviewMerge(separate);
  assert.equal(cleanPart.conflicts.length, 0);
  assert.deepEqual(cleanPart.project.documents[0].items.map(({layer, angle}) => [layer, angle]), [["Bottom", 90]]);
  const partReview = await reviewStage([resistor(), resistor({...bottom, ...rotated}), resistor({angle:180_000_000_000})], "2.0", board);
  assert.equal(partReview.exact, false);
  assert.deepEqual(partReview.atomic.map(({owner, id, fields}) => ({owner, id, fields})),
    [{owner:"board", id:"resistor", fields:["angle"]}]);
  const reviewed = reviewMerge(partReview);
  const chosen = M3.resolve(reviewed, {[reviewed.conflicts[0].id]:"theirs"});
  assert.deepEqual(chosen.documents[0].items.map(({layer, angle}) => [layer, angle]), [["Bottom", 180]]);
  const E = globalThis.AtriumFolderProjectEngine, encode = text => new TextEncoder().encode(text);
  const manifestRaw = contents(project, {...member("other"), name:"Other",path:"Other.wsch"});
  const manifest = {path:"Project.waffle", bytes:encode(manifestRaw), sha256:F.sha256(encode(manifestRaw))};
  const edited = E.dataOf(encode(left)), current = {path:"Sheet.wsch", bytes:encode(crlf(left)), sha256:F.sha256(encode(crlf(left)))};
  const owner = {id:"sheet",kind:"schematic",reference:line(member("sheet"))};
  const request = {path:"Sheet.wsch", owner, edited, manifest, current};
  assert.deepEqual((await run({resolveOwner:{...request,chooseEdit:false}})).value, []);
  const restore = (await run({resolveOwner:{...request,chooseEdit:true}})).value;
  assert.deepEqual(restore.map(({path,expected}) => ({path,expected})), [{path:manifest.path,expected:manifest.sha256}]);
  assert.equal(new TextDecoder().decode(E.bytesOf(restore[0])), manifestRaw + owner.reference);
  const recreate = (await run({resolveOwner:{...request,current:null,chooseEdit:true}})).value;
  assert.deepEqual(recreate[0], {path:"Sheet.wsch",expected:null,data:edited});
  await assert.rejects(run({resolveOwner:{...request,current:{...current,bytes:encode(right)},chooseEdit:true}}), /changed on disk/);
  await assert.rejects(run({resolveOwner:{...request,path:"Unrelated.wsch",chooseEdit:true}}), /membership changed/);
  console.log("Native record merge preserves independent edits, ordering, opaque data, and original conflict inputs.");
})();
