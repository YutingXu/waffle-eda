"use strict";

const assert = require("node:assert/strict");
require("../../app/core/model.js");
const {create, isV7} = AtriumUUID;
const timestamp = id => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
const maxTail = (1n << 74n) - 1n;

// RFC 9562 Appendix A.6 checks the time, version, variant and both random fields.
const vector = create(() => 1645557742000, () => 0xcc3n << 62n | 0x18c4dc0c0c07398fn);
assert.equal(vector(), "017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
assert.equal(vector(), "017f22e2-79b0-7cc3-98c4-dc0c0c073990");
assert.equal(isV7("017f22e2-79b0-4cc3-98c4-dc0c0c07398f"), false);
assert.equal(isV7("017f22e2-79b0-7cc3-48c4-dc0c0c07398f"), false);

let now = 42;
const rolling = create(() => now, () => maxTail);
const first = rolling();
assert.equal(first, "00000000-002a-7fff-bfff-ffffffffffff");
now = 12;
const second = rolling();
assert.ok(second > first);
assert.equal(timestamp(second), 43, "rollback and random-counter exhaustion advance without waiting");
now = 50;
assert.equal(timestamp(rolling()), 50, "the logical clock converges with wall time");
const last = create(() => 0xffffffffffff, () => maxTail);
assert.equal(timestamp(last()), 0xffffffffffff);
assert.throws(last, /timestamp and counter exhausted/);
assert.throws(create(() => NaN, () => 0n), /Invalid UUIDv7 timestamp/);
const noEntropy = create(() => 42, () => { throw Error("No entropy"); });
assert.throws(noEntropy, /No entropy/);
assert.throws(noEntropy, /No entropy/, "a failed seed leaves the clock uninitialized for retry");
let seeds = 0;
const exhausted = create(() => 42, () => {
  if (seeds++) throw Error("No entropy");
  return maxTail;
});
exhausted();
assert.throws(exhausted, /No entropy/);
assert.throws(exhausted, /No entropy/, "a failed seed leaves the clock and counter at their previous boundary");

const ids = Array.from({length: 2048}, () => Atrium.id());
assert.ok(ids.every(isV7));
assert.deepEqual(ids, [...new Set(ids)].sort());
assert.ok(Math.abs(timestamp(ids[0]) - Date.now()) < 1000);

const project = Atrium.project("Durable identity");
assert.ok([project.id, ...project.documents.map(doc => doc.id)].every(isV7));
const frame = {id: Atrium.id(), kind: "textframe", x: 0, y: 0, text: "Draft"};
project.documents[0].items.push(frame);
const before = Atrium.clone(project);
frame.text = "Edited";
assert.equal(frame.id, before.documents[0].items[0].id);
assert.equal(Atrium.clone(before).documents[0].items[0].id, frame.id);
assert.notEqual(Atrium.id(), frame.id, "an actual copy gets a new identity");

const digest = "a".repeat(64);
const snapshotIds = () => Atrium.withRevisionIds(digest, () => [Atrium.id(), Atrium.id()]);
assert.deepEqual(snapshotIds(), snapshotIds(), "repeated read-only history projection remains deterministic");
assert.throws(() => Atrium.withRevisionIds(digest, () => { throw Error("aborted"); }), /aborted/);
assert.ok(isV7(Atrium.id()), "leaving the read-only revision restores the durable allocator");

console.log("UUIDv7 layout, ordering, rollback, overflow, fresh durable identities and history separation passed");
