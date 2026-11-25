"use strict";
// A visible paint can request an expensive pour index. Hiding the window or turning on
// Efficiency invalidates the queued work, and no job restarts without a fresh paint demand.
const assert = require("node:assert/strict");
let visible = true, efficient = false, listener, time = 0, next = 0, builds = 0;
const idle = new Map();
globalThis.performance = {now: () => time};
globalThis.AtriumPower = {idle: () => efficient || !visible, onChange: fn => { listener = fn; }};
globalThis.AtriumIdle = {idle(fn) { idle.set(++next,fn); return next; }, cancel(id) { idle.delete(id); }};
globalThis.AtriumPCBPours = {contours() { builds++; return []; }};
require("../../app/canvas/canvas-fast.js");
const F = AtriumCanvasFast, region = {count:256,bounds:[0,0,64,64]}, view = [1,1,3,3];

F.pourRings(region,view);
assert.equal(idle.size,1);
let queued = idle.values().next().value;
visible = false;
listener({visible,efficient});
queued();
assert.equal(idle.size,0);
assert.equal(builds,0);

visible = true;
efficient = true;
listener({visible,efficient});
F.pourRings(region,view);
assert.equal(idle.size,0);

efficient = false;
listener({visible,efficient});
assert.equal(idle.size,0);
F.pourRings(region,view);
F.releasePours([region],[region]);
assert.equal(idle.size,1);
F.releasePours([region],[]);
assert.equal(idle.size,0);

F.pourRings(region,view);
queued = idle.get(next);
idle.delete(next);
time = 300;
queued();
assert.equal(builds,1);
assert.equal(idle.size,0);

console.log("PASS pour indexing follows visible demand, Efficiency and region lifetime");
