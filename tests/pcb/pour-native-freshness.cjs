"use strict";

// Stored copper stays current through the steps an unchanged imported board takes: moving its
// provenance out of the working copy, a native save and a reopen. A stale verdict on any of them
// hides the stored fill and starts a background repour that replaces it.
const assert = require("node:assert/strict");
for (const name of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "impedance",
  "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "design-query-record",
  "query", "net-intent", "signals", "rules", "viastack", "polygon-pour"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {nativeRoundTrip} = require("../support/native-cad.cjs");
const A = Atrium, P = AtriumPolygonPour, R = AtriumPCBPours, S = AtriumSignals;
const rect = (x, y, X, Y) => [[x, y], [X, y], [X, Y], [x, Y]];
const pcb = p => p.documents.find(d => d.kind === "pcb");
const defs = p => new Map(p.library.map(d => [d.id, d]));

function board() {
  const p = A.project("Fresh"), d = pcb(p);
  // Imported sizes fall between native nanometres (Altium's 1/10000 mil grid).
  d.outline = rect(0, 0, 40.0000127, 30.0000254);
  const def = {id: "fp", kind: "component", name: "R", footprint: {name: "R0603", pads: [
    {number: "1", x: -.7500013, y: 0, w: .8000025, h: .9, shape: "rect", layer: "Top", sourceDrillTool: 0},
    {number: "2", x: .7500013, y: 0, w: .8000025, h: .9, shape: "rect", layer: "Top", sourceDrillTool: 0},
  ], shapes: []}};
  p.library.push(def);
  d.items = [
    {kind: "part", id: "u1", def: "fp", ref: "R1", x: 20.0000127, y: 15.0000127, angle: 0, layer: "Top", pinNets: {1: "VCC", 2: "GND"}},
    {kind: "via", id: "v1", x: 10.0000038, y: 10.0000038, diameter: .6000013, drill: .3000006, layer: "Multi", net: "GND"},
    {kind: "track", id: "t1", layer: "Top", net: "VCC", width: .2540001, points: [[5.0000013, 25.0000013], [18.0000025, 15.0000127]]},
    P.make(rect(1.0000013, 1.0000013, 39.0000025, 29.0000038), {id: "gnd", net: "GND", layer: "Top"}),
  ];
  S.attach(p);
  P.apply(d, defs(p), {project: p, reuse: false});
  R.storeSignature(d, defs(p), p);
  assert.deepEqual(P.stale(d, defs(p), {project: p}), [], "poured");
  assert.equal(P.state(d, defs(p), {project: p}), "source");
  return p;
}

// Drill-drawing symbols are provenance (translator-provenance.js separate moves them out). Copper does not read them.
{
  const p = board(), d = pcb(p);
  for (const pad of p.library[0].footprint.pads) delete pad.sourceDrillTool;
  assert.deepEqual(P.stale(d, defs(p), {project: p}), [], "removing drill symbols leaves the pour current");
  assert.ok(R.matchesSignature(d, defs(p), p), "removing drill symbols leaves the board stamp current");
  p.library[0].footprint.pads[0].w = .9;
  assert.deepEqual(P.stale(d, defs(p), {project: p}), ["gnd"], "a pad size change still makes the pour stale");
}

// The native format stores integer nanometres and nanodegrees. Reopening an unchanged board reads
// different doubles; the saved pour certificates and board stamp are for the values it reads.
{
  const p = board(), reopened = nativeRoundTrip(p), d = pcb(reopened);
  assert.notEqual(d.items.find(i => i.id === "v1").x, 10.0000038, "the fixture really rounds");
  S.attach(reopened);
  assert.deepEqual(P.stale(d, defs(reopened), {project: reopened}), [], "pour current after reopen");
  assert.equal(P.state(d, defs(reopened), {project: reopened}), "source", "stored copper shown after reopen");
  assert.ok(R.matchesSignature(d, defs(reopened), reopened), "board stamp current after reopen (canvas before the pour engine loads)");
  const again = nativeRoundTrip(reopened);
  assert.equal(pcb(again).sourcePourSignature, d.sourcePourSignature, "a second save keeps the stamp");
  d.items.find(i => i.id === "v1").x += .5;
  assert.equal(P.state(d, defs(reopened), {project: reopened}), "stale", "an edit after reopen is still noticed");
}

// Hatch artwork arrives as source tracks, without a contour table. Saving a verified hatch
// certifies those tracks against the native geometry. Edited hatches keep their old stamp.
{
  const p = A.project("Hatch"), d = pcb(p);
  d.outline = rect(0, 0, 12.0000013, 12);
  d.pcbDrawing = {annotations: {}, sourceFill: true};
  d.items = [P.make(rect(1, 1, 10, 10), {id: "hatch", net: "GND", layer: "Top", fillMode: "hatched"}),
    {kind: "track", id: "hatch-track", sourcePour: "hatch", layer: "Top", net: "GND", width: .2, points: [[2, 2], [9, 2]]}];
  R.storeSignature(d, defs(p), p);
  assert.ok(A.validate(p), "the fixture is a valid imported hatch");
  assert.ok(R.matchesSignature(d, defs(p), p), "the source hatch verifies before saving");
  const reopened = nativeRoundTrip(p), saved = pcb(reopened);
  assert.equal(saved.outline[1][0], 12.000001, "the hatch board dimensions round on save");
  assert.equal(saved.items.find(i => i.id === "hatch-track").sourcePour, "hatch");
  assert.deepEqual(P.stale(saved, defs(reopened), {project: reopened}), [], "the stored hatch stays current after reopening");
  assert.equal(saved.sourceHatchSignature, undefined, "the hatch stamp belongs inside the drawing");

  const malformed = A.clone(p);
  delete pcb(malformed).pcbDrawing.sourceFill;
  assert.throws(() => A.validate(malformed), /Invalid Waffle editor model/, "a raw hatch stamp needs its source-fill marker");

  d.items.find(i => i.id === "hatch-track").width += .05;
  const edited = nativeRoundTrip(p), stale = pcb(edited);
  assert.equal(stale.pcbDrawing.sourceHatchSignature, d.pcbDrawing.sourceHatchSignature, "save retains the stale nested stamp");
  assert.equal(stale.sourceHatchSignature, undefined);
  assert.deepEqual(P.stale(stale, defs(edited), {project: edited}), ["hatch"], "saving an edited hatch does not certify it");
}

// Signals enter the stamp by name: a project that stores its classes natively (with its own IDs)
// and one that derives them from imported class records have the same copper inputs.
{
  const p = A.project("Signals"), d = pcb(p), library = new Map();
  d.sourceClasses = ["RECORD=Class|NAME=PWR|KIND=0|SUPERCLASS=FALSE|M0=VCC|M1=GND",
    "RECORD=Class|NAME=USB|KIND=6|SUPERCLASS=FALSE|M0=USB_P|M1=USB_N"];
  d.items = [{kind: "track", id: "t", layer: "Top", net: "VCC", width: .2, points: [[0, 0], [1, 0]]}];
  p.rules = {version: 3, units: "mm", list: [{id: "r1", type: "clearance", name: "c", gap: .3,
    scope: {languageVersion: 1, source: 'object.net = "VCC" and object.layer = "Top"'}}]};
  S.attach(p);
  const derived = R.signature(d, library, p);
  p.signals = A.clone(S.fromLegacy(p));
  for (const s of p.signals.signals || []) s.id = "native-" + s.id;
  assert.equal(R.signature(d, library, p), derived, "native signal storage does not change the stamp");
  d.sourceClasses = d.sourceClasses.slice(0, 1); delete p.signals;
  assert.notEqual(R.signature(d, library, p), derived, "a class change still does");
}
console.log("pour-native-freshness: ok");
