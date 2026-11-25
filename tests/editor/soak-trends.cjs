"use strict";
const assert = require("node:assert/strict");
const {assess} = require("./soak-trends.js");

// Unit tests for the gate using constructed numbers. The real browser workload is a separate CI job.
const rows = Array.from({length: 26}, (_, i) => ({
  t: i * 12, heapMiB: Math.min(i, 10) + 100, domNodes: 4000, detachedNodes: 2, workers: 0,
  steps: 500, undoBytes: 6e6, shadowBytes: 5e6, undoBudget: 64 * 1048576, frameP95: 16.7, frames: Array(24).fill(16.7)
}));
const failures = values => assess(values, 300, "schematic", 500).failures;
assert.deepEqual(failures(rows), [], "warm-up growth is outside the final half");

for (const [metric, perSample] of Object.entries({
  heapMiB: 1, domNodes: 10, detachedNodes: 2, undoBytes: 20000, workers: 1, frameP95: .5
})) {
  const growing = rows.map((s, i) => ({...s, [metric]: s[metric] + Math.max(0, i - 12) * perSample}));
  assert.ok(failures(growing).some(message => message.startsWith(metric + " increased")), metric);
}
const buildingHistory = rows.map((s, i) => ({...s, steps: i + 1, undoBytes: s.undoBytes + i * 20000}));
assert.deepEqual(failures(buildingHistory), [], "normal undo history grows until a limit");
assert.ok(failures(rows.map(s => ({...s, undoBytes: s.undoBudget + 1}))).some(message => message.includes("bounds")));
const slow = rows.map(s => ({...s, frames: Array(24).fill(40), frameP95: 40}));
assert.ok(failures(slow).some(message => message.includes("pan p95")), "consistently slow frames");
assert.ok(failures(rows.slice(0, 13)).length, "missing tail");
assert.ok(failures([...rows.slice(0, 15), ...rows.slice(20)]).some(message => message.includes("gap")), "interrupted session");
console.log("PASS editing soak warm-up, retained resources, frame budgets and wall-clock coverage");
