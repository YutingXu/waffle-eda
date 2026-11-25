"use strict";

const assert = require("node:assert/strict");
const now = typeof performance !== "undefined" ? () => performance.now()
  : typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();

// Check correctness in measure() before returning its timings. Only the explicit
// budget verdict can cause a retry. Recreate any state that cached results could affect.
function retryTiming(measure, overBudget, retry = measure) {
  const first = measure();
  const why = overBudget(first);
  if (!why) return first;

  const second = retry(first);
  const again = overBudget(second);
  if (again) assert.fail(why + " on the first attempt; " + again + " on the retry");
  console.log("timing retry passed after " + why);
  return second;
}

// A busy host can interrupt different pointer moves on each pass. Pair the two
// measurements by input so each move has one chance to confirm its timing.
function retrySamples(measure, overBudget) {
  return retryTiming(measure, overBudget, first => {
    const second = measure();
    assert.equal(second.length, first.length);
    return first.map((ms, index) => Math.min(ms, second[index]));
  });
}

// These operations are synchronous. The Node clock measures CPU spent on the
// test's thread, so scheduling delays do not count toward the throughput budget.
const cpuNow = typeof process.threadCpuUsage === "function" ? () => {
  const {user, system} = process.threadCpuUsage();
  return (user + system) / 1000;
} : now;

function calibrationSlice(seed) {
  for (let i = 0; i < 1_000_000; i++) seed = Math.imul(seed + i, 1664525) ^ (seed >>> 13);
  return seed;
}

// JSC has a wall clock only. The fastest tenth of fixed CPU slices estimates
// an uninterrupted slice. The mean includes time given to competing processes.
function loadFactor() {
  let seed = 1;
  for (let i = 0; i < 32; i++) seed = calibrationSlice(seed);
  const samples = [];
  for (let i = 0; i < 96; i++) {
    const start = now();
    seed = calibrationSlice(seed);
    samples.push(now() - start);
  }
  assert.equal(seed, -2136148743);
  samples.sort((a, b) => a - b);
  const uninterrupted = samples[9];
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
  return uninterrupted > 0 ? Math.max(1, mean / uninterrupted) : 1;
}

function checkThroughput(measure, label, budget) {
  const run = () => measure(cpuNow);
  return retryTiming(run, ({ms, load = 1}) => {
    const adjusted = ms / load;
    return adjusted < budget ? "" : label + " " + adjusted.toFixed(1) + " ms (budget < " + budget + " ms)";
  }, () => {
    if (cpuNow !== now) return run();
    const before = loadFactor(), result = run();
    const load = Math.min(before, loadFactor());
    console.log("timing calibration: " + result.ms.toFixed(1) + " ms wall, " + load.toFixed(2) + "× load");
    return {...result, load};
  });
}

module.exports = {now, cpuNow, retryTiming, retrySamples, checkThroughput};
