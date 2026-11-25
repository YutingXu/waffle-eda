"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("./odb-read.cjs");
const {parseExcellon, parseGerber, compareDrills, compareFlashes, compareImages, gridFor, rasterize} = require("../formats/gerber-compare.cjs");

const {modules, entries, sources, fixture, canary} = JSON.parse(fs.readFileSync(0, "utf8"));
for (const [name, file] of modules) {
  if (name === "cfb") globalThis.CFB = require(file);
  else require(file);
}
for (const name of ["uuid-v7", "model", "parts", "source-file", "spatial", "connectivity", "pcb-pours",
  "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "impedance", "rigid-flex", "rules",
  "viastack", "board-shape", "board-shape-editing", "polygon-pour", "bom", "netlist", "variants", "fab-outputs",
  "panel", "vendor/zipjs-deflate", "odb-eda", "odb"]) require(require("./app-source-paths.cjs").appFile(name + ".js"));

function publicComponents(componentFile, eda) {
  const names = [...eda.matchAll(/^NET\s+(\S+)/gm)].map(match => match[1]);
  assert.match(componentFile, /^UNITS=MM$/m);
  assert.match(eda, /^UNITS=MM$/m);
  const result = [];
  for (const row of componentFile.split(/\r?\n/)) {
    const [op, ...args] = row.split(";")[0].trim().split(/\s+/);
    if (op === "CMP") {
      const [, x, y, rotation, mirror, ref] = args;
      result.push({ref, x:+x, y:+y, rotation:+rotation, mirrored:mirror === "M", pins:new Map()});
    }
    if (op === "TOP") {
      const [index, x, y, , , netIndex, , name] = args;
      assert.ok(names[+netIndex], "The public toeprint must reference a real net");
      result.at(-1).pins.set(+index, {name, x:+x, y:+y, net:names[+netIndex]});
    }
  }
  return result;
}

function compareComponents(reference, actual) {
  const byRef = new Map(actual.map(component => [component.ref, component]));
  let pinCount = 0, maxPinError = 0;
  const groups = new Set();
  assert.equal(reference.length, 2);
  assert.equal(actual.length, reference.length);
  for (const component of reference) {
    const match = byRef.get(component.ref);
    assert.ok(match, "Missing component " + component.ref);
    for (const field of ["x", "y", "rotation", "mirrored"]) assert.equal(match[field], component[field], component.ref);
    assert.equal(match.pins.size, component.pins.size);
    const actualPins = new Map([...match.pins.values()].map(pin => [pin.name, pin]));
    for (const pin of component.pins.values()) {
      const actual = actualPins.get(pin.name);
      assert.ok(actual, "Missing component pin " + component.ref + "." + pin.name);
      assert.equal(actual.net, pin.net, "Pin net differs on " + component.ref + "." + pin.name);
      maxPinError = Math.max(maxPinError, Math.hypot(actual.x - pin.x, actual.y - pin.y));
      groups.add(pin.net);
      pinCount++;
    }
  }
  assert.equal(pinCount, 4);
  assert.equal(groups.size, 3);
  assert.ok(maxPinError <= .005, "Toeprint centres exceed the archive's 0.01 mm coordinate precision");
  return {components:reference.length, pins:pinCount, nets:groups.size, maxPinErrorMm:maxPinError};
}

const {Atrium, AtriumTranslators, AtriumTranslatorProvenance, AtriumODB} = globalThis;
const files = Object.entries(sources).map(([name, text]) => ({name, bytes:Buffer.from(text)}));
const imported = AtriumTranslators.import(files, {name:canary ? "CANary" : "FixturFab sample", source_rules:"use"});
const project = Atrium.validate(AtriumTranslatorProvenance.toLegacy(imported.model, imported.provenance));
const doc = project.documents.find(row => row.kind === "pcb");
const built = AtriumODB.build(project, doc.id, {date:new Date("2026-11-22T12:00:00Z"), origin:"absolute"});
const result = R.read(built.bytes), step = result.steps.get("pcb");
const reference = file => entries["steps/pcb/" + file];

function compareProfile(bounds) {
  // The pinned KiCad profiles repeat their starting vertex once as a zero-length OS.
  const expectedProfile = R.profileOrFeatures(reference("profile"));
  assert.equal(expectedProfile.features.length, 1);
  assert.equal(expectedProfile.features[0].op, "S");
  assert.deepEqual(step.profile.bbox, bounds);
  assert.equal(R.layerXor(step.profile, expectedProfile, {pixel:.025}).differ, 0);
}

function fixturFab() {
  assert.match(entries["misc/info"], /^SAVE_APP=KiCad EDA 9\.99\.0-unknown$/m);
  assert.match(entries["misc/info"], /^UNITS=MM$/m);
  compareProfile([90,-110,130,-90]);
  assert.equal([...result.matrix.layers.values()].filter(layer => layer.type === "SIGNAL").length, 2);
  assert.equal([...result.matrix.layers.values()].some(layer => layer.type === "DRILL"), false);

  const layers = [];
  const films = [["f.cu","top"], ["b.cu","bottom"], ["f.mask","solder_mask_top"],
    ["b.mask","solder_mask_bottom"], ["f.paste","paste_top"], ["b.paste","paste_bottom"], ["f.silkscreen","silk_top"]];
  for (const [author, exported] of films) {
    const known = R.profileOrFeatures(reference("layers/" + author + "/features"));
    const observed = step.layers.get(exported);
    const grid = gridFor([known.bbox, observed.bbox], .004, .05, .371);
    const cmp = compareImages(rasterize(known.shapes,grid), rasterize(observed.shapes,grid), grid);
    // KiCad rounded pad and track coordinates to 0.01 mm. The Waffle output retains more precision.
    assert.ok(cmp.maxDev <= .012, author + " exceeds its geometric tolerance at " + cmp.maxDev + " mm");
    layers.push({layer:author, xorMm2:cmp.xorArea, maxEdgeDistanceMm:cmp.maxDev});
  }
  const components = publicComponents(reference("layers/comp_+_top/components"), reference("eda/data"));
  assert.equal(step.components.B.length, 0);
  const electrical = compareComponents(components, step.components.T);
  // The published file inherits its units and omits the unused $NONE$ net.
  const authorCadnet = reference("netlists/cadnet/netlist").replace(/^H [^\n]+/, header =>
    ["UNITS=MM", header, "$0 $NONE$"].join("\n"));
  const knownPoints = R.cadnet(authorCadnet, result.matrix, step.layers).points;
  const contacts = points => [...points].sort((a,b) => a.net.localeCompare(b.net) || a.x - b.x || a.y - b.y);
  const expectedContacts = contacts(knownPoints), observedContacts = contacts(step.electrical.points);
  assert.equal(expectedContacts.length, 4);
  assert.deepEqual(observedContacts.map(p => [p.net,p.side]), expectedContacts.map(p => [p.net,p.side]));
  const cadnetErrorMm = Math.max(...observedContacts.map((p,i) => Math.hypot(p.x - expectedContacts[i].x, p.y - expectedContacts[i].y)));
  assert.ok(cadnetErrorMm <= .005);
  console.log(JSON.stringify({fixture, profileMm:[40,20], layers, ...electrical, cadnetContacts:expectedContacts.length, cadnetErrorMm}));
}

function authorDrills(name, plated) {
  const source = entries[name];
  const data = parseExcellon(source);
  assert.match(source, /KiCad 10\.0\.4 date 2026-08-22/);
  assert.match(source, plated ? /TF\.FileFunction,Plated,1,4,PTH/ : /TF\.FileFunction,NonPlated,1,4,NPTH/);
  assert.equal(data.units, "mm");
  assert.deepEqual(data.warnings, []);
  for (const hole of [...data.hits, ...data.slots]) hole.plated = plated;
  return data;
}

function canaryDrills() {
  const early = R.profileOrFeatures(reference("layers/drill_plated_f.cu-b.cu/features"));
  assert.equal(early.features.length, 265);
  assert.ok(early.features.every(row => row.op === "P" && row.tool.round), "The older job has only round drill flashes");
  assert.doesNotMatch(entries["matrix/matrix"], /^\s*TYPE=ROUT$/m, "The older job has no routing layer");

  const round = step.layers.get("drill_plated").drill;
  const route = step.layers.get("rout_plated").drill;
  const nonPlated = step.layers.get("drill_nonplated").drill;
  assert.equal(round.slots.length, 0);
  assert.equal(route.hits.length, 0);
  for (const [name, type] of [["drill_plated","DRILL"], ["rout_plated","ROUT"], ["drill_nonplated","DRILL"]]) {
    const row = result.matrix.layers.get(name);
    assert.deepEqual([row.type,row.start,row.end], [type,"top","bottom"]);
  }

  const plated = authorDrills("dbcanary-PTH.drl", true);
  const npth = authorDrills("dbcanary-NPTH.drl", false);
  const metrics = [];
  for (const [known, observed, count] of [[plated,round,269], [npth,nonPlated,8]]) {
    const checked = compareDrills(known, observed, .001);
    assert.equal(checked.matched, count);
    assert.deepEqual([checked.missing,checked.extra,checked.wrong], [[],[],[]]);
    assert.ok(checked.maxDiaDev < .000001);
    metrics.push(checked.maxPosDev);
  }
  const pointOrder = (a,b) => a[0]-b[0] || a[1]-b[1];
  const slotOrder = (a,b) => pointOrder(a[0],b[0]) || pointOrder(a[1],b[1]);
  const slotEnds = data => data.slots.map(slot => [[slot.a,slot.b].sort(pointOrder),slot.d,slot.plated])
    .map(([ends,d,plated]) => [...ends,d,plated]).sort(slotOrder);
  assert.equal(plated.slots.length, 4);
  assert.deepEqual(slotEnds(route), slotEnds(plated), "Plated slot endpoints and tool diameter");
  assert.equal(npth.slots.length + nonPlated.slots.length, 0);
  return {olderRoundDrills:early.features.length, olderSlots:0, platedRoundDrills:round.hits.length,
    platedSlots:route.slots.length, nonPlatedRoundDrills:nonPlated.hits.length, maxHoleCenterErrorMm:Math.max(...metrics)};
}

function canaryApertures() {
  const comparisons = [["dbcanary-F_Mask.gts","solder_mask_top",354], ["dbcanary-B_Mask.gbs","solder_mask_bottom",49],
    ["dbcanary-F_Paste.gtp","paste_top",301]];
  return comparisons.map(([file, layer, count]) => {
    const known = parseGerber(entries[file]);
    assert.deepEqual(known.warnings, []);
    const flashes = step.layers.get(layer).features.map(row => {
      assert.equal(row.op, "P");
      return {dark:row.dark, shapes:row.geometry, ap:{type:"M"}};
    });
    const check = compareFlashes(known, {flashes}, .001);
    assert.equal(check.matched, count);
    assert.deepEqual([check.missing,check.extra,check.sizeOff], [[],[],[]]);
    return {layer, apertures:count, maxBoxErrorMm:check.maxSizeDev, maxCenterErrorMm:check.maxPosDev};
  });
}

if (canary) {
  assert.match(entries["misc/info"], /^SAVE_APP=KiCad EDA 10\.0\.4$/m);
  assert.match(entries["misc/info"], /^CREATION_DATE=20260804\./m);
  compareProfile([20,-100,120,-19]);
  const drills = canaryDrills();
  const apertures = canaryApertures();
  const silk = parseGerber(entries["dbcanary-F_Silkscreen.gto"]);
  assert.deepEqual(silk.warnings, []);
  const {differ,pixel} = R.layerXor(step.layers.get("silk_top"), silk, {pixel:.02});
  const frontSilkXorMm2 = differ * pixel * pixel;
  assert.ok(frontSilkXorMm2 < .02, "CANary front legend differs by " + frontSilkXorMm2 + " mm² on a 20 µm grid");
  console.log(JSON.stringify({fixture, profileMm:[100,81], ...drills, apertures, frontSilkXorMm2, frontSilkPixelMm:pixel}));
} else {
  fixturFab();
}
