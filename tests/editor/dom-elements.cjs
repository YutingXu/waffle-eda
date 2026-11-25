"use strict";

const assert = require("node:assert/strict");

// These modules also load in headless tools which supply neither a document nor UI.
require("../../app/core/model.js");
require("../../app/formats/bom.js");
require("../../app/history/diff-props.js");
assert.equal(globalThis.document, undefined);
assert.equal(globalThis.AtriumNavCommon, undefined);
assert.equal(AtriumBOM.compress(["R1", "R2", "R3"]), "R1-R3");
assert.equal(AtriumDiffProps.valueText(false), "false");

require("../../app/editor/nav-common.js");
const {el, elementIn, classedElement, elWithAttributes} = AtriumNavCommon;
const makeDocument = () => ({createElement(tag) {
  const writes = [];
  return {tag, ownerDocument:this, writes,
    set textContent(value) { writes.push(["text", value]); },
    set className(value) { writes.push(["class", value]); },
    setAttribute(name, value) { writes.push([name, value]); }};
}});

const owner = makeDocument(), original = makeDocument();
globalThis.document = original;
assert.equal(el("span").ownerDocument, original, "the default document is read at call time");
globalThis.document = makeDocument();
assert.equal(el("span").ownerDocument, globalThis.document);
assert.deepEqual(el("span", 0, "warning").writes, [["text", 0], ["class", "warning"]]);
assert.deepEqual(el("span", false, "").writes, [["text", false]]);
for (const absent of [null, undefined]) assert.deepEqual(el("span", absent, "").writes, []);

const node = elementIn(owner, "span", "Title", "tone");
assert.equal(node.ownerDocument, owner);
assert.deepEqual(node.writes, [["text", "Title"], ["class", "tone"]]);
assert.deepEqual(classedElement(owner, "span", "tone", "Title").writes, [["class", "tone"], ["text", "Title"]]);
assert.equal(AtriumDiffProps.glyph(owner, "added").ownerDocument, owner);

const attrs = {"data-empty":null, "data-undefined":undefined, "data-boolean":false, "data-zero":0};
assert.deepEqual(elWithAttributes("input", null, "control", attrs).writes, [["class", "control"], ...Object.entries(attrs)]);
assert.deepEqual(elWithAttributes("input", null, "control", attrs, {omitNull:true}).writes,
  [["class", "control"], ["data-boolean", false], ["data-zero", 0]]);
delete globalThis.document;
console.log("PASS DOM creators preserve their document, property order, null attributes and headless loads");
