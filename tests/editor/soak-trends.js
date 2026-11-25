"use strict";

// Compare like-for-like post-GC checkpoints and active rendering over the final half of the run.
// The median of pairwise slopes resists transient pauses without hiding sustained growth.
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)];
const median = values => percentile(values, .5);

function assess(samples, seconds, model, stepLimit) {
  const tail = samples.filter(s => s.t >= seconds / 2);
  const failures = [];
  if (tail.length < 5 || tail.at(-1).t - tail[0].t < seconds * .4) {
    return {failures: ["insufficient coverage of the final half"], tailSamples: tail.length};
  }
  const gaps = samples.map((s, i) => s.t - (samples[i - 1]?.t || 0));
  const maxGap = Math.max(...gaps);
  if (maxGap > (seconds === 300 ? 45 : 90)) failures.push("gap between measured editing checkpoints: " + maxGap.toFixed(1) + " seconds");
  const length = Math.floor(tail.length / 2), early = tail.slice(0, length), late = tail.slice(-length);
  const trends = {};
  function check(key, tolerance, enforce = true) {
    const slopes = [];
    for (let j = 1; j < tail.length; j++) for (let i = 0; i < j; i++) {
      slopes.push((tail[j][key] - tail[i][key]) / (tail[j].t - tail[i].t));
    }
    const from = median(early.map(s => s[key])), to = median(late.map(s => s[key]));
    const projectedGrowth = median(slopes) * (seconds / 2);
    trends[key] = {from, to, projectedGrowth, tolerance, enforced: enforce};
    if (enforce && (to - from > tolerance || projectedGrowth > tolerance)) failures.push(key + " increased beyond " + tolerance);
  }
  check("heapMiB", 6);
  check("domNodes", 64);
  check("detachedNodes", 8);
  // Below both limits a new undoable edit deliberately adds storage. Test the store's upper
  // bounds at every checkpoint and its steady-state trend once the history has filled.
  const full = s => s.steps >= stepLimit || s.undoBytes >= s.undoBudget;
  check("undoBytes", 128 * 1024, full(tail[0]));
  if (samples.some(s => s.steps > stepLimit || (s.undoBytes > s.undoBudget && s.steps > 1))) {
    failures.push("undo store exceeded its configured retention bounds");
  }
  check("workers", 0);
  check("frameP95", Math.max(2, .2 * median(early.map(s => s.frameP95))));
  const frameP95 = percentile(tail.flatMap(s => s.frames), .95);
  if (frameP95 > 34) failures.push("sustained " + model + " pan p95 exceeds 34 ms");
  // The irreducible current-model shadow can exceed a deliberately small history setting.
  const excess = Math.max(0, ...samples.map(s => s.undoBytes - Math.max(s.undoBudget, s.shadowBytes)));
  const history = {budgetBytes: samples[0].undoBudget, stepLimit, peakSteps: Math.max(...samples.map(s => s.steps)),
    peakBytes: Math.max(...samples.map(s => s.undoBytes)), firstAtLimitSecond: samples.find(full)?.t ?? null};
  return {tailSamples: tail.length, firstTailSecond: tail[0].t, lastSecond: tail.at(-1).t,
    frameP95, maxGap, history, maxUndoExcessBytes: excess, trends, failures};
}

module.exports = {assess, percentile};
