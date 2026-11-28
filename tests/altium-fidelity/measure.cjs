"use strict";
// One subprocess per pinned project. The parent verifies the bytes before invoking this file.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const C = require("../formats/gerber-compare.cjs");
const {createHash} = require("node:crypto");
const Films = require("./films.cjs");
const Geometry = require("./geometry.cjs");
const Slots = require("./slots.cjs");
const PDFViews = require("./pdf_views.cjs");
const SilkControl = require("./silk_control.cjs");
const {project: fixture, modules, resources, directory, scratch, publicationViews = {}} = JSON.parse(fs.readFileSync(0, "utf8"));
for (const [name, file] of modules) {
  if (name === "cfb") globalThis.CFB = require(file);
  else require(file);
}
const date = new Date("2025-01-01T12:00:00Z");
const read = f => fs.readFileSync(path.join(directory, f.name));
const select = role => resources.filter(f => f.role === role);
const sorted = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b, "en")));
const defsOf = p => new Map(p.library.map(d => [d.id, d]));

function importProject(files, sourceRules) {
  const result = AtriumTranslators.import(files,{name:fixture.name,source_rules:sourceRules});
  const p = AtriumTranslatorProvenance.toLegacy(result.model, result.provenance);
  return {...result, p:Atrium.validate(p), info:{source_rules:result.provenance.sourceRules}};
}

// The canonical translator tracks exactly which source record produced each placed object.
// Independently count the native design and assert agreement before using the report totals.
// Connectivity, physical pad assignments, geometry, plots and shipped files remain independent oracles.
function inventory(project, fidelity) {
  const defs = defsOf(project), sheet = {}, pcb = {}, pins = new Set(), pads = new Set();
  const counts = {objects:0, libraryDefinitions:project.library.length, sheets:0, boards:0, schematicPins:0, boardPads:0, boardNets:0};
  for (const doc of project.documents) {
    const isBoard = doc.kind === "pcb", kinds = isBoard ? pcb : sheet, nets = new Set();
    const groups = new Map(), conn = isBoard ? null : Atrium.connectivity(doc, defs);
    if (isBoard) counts.boards++; else counts.sheets++;
    for (const item of doc.items) {
      counts.objects++;
      kinds[item.kind] = (kinds[item.kind] || 0) + 1;
      if (isBoard && item.net) nets.add(item.net);
      if (item.kind !== "part") continue;
      for (const pin of Atrium.pins(item, defs.get(item.def), isBoard ? "pcb" : "schematic")) {
        const key = item.ref + "." + pin.number;
        if (isBoard) {
          const net = item.pinNets?.[pin.number] || pin.net || "";
          counts.boardPads++;
          if (net) nets.add(net);
          pads.add(key + "=" + net);
        } else {
          counts.schematicPins++;
          const n = conn.byPin.get(item.id + "/" + pin.number);
          if (n == null) continue;
          if (!groups.has(n)) groups.set(n, []);
          groups.get(n).push(key);
        }
      }
    }
    for (const group of groups.values()) if (group.length > 1) pins.add(counts.sheets + "/" + group.sort().join("|"));
    counts.boardNets += nets.size;
  }
  const kinds = {pcb:{},schematic:{}};
  let produced = 0;
  for (const row of fidelity.modelObjects) {
    assert(row.references.length && row.references.every(r => r.source.file), "unattributed round-trip object");
    assert.equal(row.references.reduce((n,r) => n+r.count,0),row.count,"incomplete source-object inventory");
    kinds[row.documentKind][row.kind] = row.count;
    produced += row.count;
  }
  assert.deepEqual(kinds,{pcb,schematic:sheet},"objects in design differ from the translator's per-source inventory");
  assert.equal(produced,counts.objects,"unreported imported objects");
  return {counts:{...counts, objects:produced, boardKinds:sorted(kinds.pcb), schematicKinds:sorted(kinds.schematic)}, pins, pads};
}

function drills(referenceFiles, outputFiles, offset, sourceSlots, frame) {
  function parse(texts, label) {
    const all = {hits:[], slots:[], warnings:[]};
    for (const text of texts) {
      const p = C.parseExcellon(text);
      assert(p.units, label + " drill units missing");
      for (const key of Object.keys(all)) all[key].push(...p[key]);
    }
    return all;
  }
  const out = parse(outputFiles.map(f => f.content), "generated");
  assert(!out.warnings.length, "unreadable generated drill file");
  const counts = {hits:out.hits.length, slots:out.slots.length};
  const evidence = Slots.measure(sourceSlots, out, frame);
  if (!referenceFiles.length) return {counts, evidence, comparison:null, reason:"no shipped NC drill"};
  const ref = parse(referenceFiles.map(f => read(f).toString("latin1")), "reference");
  if (ref.warnings.length) return {counts, evidence, comparison:null, reason:"unsupported reference drill commands"};
  const diff = C.compareDrills(ref, out, .005);
  const summary = d => ({referenceHits:d.ref, missingHits:d.missing.length, extraHits:d.extra.length,
    changedTool:d.wrong.length, slotCountDelta:Math.abs(d.slots.ref - d.slots.out)});
  const comparison = summary(diff);
  if (offset) {
    const [dx, dy] = offset;
    const hits = out.hits.map(h => ({...h, x:h.x + dx, y:h.y + dy}));
    comparison.registered = summary(C.compareDrills(ref, {...out, hits}, .005));
  }
  return {counts, evidence, comparison};
}

function difference(before, after) {
  const delta = (a, b) => [...a].filter(key => !b.has(key)).length;
  const kindDelta = {}, kindCountDecreases = {}, kindCountIncreases = {};
  for (const kind of ["schematicKinds", "boardKinds"]) {
    for (const key of new Set([...Object.keys(before.counts[kind]), ...Object.keys(after.counts[kind])])) {
      const n = (after.counts[kind][key] || 0) - (before.counts[kind][key] || 0), name = kind + "." + key;
      if (n < 0) kindCountDecreases[name] = -n;
      if (n > 0) kindCountIncreases[name] = n;
      if (n) kindDelta[name] = Math.abs(n);
    }
  }
  return {pinGroupsLost:delta(before.pins, after.pins), pinGroupsAdded:delta(after.pins, before.pins),
    padNetsLost:delta(before.pads, after.pads), padNetsAdded:delta(after.pads, before.pads), kindDelta:sorted(kindDelta),
    kindCountDecreases:sorted(kindCountDecreases), kindCountIncreases:sorted(kindCountIncreases)};
}

function ruleCoverage(doc) {
  const records = doc.sourceRules || [];
  const result = AtriumRules.sourceReport?.(records, doc);
  if (!result) return null;
  assert.equal(result.length, records.length, "source rule records missing from report");
  const counts = {supported:0, partial:0, "source-only":0};
  for (const [i, row] of result.entries()) {
    assert.equal(row.record, i + 1);
    assert(Object.hasOwn(counts, row.status), "invalid source rule coverage status");
    if (row.status !== "supported") {
      assert(row.reason, "unconverted rule needs a reason");
      assert.equal(row.text, records[i], "unconverted rule needs its original source text");
    }
    counts[row.status]++;
  }
  return counts;
}

const sourceFiles = select("source").map(f => ({name:f.name, bytes:read(f)}));
const initial = importProject(sourceFiles, "use"), {p, info} = initial;
const board = p.documents.find(d => d.kind === "pcb"), sheets = p.documents.filter(d => d.kind === "schematic");
const boardInput = sourceFiles.find(f => /\.pcbdoc$/i.test(f.name));
const unmodified = AtriumIO.read(boardInput.name, boardInput.bytes);
const streams = AtriumIO.streams(boardInput.bytes);
assert.equal(p.documents.filter(d => d.kind === "pcb").length, 1);
assert(sheets.length && board.items.length && sheets.every(d => d.items.length), "empty or substituted source document");
const manifest = sourceFiles.find(f => /\.PrjPcb$/i.test(f.name));
const listed = AtriumIO.read(manifest.name, manifest.bytes).manifest.paths.map(n => path.win32.basename(n).toLowerCase());
const sourceNames = new Set(sourceFiles.map(f => f.name.toLowerCase()));
assert(listed.filter(n => /\.(schdoc|pcbdoc)$/i.test(n)).every(n => sourceNames.has(n)), "missing source document named by Altium");
const missingLibraries = new Set(listed.filter(n => /\.(pcblib|schlib)$/i.test(n) && !sourceNames.has(n))).size;
const before = inventory(p, initial.report);
const command = (op, args, body) => JSON.parse(AtriumHeadless(JSON.stringify({op, args}), body));
command("load", {digest:fixture.revision}, JSON.stringify(p));
const erc = command("erc", {limit:0});
const results = command("drc", {document_id:board.id, limit:0});
const drc = {};
// Individual result rows are paged. The per-rule totals include every finding.
for (const rule of results.rules) drc[rule.type] = (drc[rule.type] || 0) + rule.count;
const drcTotal = Object.values(drc).reduce((n, v) => n + v, 0);
const silkRuleComparison = SilkControl.compare(p, board, streams, results.rules);

const refs = resources.filter(f => f.role.startsWith("gerber:"));
const enabled = Object.fromEntries(refs.map(f => f.role.slice(7)).filter(k => /^[A-Z0-9]+$/.test(k)).map(k => [k,true]));
const F = AtriumFabOutputs, drillOrigin = F.drillOriginFor && fixture.drillOrigin;
const fab = F.build(p, board.id, {date, origin:fixture.origin, layers:enabled, pnp:true, drillDrawing:true,
  ...(drillOrigin ? {drillOrigin} : {})});
const legacyFrame = F.originFor(fab.model, {...fab.options, origin:fixture.origin === "auto" ? "outline" : fixture.origin});
const actualFrame = F.originFor(fab.model, fab.options);
const offsetFor = (offset, frame = actualFrame) => Films.referenceOffset(offset, legacyFrame, frame);
const plots = fab.files.filter(f => f.kind === "gerber" || f.kind === "drillmap");
const extension = f => path.extname(f.name).slice(1).toUpperCase();
const references = refs.map(f => ({key:extension(f), layer:f.role.slice(7), text:read(f).toString("latin1")}));
const plotOffset = offsetFor(fixture.plotOffsetMm);
const films = Films.measure(references, plots.map(f => ({layer:extension(f), text:f.content})), plotOffset);
if (fixture.profileWidthMm && Number.isFinite(fab.options.profileWidth)) {
  const profile = references.find(r => r.layer === "profile");
  assert.deepEqual(films.layers[profile.key].profile.referenceStrokeWidthsMm, [fixture.profileWidthMm]);
  const plan = F.plan(fab.model, {...fab.options, profileWidth:fixture.profileWidthMm});
  const file = plan.files.find(f => f.kind === "gerber" && extension(f) === "GM1");
  const declared = Films.measure([profile], [{layer:"GM1", text:F.generate(fab.model, plan, file).content}], plotOffset);
  films.declaredProfile = {widthMm:fixture.profileWidthMm, xorMm2:declared.gerberXorMm2,
    ...(plotOffset ? {registeredXorMm2:declared.registeredXorMm2} : {})};
}
const drillFiles = fab.files.filter(f => f.kind === "drill");
const ncReferences = select("drill"), slots = Slots.source(streams);
const drillFrame = F.drillOriginFor?.(fab.model, fab.options) || actualFrame;
const drill = drills(ncReferences, drillFiles, offsetFor(fixture.drillOffsetMm, drillFrame), slots, drillFrame);
let sharedDrill = null;
if (drillOrigin && drillOrigin !== "shared") {
  const plan = F.plan(fab.model, {...fab.options, drillOrigin:"shared"});
  const files = plan.files.filter(f => f.kind === "drill").map(f => F.generate(fab.model, plan, f));
  sharedDrill = drills(ncReferences, files, offsetFor(fixture.drillOffsetMm), slots, actualFrame).comparison;
}
const pnp = fab.files.find(f => f.kind === "pnp");
const bom = AtriumBOM.report(p, {titleBlock:false, columns:["designator","quantity"], now:date.toISOString()});
fs.writeFileSync(path.join(scratch, "bom.csv"), AtriumBOM.csv(bom));
fs.writeFileSync(path.join(scratch, "pnp.csv"), pnp.content);
const layerSets = ["composite","assembly-top","drill"];
if (Object.values(publicationViews).some(pages => Object.values(pages).some(view => view.kind === "assembly-bottom")))
  layerSets.push("assembly-bottom");
const pdf = AtriumPrint.build(p, {date, documents:[...sheets.map(d => d.id), board.id], layerSets});
fs.writeFileSync(path.join(scratch, "generated.pdf"), pdf.bytes());
const hasPCBViews = Object.values(publicationViews).some(pages =>
  Object.values(pages).some(view => ["pcb", "negative-plane", "positive-copper"].includes(view.kind)));
const plotTexts = new Map(plots.map(f => [extension(f), f.content]));
const sourceViews = hasPCBViews ? PDFViews.render(board, defsOf(p), p, publicationViews, date, plotTexts, actualFrame) : {ids:[], planes:[]};
if (sourceViews.bytes) fs.writeFileSync(path.join(scratch, "published-views.pdf"), sourceViews.bytes);
const planeViews = sourceViews.planes.map(({pixels, ...view}, index) => {
  fs.writeFileSync(path.join(scratch, "published-plane-" + index + ".gray"), pixels);
  return view;
});

const ascii = AtriumTranslators.export("altium",initial.model,{provenance:initial.provenance});
const returned = importProject(ascii.files.map(f => ({name:f.name,bytes:f.bytes || new TextEncoder().encode(f.text)})), "keep");
const recovered = returned.p, back = inventory(recovered, returned.report);
function archivedCopper(doc) {
  const owners = new Map(doc.items.filter(i => i.kind === "polygon").map(i => [i.id,i]));
  const identity = zone => [zone.name,zone.layer,zone.net,zone.pourIndex];
  const islands = (doc.pcbDrawing?.pours || []).filter(r => r.source === "altium").map(r => {
    const zone = owners.get(r.polygon);
    assert(zone && zone.layer === r.layer && zone.net === r.net, "stored copper lost its editable polygon owner");
    const digest = createHash("sha256").update(Buffer.from(r.data, "base64")).digest("hex");
    return JSON.stringify([identity(zone),r.subPolygonIndex,r.count,digest]);
  }).sort();
  const tick = v => Math.round(v/.00000254), point = p => p.map(tick);
  const strokes = doc.items.filter(i => i.sourcePour != null).map(i => {
    const zone = owners.get(i.sourcePour); assert(zone,"hatch stroke lost its editable polygon owner");
    const arc = Atrium.pathArc(i);
    const geometry = arc ? [point(arc.c),tick(arc.r),Math.round(arc.start*1e6)%360000000,Math.round(Atrium.arcSweep(arc)*1e6)]
      : i.points.map(point);
    return JSON.stringify([identity(zone),i.layer,i.net || zone.net,tick(i.width),geometry]);
  }).sort();
  return {polygons:[...owners.values()].filter(z => !z.cutout).map(z => JSON.stringify(identity(z))).sort(),islands,strokes};
}
assert.deepEqual(archivedCopper(recovered.documents.find(d => d.kind === "pcb")), archivedCopper(unmodified.documents[0]),
  "Altium project exchange changed original polygons, islands, holes or hatch strokes");
function sourceTotals(report) {
  return Object.fromEntries(report.kinds.map(row => {
    const quiet = row.notApplicable ? {notApplicable:row.notApplicable} : {};
    const totals = {kept:0,approximated:0,dropped:0,...(row.notApplicable ? {notApplicable:0} : {})};
    let references = 0;
    for (const ref of AtriumTranslatorRegistry.references(row)) {
      assert(ref.source.file && Number.isSafeInteger(ref.count) && ref.count > 0 && Object.hasOwn(totals,ref.status),
        "invalid source reference for "+row.kind);
      totals[ref.status] += ref.count;
      references++;
    }
    assert.equal(references,row.referenceCount,"missing source references for "+row.kind);
    assert.deepEqual(totals,{kept:row.kept,approximated:row.approximated,dropped:row.dropped,...quiet},"source outcomes for "+row.kind);
    return [row.kind,totals];
  }));
}
const report = {
  imported:before.counts, reimported:back.counts, roundTrip:difference(before, back),
  translation:{imported:sourceTotals(initial.report),exported:sourceTotals(ascii.report),reimported:sourceTotals(returned.report)},
  geometry:{
    source:Geometry.source(streams),
    read:Geometry.board(unmodified.documents[0], new Map(unmodified.library.map(d => [d.id, d]))),
    imported:Geometry.board(board, defsOf(p)),
    reimported:Geometry.board(recovered.documents.find(d => d.kind === "pcb"), defsOf(recovered)),
    formats:Geometry.formats(p, board, defsOf(p), fab, pdf)
  },
  missingSourceLibraries:missingLibraries, sourceRules:info.source_rules?.[0]?.count || 0,
  convertedRules:info.source_rules?.[0]?.converted || 0, rulesChecked:results.rules_checked,
  ruleCoverage:ruleCoverage(board),
  erc:{Fatal:erc.counts.Fatal, Error:erc.counts.Error, Warning:erc.counts.Warning, byCheck:sorted(erc.by_check)},
  drc:{total:drcTotal, byRule:sorted(drc)},
  ...(silkRuleComparison ? {silkRuleComparison} : {}),
  outputs:{gerbers:plots.length, drillFiles:drillFiles.length, drillHits:drill.counts.hits, drillSlots:drill.counts.slots,
    physicalDrillOpenings:drill.counts.hits + drill.counts.slots,
    bomRows:bom.lineCount, bomParts:bom.totalParts, pickPlaceRows:pnp.stats.components, pdfPages:pdf.pages.length},
  gerbers:films, drill:drill.comparison, drillSlotEvidence:drill.evidence, ...(drill.reason ? {drillUnavailable:drill.reason} : {}),
  ...(drillOrigin ? {drillOrigin, sharedDrill} : {}),
};
// Raw diagnostics and reference names are used locally for frequency aggregation. Only numeric
// measurements and fixed category names may be retained in the repository.
fs.writeFileSync(path.join(scratch, "detail.json"), JSON.stringify({report, notes:p.importNotes, sourceViews:sourceViews.ids, planeViews,
  refs:[...new Set(p.documents.flatMap(d => d.items.filter(i => i.kind === "part").map(i => i.ref)))],
  pages:pdf.pages.map(l => ({kind:l.kind === "schematic" ? "schematic" : l.set,
    name:p.documents.find(d => d.id === l.doc)?.name || ""}))}));
