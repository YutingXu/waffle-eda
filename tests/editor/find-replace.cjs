"use strict";
// Find and Replace Text (find-replace.js): fields, scope, case / whole word / regex, and
// Replace All across sheets as one edit.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "find-replace"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, F = AtriumFindReplace, S = AtriumSchObjects;
const R = AtriumParts.catalogue.find(d => d.id === "std-r");
const p = A.project("FR", AtriumParts.catalogue), top = p.documents[0], child = A.sheet("schematic", "Child");
p.documents.push(child);
const part = (doc, ref, value, extra = {}) => {const i = {...A.instantiate(p, R, [0, 0]), ref, value, ...extra}; doc.items.push(i); return i;};
const r1 = part(top, "R1", "10k", {parameters:{Tolerance:"1%", MPN:"RC0603FR-0710KL"}});
const r2 = part(child, "R2", "10K");
const lbl = {id:A.id(), kind:"netlabel", x:0, y:0, text:"SDA_1"}; top.items.push(lbl);
const port = S.make("port", [5, 5], {text:"SDA_IN", io:"input"}); child.items.push(port);
const txt = {id:A.id(), kind:"label", x:0, y:0, text:"Use 10k pull-ups on SDA"}; top.items.push(txt);
const frame = S.make("textframe", [0, 0], {w:10, h:5, text:"10k\nsecond line"}); child.items.push(frame);

// 1. Scope and fields.
let hits = F.search(p, {query:"10k", scope:"doc", docId:top.id});
assert.deepEqual(hits.map(h => h.label).sort(), ["Comment", "MPN", "Text"], "current sheet: comment, the MPN parameter and text");
hits = F.search(p, {query:"10k", scope:"project"});
assert.equal(hits.length, 5, "whole project adds R2's comment and the text frame");
assert.equal(F.search(p, {query:"10k", scope:"project", matchCase:true}).length, 3, "match case drops 10K");
assert.equal(F.search(p, {query:"10k", scope:"project", fields:{comments:false, parameters:false}}).length, 2, "categories filter");
assert.equal(F.search(p, {query:"R1", scope:"project", fields:{comments:false, parameters:false, labels:false, text:false}})[0].label, "Designator");
assert.equal(F.search(p, {query:"10k", scope:"selection", selection:[r1.id], docId:top.id}).length, 2, "selection scope");

// 2. Whole word and regex.
assert.equal(F.search(p, {query:"SDA", scope:"project", wholeWord:true, fields:{labels:true}}).filter(h => h.field === "labels").length, 0, "SDA is not a whole word in SDA_1 or SDA_IN");
assert.equal(F.search(p, {query:"SDA", scope:"project", wholeWord:true}).length, 1, "but it is in the text");
const re = F.search(p, {query:"^SDA_(\\w+)$", scope:"project", regex:true});
assert.deepEqual(re.map(h => h.text).sort(), ["SDA_1", "SDA_IN"]);
assert.throws(() => F.search(p, {query:"(", regex:true, scope:"project"}), /Invalid regular expression/);

// 3. Replace All with regex groups changes every sheet in one call.
const before = JSON.stringify(p);
const n = F.replace(p, re, "I2C_SDA_$1", {query:"^SDA_(\\w+)$", regex:true});
assert.equal(n, 2); assert.equal(lbl.text, "I2C_SDA_1"); assert.equal(port.text, "I2C_SDA_IN");
// Literal replacement treats $ as text.
F.replace(p, F.search(p, {query:"10k", scope:"project"}), "4k7$", {query:"10k"});
assert.equal(r1.value, "4k7$"); assert.equal(r2.value, "4k7$"); assert.equal(r1.parameters.MPN, "RC0603FR-074k7$L");
assert.equal(txt.text, "Use 4k7$ pull-ups on SDA"); assert.equal(frame.text, "4k7$\nsecond line");
assert.notEqual(JSON.stringify(p), before);
// A designator is never replaced by an empty name.
assert.equal(F.replace(p, F.search(p, {query:"R1", scope:"project"}), "", {query:"R1"}), 0); assert.equal(r1.ref, "R1");
A.validate(A.clone(p));
console.log("PASS find-replace: fields, scopes, case, whole word, regex and Replace All");
