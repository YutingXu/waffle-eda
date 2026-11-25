"use strict";

const assert = require("node:assert/strict");
const unitMm = .00000254;
const toleranceMm = .005;

// A Pads6 record contains the name, three metadata blocks, the pad
// geometry, and its extension.
function* pads6(streams) {
  const bytes = streams.get("pads6/data") || streams.get("pads/data");
  if (!bytes?.length) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  function block() {
    const start = cursor + 4;
    assert(start <= bytes.length, "incomplete pad block header");
    cursor = start + (view.getUint32(cursor, true) & 0xffffff);
    assert(cursor <= bytes.length, "incomplete pad block");
    return [start, cursor - start];
  }
  while (cursor < bytes.length) {
    assert.equal(bytes[cursor++], 2, "invalid pad record type");
    for (let i = 0; i < 4; i++) block();
    const [pad, padSize] = block(), [extension, extensionSize] = block();
    yield {bytes, view, pad, padSize, extension, extensionSize};
  }
}

// Independently recover the physical drill slot directly from the source,
// in absolute manufacturing coordinates (Y up).
function source(streams) {
  const slots = [];
  for (const {bytes, view, pad, padSize, extension, extensionSize} of pads6(streams)) {
    if (padSize < 60 || extensionSize < 275 || bytes[extension + 262] !== 2) continue;
    const d = unitMm * view.getInt32(pad + 45, true);
    const length = unitMm * view.getInt32(extension + 263, true);
    const angle = (view.getFloat64(pad + 52, true) + view.getFloat64(extension + 267, true)) * Math.PI / 180;
    if (!(d > 0 && length > d && Number.isFinite(angle))) continue;
    const x = unitMm * view.getInt32(pad + 13, true), y = unitMm * view.getInt32(pad + 17, true);
    const dx = Math.cos(angle) * (length - d) / 2, dy = Math.sin(angle) * (length - d) / 2;
    slots.push({a:[x - dx, y - dy], b:[x + dx, y + dy], d});
  }
  return slots;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function measure(pads, generated, [ox, oy]) {
  const seenSlots = new Set(), seenHits = new Set();
  for (const s of pads) {
    const transform = ([x, y]) => [x - ox, y + oy];
    const a = transform(s.a), b = transform(s.b);
    const sameTool = p => Math.abs(s.d - p.d) <= toleranceMm;
    const slot = generated.slots.findIndex((p, i) => !seenSlots.has(i) && sameTool(p) &&
      Math.min(Math.max(dist(a, p.a), dist(b, p.b)), Math.max(dist(a, p.b), dist(b, p.a))) <= toleranceMm);
    if (slot >= 0) seenSlots.add(slot);
    const centre = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const hit = generated.hits.findIndex((p, i) => !seenHits.has(i) && sameTool(p) && dist(centre, [p.x, p.y]) <= toleranceMm);
    if (hit >= 0) seenHits.add(hit);
  }
  return {sourcePadSlots:pads.length, matched:seenSlots.size, unmatched:generated.slots.length - seenSlots.size,
    slotsStillRound:seenHits.size};
}

module.exports = {source, measure, pads6, unitMm};

if (require.main === module) {
  const {parseExcellon} = require("../formats/gerber-compare.cjs");
  const pad = {a:[18, 5], b:[19, 5], d:.5};
  const reading = line => parseExcellon("M48\nMETRIC,TZ\nT1C0.5\n%\nT1\n" + line + "\nM30\n");
  const frame = [10, -5];
  const actual = measure([pad], reading("X9.0Y0.0G85X8.0Y0.0"), frame);
  assert.deepEqual(actual, {sourcePadSlots:1, matched:1, unmatched:0, slotsStillRound:0});
  const round = measure([pad], reading("X8.5Y0.0"), frame);
  assert.deepEqual(round, {sourcePadSlots:1, matched:0, unmatched:0, slotsStillRound:1});
  const incorrect = measure([pad], reading("X8.0Y0.0G85X9.5Y0.0"), frame);
  assert.deepEqual(incorrect, {sourcePadSlots:1, matched:0, unmatched:1, slotsStillRound:0});
  const doubled = measure([pad], reading("X8.0Y0.0G85X9.0Y0.0\nX8.0Y0.0G85X9.0Y0.0"), frame);
  assert.equal(doubled.unmatched, 1);
}
