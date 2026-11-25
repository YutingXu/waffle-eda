"use strict";
const assert = require("node:assert/strict");
require("../../app/canvas/frame-monitor.js");
const {createSampler} = globalThis.AtriumFrameMonitor;

function harness() {
  let time = 100, next = 1, latest;
  const callbacks = new Map(), canvas = {}, other = {};
  const targets = new Map([canvas, other].map(view => [view, {view, docId: "pcb", camera: {cx: 4, cy: 7, scale: 10}}]));
  const sampler = createSampler({
    now: () => time, timeOrigin: 1000000,
    captureTarget: canvas => targets.get(canvas),
    request(callback) { const id = next++; callbacks.set(id, callback); return id; },
    cancel(id) { assert.ok(callbacks.delete(id)); },
    publish(sample) { latest = sample; }
  });
  return {sampler, callbacks, canvas, other, targets, sample: () => latest, time: () => time,
    advance(ms) { time += ms; },
    tick(ms) {
      time += ms;
      assert.equal(callbacks.size, 1, "exactly one sampler callback");
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id); callback(time);
    }
  };
}

for (const hz of [60, 120]) {
  const h = harness(), {sampler, canvas, callbacks} = h, frame = 1000 / hz;
  assert.equal(callbacks.size, 0, "constructing the sampler does no work");
  sampler.trace.draw(canvas, 101, 102);
  assert.equal(callbacks.size, 0, "recording while disabled does no work");
  sampler.setVisible(true);
  h.tick(0);
  for (let i = 0; i < hz / 2; i++) h.tick(frame);
  assert.ok(Math.abs(h.sample().reference - frame) < 1e-6, "the reference follows the callback cadence");
  h.tick(frame * 1.49); h.tick(frame * 1.51); h.tick(frame * 3);
  while (callbacks.size) h.tick(frame);
  const result = h.sample();
  assert.equal(result.state, "idle");
  assert.equal(result.draws, 0);
  assert.equal(result.spikes, 2);
  assert.equal(result.missed, 3);
  assert.ok(result.mean > frame && result.mean < frame * 1.1);
  assert.ok(result.p95 >= frame - 1e-6 && result.p95 < frame * 1.6);
  assert.equal(callbacks.size, 0, "an idle editor parks the sampling clock");

  h.advance(10000);
  const first = h.time();
  sampler.trace.wheel(canvas, first - 10);
  sampler.trace.wheel(canvas, first - 5);
  sampler.trace.draw(h.other, first, first + 2);
  h.advance(3);
  sampler.trace.draw(canvas, first + 3, first + 4);
  sampler.trace.draw(canvas, first + 5, first + 6);
  sampler.trace.commit(first + 6, first + 9);
  sampler.trace.editTask(first + 9, first + 11);
  h.tick(frame);
  assert.equal(h.sample().state, "measuring");
  assert.equal(h.sample().draws, 3);
  assert.equal(h.sample().wheel.p95, 14, "the oldest contributing input goes to the first draw of the same canvas");
  assert.equal(h.sample().draw.p95, 2);
  assert.equal(h.sample().commit.p95, 3);
  assert.equal(h.sample().task.p95, 2);
  assert.equal(h.sample().spikes, 0, "parked time does not count as missed callbacks");
  assert.equal(h.sample().mean, null, "the first callback after a wake has no preceding gap");

  sampler.trace.wheel(canvas, 1000000 + h.time());
  sampler.setVisible(false);
  assert.deepEqual(h.sample(), {state: "paused"});
  assert.equal(callbacks.size, 0, "pausing cancels the pending callback");
  const hiddenAt = h.time();
  h.advance(10000);
  sampler.trace.draw(canvas, hiddenAt, h.time());
  sampler.trace.wheel(canvas, h.time());
  assert.equal(callbacks.size, 0, "hidden activity does not wake the clock");
  sampler.setVisible(true);
  assert.equal(h.sample().wheel.last, null, "a visibility change resets pending input and samples");
  const resumedAt = h.time();
  sampler.trace.wheel(canvas, hiddenAt);
  sampler.trace.wheel(canvas, Infinity);
  sampler.trace.wheel(canvas, resumedAt + 10);
  sampler.trace.draw(canvas, resumedAt, resumedAt + 1);
  h.tick(frame * 20);
  assert.equal(h.sample().wheel.last, null, "old, future and nonfinite event timestamps are ignored");

  const trustedStamp = h.time();
  sampler.trace.wheel(canvas, 1000000 + trustedStamp);
  h.advance(5);
  sampler.trace.draw(canvas, trustedStamp + 5, trustedStamp + 8);
  h.tick(frame * 40);
  assert.ok(Math.abs(h.sample().wheel.last - 8) < 1e-6, "epoch timestamps are converted to the frame clock origin");
  sampler.setVisible(false);
  assert.equal(callbacks.size, 0, "closing drains the last sampler callback");
}
for (const [intervals, hz] of [[[16, 17, 17], 60], [[8, 8, 9], 120]]) {
  const h = harness(), {sampler, canvas} = h;
  sampler.setVisible(true);
  h.tick(0);
  for (let i = 0; i < 120; i++) {
    sampler.trace.draw(canvas, h.time(), h.time());
    h.tick(intervals[i % intervals.length]);
  }
  assert.equal(Math.round(1000 / h.sample().reference), hz, "quantization preserves the nominal reference cadence");
  assert.equal(h.sample().missed, 0);
  const changed = hz === 60 ? [8, 8, 9] : [16, 17, 17], newHz = hz === 60 ? 120 : 60;
  for (let i = 0; i < 120; i++) {
    sampler.trace.draw(canvas, h.time(), h.time());
    h.tick(changed[i % changed.length]);
  }
  assert.equal(Math.round(1000 / h.sample().reference), newHz, "a coherent quantized cadence shift rebaselines");
  assert.equal(h.sample().missed, 0);
}

{
  const h = harness(), {sampler, canvas, targets} = h, original = targets.get(canvas);
  sampler.setVisible(true);
  h.advance(1);
  sampler.trace.wheel(canvas, h.time());
  targets.set(canvas, {...original, docId: "sheet"});
  sampler.trace.draw(canvas, h.time(), h.time() + 4);
  h.tick(260);
  assert.equal(h.sample().wheel.last, null, "an intervening document switch on the same canvas cannot consume wheel latency");

  sampler.trace.wheel(canvas, h.time());
  targets.set(canvas, {...original, docId: "sheet", camera: {...original.camera, scale: 3}});
  sampler.trace.draw(canvas, h.time(), h.time() + 4);
  h.tick(260);
  assert.equal(h.sample().wheel.last, null, "an intervening camera restoration cannot consume wheel latency");

  sampler.trace.wheel(canvas, h.time());
  sampler.clearWheel();
  sampler.trace.draw(canvas, h.time(), h.time() + 4);
  h.tick(260);
  assert.equal(h.sample().wheel.last, null, "a same-id replacement clears unpainted wheel input");
}

{
  const h = harness(), {sampler, canvas} = h;
  const period = hz => 1000 / hz;
  const step = interval => {
    // Keep the editor working through a change of cadence.
    sampler.trace.draw(canvas, h.time(), h.time());
    h.tick(interval);
  };
  sampler.setVisible(true);
  h.tick(0);
  for (let i = 0; i < 70; i++) step(period(120));
  assert.ok(Math.abs(h.sample().reference - period(120)) < 1e-6);
  // A brief slow burst still reports missed callbacks.
  for (let i = 0; i < 5; i++) step(period(60));
  for (let i = 0; i < 30; i++) step(period(120));
  assert.equal(h.sample().missed, 5);
  assert.ok(Math.abs(h.sample().reference - period(120)) < 1e-6);
  for (let i = 0; i < 60; i++) step(period(60));
  assert.ok(Math.abs(h.sample().reference - period(60)) < 1e-6, "a stable 120 to 60 Hz shift rebaselines");
  assert.equal(h.sample().missed, 0, "intervals from the previous reference are removed");
  step(period(60) * 2);
  for (let i = 0; i < 20; i++) step(period(60));
  assert.equal(h.sample().missed, 1, "a slow callback still counts after rebaselining");
  for (let i = 0; i < 120; i++) step(period(120));
  assert.ok(Math.abs(h.sample().reference - period(120)) < 1e-6, "faster stable cadence also rebaselines");
  assert.equal(h.sample().missed, 0);
}

{
  const h = harness(), {sampler, canvas} = h;
  sampler.setVisible(true);
  h.tick(0);
  for (let i = 0; i < 1024; i++) sampler.trace.draw(canvas, h.time(), h.time());
  h.tick(300);
  assert.equal(h.sample().draws, 512, "the rolling sample buffer has a fixed capacity under load");
}
console.log("PASS frame monitor 60/120 Hz thresholds and rebaselining, canvas attribution, idle and hidden cancellation");
