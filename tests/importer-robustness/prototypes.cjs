"use strict";

const assert = require("node:assert/strict");

// Save descriptor values as well as keys. A change to an existing method or its
// attributes matters just as much as a new enumerable property.
const prototypes = [Object.prototype, Array.prototype, Function.prototype, Map.prototype, Set.prototype];
function snapshot() {
  return prototypes.map(p => [Object.getPrototypeOf(p), Object.getOwnPropertyDescriptors(p)]);
}
function unchanged(before) {
  for (const [i, proto] of prototypes.entries()) {
    const [parent, descriptors] = before[i], after = Object.getOwnPropertyDescriptors(proto);
    assert.strictEqual(Object.getPrototypeOf(proto), parent, "prototype chain changed");
    assert.deepEqual(Reflect.ownKeys(after), Reflect.ownKeys(descriptors), "changed keys on " + proto.constructor.name);
    for (const key of Reflect.ownKeys(after)) {
      const previous = descriptors[key], current = after[key];
      for (const field of ["value", "get", "set", "enumerable", "writable", "configurable"])
        assert.strictEqual(current[field], previous[field], proto.constructor.name + ".prototype." + String(key) + " changed " + field);
    }
  }
}
module.exports = {snapshot, unchanged};
