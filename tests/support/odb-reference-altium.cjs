"use strict";

// This reference is the ODB++ 8.0 release written by Altium Designer. Plotting
// uses the independent acceptance reader and strips vendor presentation attributes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const R = require("./odb-read.cjs"), CAM = require("../formats/gerber-compare.cjs");
const {modules,source,vendor:V,ipc356,omitUnconnectedMidLayerPads} = JSON.parse(fs.readFileSync(0, "utf8"));
const app = path.join(__dirname, "../../app");
const G = globalThis;
G.AtriumTranslatorTable = JSON.parse(fs.readFileSync(path.join(app, "translators.json"), "utf8"));
for (const [name,file] of modules) {
  if (name === "cfb") G.CFB = require(file);
  else require(file);
}
require(path.join(app, "formats/translator-manufacturing.js"));

const sourceName = path.basename(source);
const opened = G.AtriumTranslators.import([{name:sourceName,bytes:fs.readFileSync(source)}], {source_rules:"use"});
const board = opened.model.documents.find(doc => doc.kind === "pcb");
assert.ok(board);
const native = G.AtriumNetlist.extract(opened.model, {source:"pcb",board:board.id});
const options = {fileStem:board.name,date:new Date("2026-11-22T12:00:00Z"),origin:"absolute",drillOrigin:"shared",
  drillDrawing:false,drillReport:false,pnp:false,readme:false,assemblyTop:false,assemblyBottom:false,
  odbEnabled:true,provenance:opened.provenance,omitUnconnectedMidLayerPads};
const fabrication = G.AtriumTranslators.export("fabrication", opened.model, options);
const archives = G.AtriumTranslators.export("odb", opened.model, options);
assert.equal(archives.files.length, 1);
assert.ok(!archives.details.warnings.some(w => w.includes("filled again")), "Export must retain the verified source copper fills");
const built = archives.files[0].bytes, exported = R.read(built), pcb = exported.steps.get("pcb");
const films = new Map(fabrication.files.map(f => [f.name, f.text]));
function film(suffix) {
  const content = films.get(board.name + suffix);
  assert.equal(typeof content, "string", "Missing fabrication film " + suffix);
  return content;
}
const gerber = suffix => CAM.parseGerber(film(suffix), {chord:.0005});
const STEP = "steps/pcb/";
const copperTypes = new Set(["SIGNAL","MIXED","POWER_GROUND"]);
const vendorLayers = [...V["matrix/matrix"].matchAll(/^LAYER\s*\{([^}]+)\}/gm)].map(([,body]) =>
  Object.fromEntries(body.trim().split(/\r?\n/).map(field => field.trim().split("="))));
const referenceLayers = new Map(vendorLayers.map(layer => [layer.NAME.toLowerCase(),layer]));
assert.deepEqual(vendorLayers.filter(layer => copperTypes.has(layer.TYPE)).map(layer => layer.NAME),
  ["TOP_COPPER","GND","SUPPLY","BOT_COPPER"]);
assert.deepEqual([...exported.matrix.layers.values()].filter(layer => copperTypes.has(layer.type)).map(layer => layer.name),
  ["top","inner_1","inner_2","bottom"]);
const layer = (name, file = "features") => V[STEP + "layers/" + name + "/" + file];
const mm = x => Number(x) * 25.4;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const max = values => Math.max(0, ...values);
const round = n => Number(n.toFixed(7));
const rows = value => value.split(/\r?\n/).map(row => row.trim()).filter(row => row.length && !row.startsWith("#"));
const xy = (tokens, start) => [mm(tokens[start]), mm(tokens[start + 1])];
const print = row => console.log(JSON.stringify(row));
const encodeNet = name => name.replace(/[^!-:<-~]|\\/g, encodeURIComponent);
const sameNet = (a, b) => a === b || encodeNet(a) === b;

function vendorComponents() {
  const nets = rows(V[STEP + "eda/data"]).filter(row => row.startsWith("NET ")).map(row => row.slice(4));
  assert.equal(nets[0], "$NONE$");
  return ["top", "bot"].flatMap(side => {
    let part;
    const parts = [];
    for (const row of rows(layer("comp_+_" + side, "components"))) {
      const [op, ...col] = row.split(";")[0].trim().split(/\s+/);
      if (op === "CMP") {
        part = {ref:col[5],side,at:xy(col, 1),pins:[]};
        parts.push(part);
      }
      if (op === "TOP") {
        assert.ok(col[7].startsWith(part.ref + "-") && nets[+col[5]] !== undefined, row);
        part.pins.push({name:col[7].slice(part.ref.length + 1),at:xy(col, 1),net:nets[+col[5]]});
      }
    }
    return parts;
  });
}

const sourceComponents = vendorComponents();
const waffleComponents = [...pcb.components.T.map(c => ({...c,side:"top"})), ...pcb.components.B.map(c => ({...c,side:"bot"}))];
const sameRef = new Map(waffleComponents.map(c => [decodeURIComponent(c.ref), c]));
const anchor = sourceComponents.find(c => c.ref === "MP105");
assert.ok(anchor);
const anchorWaffle = sameRef.get(anchor.ref);
const rawShift = [anchorWaffle.x - anchor.at[0], anchorWaffle.y - anchor.at[1]];
const translation = rawShift.map(x => Number(x.toFixed(3)));
assert.ok(distance(translation, rawShift) < .00001, "Translation must reproduce the named coordinate anchor");
const shift = at => at.map((value, i) => value + translation[i]);
const shapeShift = shape => {
  if (shape.k === "poly") return {...shape,rings:shape.rings.map(ring => ring.map(shift))};
  if (shape.k === "circle") {
    const [x,y] = shift([shape.x, shape.y]);
    return {...shape,x,y};
  }
  const [x1,y1] = shift([shape.x1, shape.y1]), [x2,y2] = shift([shape.x2, shape.y2]);
  return {...shape,x1,y1,x2,y2};
};
const plot = shapes => ({shapes,bbox:CAM.bboxOf(shapes)});

function vendorPlot(text, profile = false) {
  assert.ok(!rows(text).some(row => row.startsWith("UNITS=")), "Pinned ODB 8.0 job uses implicit inches");
  // Strip presentation attributes. The pinned exporter supplies geometry and
  // explicitly closed rings in the same records consumed by the in-tree reader.
  const parsed = R.profileOrFeatures("UNITS=INCH\n" + rows(text).map(row => row.split(";")[0].trim()).join("\n"));
  if (profile) {
    assert.equal(parsed.features.length, 1);
    assert.equal(parsed.features[0].op, "S");
    assert.equal(parsed.features[0].contours[0].kind, "I");
  }
  return parsed;
}

function xor(a, b, pixel = .01) {
  const result = R.layerXor(a, b, {pixel});
  return {...result,areaMm2:round(result.differ * result.pixel ** 2)};
}

function pinsByPart(components, published) {
  return components.flatMap(c => [...(published ? c.pins : c.pins.values())].map(pin => ({
    ref:published ? c.ref : decodeURIComponent(c.ref),
    pin:published ? pin.name : decodeURIComponent(pin.name),
    at:published ? shift(pin.at) : [pin.x,pin.y],
    net:pin.net
  })));
}
function groupPinNames(pins) {
  const groups = new Map();
  for (const pin of pins.filter(p => p.net !== "$NONE$")) {
    if (!groups.has(pin.net)) groups.set(pin.net, new Set());
    groups.get(pin.net).add(pin.ref + "/" + pin.pin);
  }
  return [...groups.values()].map(set => [...set].sort().join(" ")).sort();
}
function connectivity() {
  const a = pinsByPart(sourceComponents, true), b = pinsByPart(waffleComponents, false);
  const keyed = new Map();
  for (const p of b) {
    const key = p.ref + "/" + p.pin;
    if (!keyed.has(key)) keyed.set(key, []);
    keyed.get(key).push(p);
  }
  const viaIdentities = a.map(p => [p, (keyed.get(p.ref + "/" + p.pin) || []).sort((x,y) =>
    distance(p.at, x.at) - distance(p.at, y.at))[0]]);
  const samePinLocation = viaIdentities.filter(([a,b]) => b && distance(a.at, b.at) <= .002);
  const identities = viaIdentities.filter(([,b]) => b).length;
  const vendorGroups = groupPinNames(a), waffleGroups = groupPinNames(b);
  const nativeGroups = native.nets.filter(n => n.nodes.length).map(n =>
    [...new Set(n.nodes.map(p => p.ref + "/" + p.pin))].sort().join(" ")).sort();
  function cadContacts() {
    const names = new Map(), positions = [];
    for (const row of rows(V[STEP + "netlists/cadnet/netlist"])) {
      const [kind,...col] = row.split(/\s+/);
      if (kind === "H") continue;
      if (kind[0] === "$") names.set(Number(kind.slice(1)), col[0]);
      else positions.push({at:shift(xy(col, 1)), net:names.get(Number(kind))});
    }
    assert.ok(positions.every(p => p.net));
    const waffleAssigned = pcb.electrical.points.filter(p => p.net && p.net !== "$NONE$");
    const vendorAssigned = positions.filter(p => p.net !== "$NONE$");
    return {vendorAssigned:vendorAssigned.length,waffleAssigned:waffleAssigned.length,
      boardLocation:matchContacts(vendorAssigned, waffleAssigned, () => true),
      encodedNetAndLocation:matchContacts(vendorAssigned, waffleAssigned, sameNet)};
  }
  return {
    category:"connectivity",
    vendorComponents:sourceComponents.length, waffleComponents:waffleComponents.length,
    commonComponentRefs:sourceComponents.filter(c => sameRef.has(c.ref)).length,
    missingComponentRefs:sourceComponents.filter(c => !sameRef.has(c.ref)).map(c => c.ref),
    extraComponentRefs:waffleComponents.filter(c => !sourceComponents.some(v => v.ref === decodeURIComponent(c.ref))).map(c => decodeURIComponent(c.ref)),
    componentPositionMatches:sourceComponents.filter(a => {
      const b = sameRef.get(a.ref);
      return b && distance(shift(a.at), [b.x,b.y]) <= .002;
    }).length,
    componentSideMatches:sourceComponents.filter(c => sameRef.get(c.ref)?.side === c.side).length,
    pinRecords:{vendor:a.length,waffle:b.length,commonIdentities:identities,positionMatches:samePinLocation.length,
      maxMatchedDeltaMm:round(max(samePinLocation.map(([a,b]) => distance(a.at,b.at))))},
    pinNetGroups:{vendor:vendorGroups.length,waffle:waffleGroups.length,native:nativeGroups.length,
      vendorGroupsExactlyInWaffle:vendorGroups.filter(n => waffleGroups.includes(n)).length,
      waffleMatchesNative:JSON.stringify(waffleGroups) === JSON.stringify(nativeGroups)},
    cadnet:cadContacts()
  };
}

function matchContacts(reference, actual, netsAgree) {
  const used = new Set(), errors = [];
  for (const point of reference) {
    let match = -1, nearest = .002;
    for (const [i,candidate] of actual.entries()) {
      if (used.has(i) || !netsAgree(point.net,candidate.net)) continue;
      const delta = distance(point.at,[candidate.x,candidate.y]);
      if (delta <= nearest) { match = i; nearest = delta; }
    }
    if (match >= 0) { used.add(match); errors.push(nearest); }
  }
  return {matched:used.size, maxMatchedErrorMm:round(max(errors))};
}

function ipcContacts() {
  assert.match(ipc356, /^P  UNITS CUST 1\s*$/m);
  assert.match(ipc356, /^999\s*$/m);
  const records = ipc356.split(/\r?\n/).filter(row => /^(317|327)/.test(row)).map(row => {
    const coordinate = /X([ +-]\d{6})Y([ +-]\d{6})/.exec(row);
    assert.ok(coordinate, row);
    return {at:shift([Number(coordinate[1]) / 1000, Number(coordinate[2]) / 1000]),net:row.slice(3,17).trim(),
      via:row.slice(20,26).trim() === "VIA",drill:/D(\d{4})([PU])/.exec(row.slice(31,39))};
  });
  const assigned = records.filter(row => row.net !== "N/C"), candidates = pcb.electrical.points.filter(p => p.net && p.net !== "$NONE$");
  const comparison = matchContacts(assigned, candidates, (a,b) => sameNet(a,b.slice(0,14)));
  const unplated = records.filter(r => r.drill?.[2] === "U");
  const holes = pcb.layers.get("drill_nonplated").drill.hits;
  const matchingHoles = unplated.filter(r => holes.some(h => distance(r.at,[h.x,h.y]) < .002 &&
    Math.abs(Number(r.drill[1]) / 1000 - h.d) < .001));
  assert.equal(records.length, 446);
  assert.equal(assigned.length, 396);
  assert.equal(assigned.filter(r => r.via).length, 124);
  assert.equal(comparison.matched, 396);
  assert.ok(comparison.maxMatchedErrorMm < .00075);
  assert.equal(unplated.length, 11);
  assert.equal(matchingHoles.length, 11);
  print({category:"ipc356",records:records.length,assigned:assigned.length,unplated:unplated.length,
    vias:assigned.filter(r => r.via).length,comparison});
}

function vendorDrills(name) {
  const toolRows = rows(layer(name, "tools")).join("\n");
  const tools = [...toolRows.matchAll(/TOOLS \{([^}]+)\}/g)].map(([,body]) =>
    Object.fromEntries(body.trim().split("\n").map(field => field.trim().split("="))));
  const features = vendorPlot(layer(name)).features;
  return {hits:features.map(feature => {
    assert.equal(feature.op, "P");
    const d = 2 * feature.tool.round;
    const tool = tools.find(tool => Math.abs(d - Number(tool.FINISH_SIZE) * .0254) <= 1e-9);
    assert.ok(tool);
    const [x,y] = shift(feature.at);
    return {x,y,d,plated:tool.TYPE !== "NON_PLATED",type:tool.TYPE};
  }),slots:[]};
}

function drills() {
  for (const [reference, written, specimen, count] of [
    ["drill_non-plated_bottom-top", "drill_nonplated", "NonPlated", 11],
    ["drill_plated_bottom-top", "drill_plated", "Plated", 132]
  ]) {
    const o = pcb.layers.get(written).drill, v = vendorDrills(reference);
    const xc = CAM.parseExcellon(film("-" + specimen + ".TXT"));
    for (const hit of xc.hits) hit.plated = specimen === "Plated";
    assert.equal(xc.warnings.length, 0);
    const result = CAM.compareDrills(v, o, .001), self = CAM.compareDrills(xc, o, .001);
    const a = exported.matrix.layers.get(written), vendor = referenceLayers.get(reference);
    assert.equal(vendor.TYPE, "DRILL");
    assert.deepEqual([vendor.START_NAME,vendor.END_NAME], ["TOP_COPPER","BOT_COPPER"]);
    assert.deepEqual([a.start,a.end], ["top","bottom"]);
    for (const comparison of [result,self]) {
      assert.equal(comparison.matched, count);
      assert.equal(comparison.extra.length + comparison.missing.length + comparison.wrong.length, 0);
      assert.equal(comparison.slots.ref + comparison.slots.out, 0);
      assert.ok(comparison.maxPosDev < .0001 && comparison.maxDiaDev < .00001);
    }
    print({category:"drill",vendor:reference,waffle:written,waffleSpan:[a.start,a.end],vendorVsWaffle:result,excellonVsWaffle:self});
  }
}

function chainGroups(routePlot) {
  const groups = [];
  for (const f of routePlot.features) {
    assert.equal(f.op, "L");
    const first = shift(f.first), end = shift(f.end);
    const last = groups.at(-1);
    if (!last || distance(last.at(-1), first) > .00002) groups.push([first,end]);
    else last.push(end);
  }
  return groups;
}
function linePlot(rings) {
  return plot(rings.flatMap(ring => ring.slice(1).map(([x2,y2], i) => {
    const [x1,y1] = ring[i];
    return {k:"capsule",x1,y1,x2,y2,r:0,dark:true};
  })));
}
function geometry() {
  const vp = vendorPlot(V[STEP + "profile"], true);
  const vpRings = vp.features[0].contours.map(ring => ring.points.map(shift));
  const opRings = pcb.profile.features[0].contours.map(ring => ring.points);
  const outlines = CAM.compareOutlines(linePlot(vpRings), linePlot(opRings.slice(0,1)), .02);
  assert.equal(vpRings.length, 1);
  const routes = chainGroups(vendorPlot(layer("rout")));
  const closedRoutes = routes.filter(ring => distance(ring[0], ring.at(-1)) <= .001);
  const waffleRoute = pcb.layers.get("profile_rout");
  const waffleRouteChains = new Set(waffleRoute.features.map(f => f.attributes[".rout_chain"])).size;
  const outline = xor(waffleRoute,gerber(".GM1"),.005);
  const rout = CAM.compareOutlines(linePlot(closedRoutes),waffleRoute,.03);
  assert.equal(routes.length, 20);
  assert.equal(closedRoutes.length, 20);
  assert.equal(board.boardShape.cutouts.length, 19);
  assert.equal(waffleRouteChains, 20);
  assert.ok(outlines.maxDev < .012 && rout.maxDev < .012);
  assert.equal(outline.differ, 0);
  assert.equal(exported.matrix.layers.get("profile_rout").context, "BOARD");
  print({category:"profile",vendorProfileRings:vpRings.length,waffleProfileRings:opRings.length,
    outerCompare:outlines, outerXor:xor(plot([{k:"poly",rings:vpRings,dark:true}]),plot([{k:"poly",rings:opRings.slice(0,1),dark:true}])),
    vendorRoutChains:closedRoutes.length,waffleRouteChains,importedCutouts:board.boardShape.cutouts.length,
    allRouteCenterline:rout,
    waffleRouteFeatures:waffleRoute.features.length,
    waffleRouteArcs:waffleRoute.features.filter(item => item.op === "A").length,
    outlineOdbVsGerber:outline});
  // Numeric limits bound observed shared CAM differences. They are not manufacture acceptance criteria.
  for (const [suffix, reference, written, maximumXorMm2] of [
    [".GTS", "top_solder", "solder_mask_top", .001], [".GBS", "bottom_solder", "solder_mask_bottom", .001],
    [".GTL", "top_copper", "top", 1.35], [".G1", "gnd", "inner_1", omitUnconnectedMidLayerPads ? 21.55 : 53.0],
    [".G2", "supply", "inner_2", omitUnconnectedMidLayerPads ? 21.6 : 60.4],
    [".GBL", "bot_copper", "bottom", 1.5]
  ]) {
    const v = vendorPlot(layer(reference)), a = plot(v.shapes.map(shapeShift)), b = pcb.layers.get(written), g = gerber(suffix);
    assert.equal(g.warnings.length, 0);
    assert.equal(referenceLayers.get(reference).POLARITY, "POSITIVE");
    const wpol = exported.matrix.layers.get(written).polarity;
    assert.equal(wpol, "POSITIVE");
    const vendorVsWaffle = xor(a,b), vendorVsGerber = xor(a,g), waffleVsGerber = xor(b,g);
    const vendorFlashes = v.features.filter(f => f.op === "P").map(f => shift(f.at));
    const waffleFlashes = b.features.filter(f => f.op === "P").map(f => f.at);
    const extra = waffleFlashes.filter(p => !vendorFlashes.some(q => distance(p,q) <= .002));
    const unplated = pcb.layers.get("drill_nonplated").drill.hits;
    const extraAtUnplated = extra.filter(p => unplated.some(h => distance(p,[h.x,h.y]) <= .002));
    const flashCentresCompared = {vendor:vendorFlashes.length,waffle:waffleFlashes.length,
      vendorWithoutMatch:vendorFlashes.filter(p => !waffleFlashes.some(q => distance(p,q) <= .002)).length,
      waffleWithoutMatch:extra.length,extraAtUnplatedDrills:extraAtUnplated.length};
    assert.equal(flashCentresCompared.vendorWithoutMatch, 0, "An author flash centre was lost: " + written);
    if (omitUnconnectedMidLayerPads && written.startsWith("inner_")) assert.ok(flashCentresCompared.waffleWithoutMatch <= 7);
    // Replot only for attribution in this fixed reference check. The production
    // option keeps all copper near unplated holes.
    let diagnosticWithoutExtraUnplated;
    if (extraAtUnplated.length) {
      const keep = b.features.filter(f => f.op !== "P" || !extraAtUnplated.some(p => distance(f.at,p) <= .002));
      diagnosticWithoutExtraUnplated = xor(a,plot(keep.flatMap(f => f.geometry)));
    }
    assert.ok(vendorVsWaffle.areaMm2 <= maximumXorMm2, "Vendor artwork difference grew: " + written);
    assert.equal(waffleVsGerber.differ, 0, "Writer artwork difference: " + written);
    print({category:"artwork",vendor:reference,waffle:written,vendorRecords:v.features.length,waffleRecords:b.features.length,
      polarity:wpol,flashCentresCompared,vendorVsWaffle,vendorVsGerber,waffleVsGerber,diagnosticWithoutExtraUnplated});
  }
}

assert.deepEqual(translation, [25.4,25.4]);
print({category:"import/export",board:board.name,items:board.items.length,archiveSha256:createHash("sha256").update(built).digest("hex"),
  altiumToWaffleMm:translation,anchor:anchor.ref,omitUnconnectedMidLayerPads,warnings:archives.details.warnings});
const connected = connectivity();
assert.equal(connected.commonComponentRefs, 109);
assert.equal(connected.componentSideMatches, 109);
assert.equal(connected.componentPositionMatches, 109);
assert.equal(connected.pinRecords.positionMatches, 312);
assert.deepEqual(connected.pinNetGroups, {vendor:84,waffle:84,native:84,vendorGroupsExactlyInWaffle:84,waffleMatchesNative:true});
assert.equal(connected.cadnet.vendorAssigned, 424);
assert.equal(connected.cadnet.waffleAssigned, 424);
assert.equal(connected.cadnet.encodedNetAndLocation.matched, 424);
assert.ok(connected.cadnet.encodedNetAndLocation.maxMatchedErrorMm < .00001);
print(connected);
ipcContacts();
drills();
geometry();
