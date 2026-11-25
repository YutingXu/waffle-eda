"use strict";
// Measure the shared frame dispatcher at controlled 60/120 Hz without browser rendering.
const assert = require("node:assert/strict");
const {performance: hostClock} = require("node:perf_hooks");

let at = 0, next = null, sequence = 0;
globalThis.performance = {now: () => at};
globalThis.requestAnimationFrame = fn => {
  assert.equal(next,null,"the clock requests only one display callback");
  next = {fn,id:++sequence};
  return next.id;
};
globalThis.cancelAnimationFrame = id => { if (next?.id === id) next = null; };
require("../../app/editor/editor-motion.js");
const M = globalThis.AtriumMotion;

function run(hz, count, n) {
  const samples = [], frameMs = 1000 / hz, owner = {};
  let checksum = 0;
  const start = index => M.choreograph(owner,String(index),{camera:index === 0,
    ease:index % 2 ? "decelerate" : "standard",step:progress => { checksum += progress; }});
  for (let i = 0; i < n + 10; i++) {
    for (let t = 0; t < count; t++) start(t);
    let kicked = false;
    const began = at;
    while (next) {
      at += frameMs;
      const {fn} = next;
      next = null;
      const since = hostClock.now();
      fn(at);
      const elapsed = hostClock.now() - since;
      if (i >= 10) samples.push(elapsed);
      if (!kicked && at - began >= 65) { start(0); kicked = true; }
    }
    assert.equal(M.active(),0);
    const last = start(0);
    assert.ok(next);
    last.cancel();
    assert.equal(next,null,"the last cancelled track leaves no idle callback");
  }
  assert.ok(checksum > 0);
  samples.sort((a,b) => a - b);
  const round = ms => Math.round(ms * 1000) / 1000;
  return {controlledHz:hz,tracks:count,frames:samples.length,p95Ms:round(samples[Math.ceil(samples.length*.95)-1]),
    maxMs:round(samples.at(-1)),idleCallbacks:next === null ? 0 : 1};
}

console.log(JSON.stringify([60,120].flatMap(hz => [1,8,32].map(tracks => run(hz,tracks,100))),null,2));
