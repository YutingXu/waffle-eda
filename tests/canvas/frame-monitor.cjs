"use strict";
const assert = require("node:assert/strict");
require("../../app/canvas/frame-monitor.js");
const {createSampler} = globalThis.AtriumFrameMonitor;

function harness() {
  let time = 100, next = 1, latest, activity = 0, clockReads = 0;
  const callbacks = new Map(), canvas = {}, other = {};
  const targets = new Map([canvas, other].map(view => [view, {view, docId: "pcb", camera: {cx: 4, cy: 7, scale: 10}}]));
  const sampler = createSampler({
    now: () => { clockReads++; return time; }, timeOrigin: 1000000,
    captureTarget: canvas => targets.get(canvas),
    request(callback) { const id = next++; callbacks.set(id, callback); return id; },
    cancel(id) { assert.ok(callbacks.delete(id)); },
    publish(sample) { latest = sample; },
    publishActivity() { activity++; }
  });
  return {sampler, callbacks, canvas, other, targets, sample: () => latest, activity: () => activity, time: () => time,
    clockReads: () => clockReads,
    advance(ms) { time += ms; },
    tick(ms) {
      time += ms;
      assert.equal(callbacks.size, 1, "exactly one sampler callback");
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id); callback(time);
    }
  };
}

{
  const h = harness(), {sampler, callbacks, canvas} = h;
  sampler.refreshActivity();
  assert.equal(callbacks.size, 0, "closed monitors ignore activity");
  sampler.setVisible(true);
  h.tick(1000);
  const idle = h.sample();
  sampler.refreshActivity();
  sampler.refreshActivity();
  h.tick(10000);
  assert.equal(h.activity(), 1, "terminal work coalesces into one passive refresh");
  assert.equal(h.sample(), idle, "a passive refresh preserves the last frame sample");
  assert.equal(callbacks.size, 0, "a passive refresh does not restart cadence");
  sampler.refreshActivity();
  sampler.trace.draw(canvas, h.time(), h.time() + 2);
  h.tick(16);
  assert.equal(h.activity(), 1, "a draw promotes the pending refresh to the normal sampler");
  assert.equal(h.sample().draw.p95, 2);
  h.tick(1000);
  sampler.refreshActivity();
  sampler.setVisible(false);
  assert.equal(callbacks.size, 0, "hiding cancels a pending passive refresh");
}

for (const hz of [60, 120]) {
  const h = harness(), {sampler, canvas, callbacks} = h, frame = 1000 / hz;
  assert.equal(callbacks.size, 0, "constructing the sampler does no work");
  sampler.trace.draw(canvas, 101, 102);
  sampler.trace.commit(101, 103);
  sampler.trace.editTask(103, 106);
  assert.equal(callbacks.size, 0, "recording while disabled does no work");
  assert.equal(h.sample(), undefined, "recording while disabled produces no sample");
  sampler.setVisible(true);
  assert.equal(h.sample().commit.p95, null);
  assert.equal(h.sample().task.p95, null);
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
  assert.equal(h.sample().p95, null, "callback interval p95 needs two callbacks in the sampled window");

  sampler.trace.wheel(canvas, 1000000 + h.time());
  sampler.setVisible(false);
  assert.deepEqual(h.sample(), {state: "paused"});
  assert.equal(callbacks.size, 0, "pausing cancels the pending callback");
  const hiddenAt = h.time();
  h.advance(10000);
  sampler.trace.draw(canvas, hiddenAt, h.time());
  sampler.trace.wheel(canvas, h.time());
  sampler.trace.commit(hiddenAt, h.time());
  sampler.trace.editTask(hiddenAt, h.time());
  assert.equal(callbacks.size, 0, "hidden activity does not wake the clock");
  sampler.setVisible(true);
  assert.equal(h.sample().wheel.last, null, "a visibility change resets pending input and samples");
  assert.equal(h.sample().commit.p95, null, "pausing clears sampled edit commits");
  assert.equal(h.sample().task.p95, null, "pausing clears sampled edit follow-up work");
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
  const h = harness(), {sampler, canvas, other, targets} = h;
  sampler.trace.wheel(canvas, 100, 101, "dom-event");
  assert.equal(h.clockReads(), 0, "off-path wheel tracing never reads the clock");
  sampler.setVisible(true);
  h.tick(0);
  h.advance(20);
  sampler.trace.wheel(canvas, 105, 110, "dom-event");
  h.advance(12);
  sampler.trace.wheel(canvas, 1000000 + 100, 131, "native-wheel-replay");
  h.advance(1);
  const pane = targets.get(canvas);
  targets.set(canvas, {...pane, camera: {...pane.camera, scale: 20}});
  sampler.trace.wheel(canvas, 112, 129, "dom-event");
  sampler.trace.draw(other, 132, 133);
  sampler.trace.draw(canvas, 133, 134);
  sampler.trace.draw(canvas, 137, 140);
  h.tick(270);
  assert.deepEqual(h.sample().wheel, {p95: 34, last: 34, tail: {
    stampSource: "native-wheel-replay", stampToHandlerMs: 31, handlerToDrawMs: 2, drawMs: 1
  }}, "the earliest contributor keeps its own provenance and handler through the first matching draw");
  while (h.callbacks.size) h.tick(16);
  assert.equal(h.sample().state, "idle");
  assert.equal(h.sample().wheel.p95, 34, "the parked monitor retains its last sampled window");
  const idleReads = h.clockReads();
  h.advance(5000);
  assert.equal(h.clockReads(), idleReads);

  sampler.setVisible(false);
  const pausedReads = h.clockReads();
  sampler.trace.wheel(canvas, h.time(), h.time(), "dom-event");
  assert.equal(h.clockReads(), pausedReads, "a hidden monitor does not sample a wheel receipt");
  assert.equal(h.callbacks.size, 0);
  sampler.setVisible(true);
  assert.deepEqual(h.sample().wheel, {p95: null, last: null, tail: null}, "restoring starts a fresh wheel window");
  h.advance(10);
  const instant = h.time();
  sampler.trace.wheel(canvas, instant - 5, instant + 1, "dom-event");
  sampler.trace.draw(canvas, instant, instant + 2);
  h.tick(270);
  assert.deepEqual(h.sample().wheel, {p95: 7, last: 7, tail: null}, "unknown handler chronology keeps the total only");
}

{
  const h = harness(), {sampler, canvas} = h;
  sampler.setVisible(true);
  h.tick(0);
  for (let i = 0; i < 20; i++) {
    const [delivery, wait, draw] = i === 5 ? [29, 1, 1] : i === 15 ? [4, 9, 7] : [1, 7, 2];
    const stamp = h.time();
    h.advance(delivery);
    sampler.trace.wheel(canvas, stamp, h.time(), "dom-event");
    h.advance(wait);
    sampler.trace.draw(canvas, h.time(), h.time() + draw);
    h.tick(draw + 1);
  }
  h.tick(270);
  assert.deepEqual(h.sample().wheel, {p95: 20, last: 10, tail: {
    stampSource: "dom-event", stampToHandlerMs: 4, handlerToDrawMs: 9, drawMs: 7
  }}, "the breakdown is one ranked total sample instead of independent component percentiles");
}

{
  const h = harness(), {sampler, canvas, targets} = h, original = targets.get(canvas);
  sampler.setVisible(true);
  h.advance(1);
  sampler.trace.wheel(canvas, h.time(), h.time(), "dom-event");
  targets.set(canvas, {...original, docId: "sheet"});
  sampler.trace.draw(canvas, h.time(), h.time() + 4);
  h.tick(260);
  assert.equal(h.sample().wheel.last, null, "an intervening document switch on the same canvas cannot consume wheel latency");
  assert.equal(h.sample().wheel.tail, null, "a stale pane does not publish breakdown details");

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
