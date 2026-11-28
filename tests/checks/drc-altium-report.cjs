"use strict";
// Waffle's DRC and ERC against Altium Designer's own reports for the same board (an external oracle,
// not a Waffle golden). Fixture: the PiDP-11 I/O Expander (tests/fixtures/altium/pidp11-io-expander,
// BSD-2-Clause, see NOTICE), whose RevA release ships the Design Rule Verification Report and the
// Electrical Rule Check Report Altium Designer 21.5.1 wrote for this exact PcbDoc and SchDoc. Their
// readings are in altium-reports-reva.json (tests/support/altium-reports.cjs).
//
// The board is imported as File › Import › Altium does (PrjPcb + SchDoc + PcbDoc) with "Use the
// board's rules", and checked as Tools › Design Rule Check does (AtriumDRC.batch, the imported batch
// check selection, plus the editor's extra checks from drc-fixes.js). Then, per rule of Altium's report:
//   1. the rule maps to one source rule record and to the Waffle rule converted from it;
//   2. the converted parameters equal the ones Altium printed (Gap, Min, Max, Preferred, Minimum ...);
//   3. Waffle's violation count equals Altium's;
//   4. Waffle runs no rule Altium's batch DRC did not run (online-only or Waffle-only checks fail here);
//   5. Minimum Solder Mask Sliver, which Waffle checks in DFM (mask web), finds exactly Altium's 15
//      pad pairs with the same widths;
//   6. ERC reports nothing, like Altium's "Successful Compile; No Violations Found."
// Every exception is listed in KNOWN with its reason and asserted to stay exactly as it is, so a fix
// (or a new divergence) fails until the list is updated.
// Run: node tests/checks/drc-altium-report.cjs   (or scripts/test-jsc.sh drc-altium-report)
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const {appFile} = require("../support/app-source-paths.cjs");
for (const f of ["model", "parts", "spatial", "sch-objects", "hierarchy", "net-ties", "multichannel", "messages", "erc", "board-shape", "board-shape-sources",
  "stackup", "impedance", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "rigid-flex", "altium-rules", "pcb-draw", "component-classes",
  "net-intent", "signals", "query", "rules", "viastack", "polygon-pour", "import-link", "source-file", "sch-import", "pcb-import", "io", "connectivity",
  "import-rules", "drc", "drc-pours", "drc-fixes", "mask-openings", "dfm"]) require(appFile(f + ".js"));
const REPORTS = require("../support/altium-reports.cjs"), MIL = REPORTS.MIL, A = Atrium;
const ref = REPORTS.reference();
const FIX = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");

// ---------------------------------------------------------------- known differences (each with its reason)
const KNOWN = {
  counts: {
    // Two zero-length stub tracks lie wholly inside a through-hole drill (J4.7 on GP0.3, J1.1 on VCC_3V3).
    // Waffle's connectivity treats them as drilled away and reports each as an unconnected island;
    // Altium counts them as touching the pad. See tests/formats/import-altium-real.cjs. Decision
    // pending: drop drilled-away copper from the net graph, or report it as a warning, not Un-Routed.
    UnRoutedNet: {altium: 0, waffle: 2},
  },
  params: {
    // The record stores GAP=11.811mil (and GENERICCLEARANCE=11.811mil); Altium's report prints
    // Gap=0mil for the rule it ran. Waffle enforces the stored 11.811 mil. Unexplained: confirm in
    // Designer (tests/altium-wine) which value Altium 21 enforces before changing the converter.
    "BoardOutlineClearance.gap": {altium: 0, waffle: .299999},
  },
  // Altium report rows that Waffle's DRC does not run as a rule, and where this suite checks them instead.
  notRun: {
    MinimumSolderMaskSliver: "source-only in Waffle; the DFM mask web check is compared below",
    NetAntennae: "source-only in Waffle; the editor's Net Antennae warning (atrium-netAntennae) is compared instead",
    PlaneConnect: "no plane layers on this board; Waffle keeps plane connect styles with the plane geometry",
  },
  // Checks Waffle's editor DRC adds by default that Altium has no rule for: allowed only while they find
  // nothing here. Missing Courtyard is opt-in (checks.courtyard, off) and is checked separately below.
  waffleOnly: {},
  // Waffle-only checks a user can opt in to: each must still find nothing on this board.
  optIn: {courtyard: "Missing Courtyard (Waffle only, Preferences › Design Checks)"},
  // Altium saved 15 waivers (the WaivedViolations stream); the importer does not read them.
  waiversImported: 0,
};

// ---------------------------------------------------------------- import and check as the editor does
const FILES = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"];
const read = FILES.map(name => AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(FIX, name)))));
const p = A.project("PiDP-11 I/O Expander"); p.documents = []; p.library = [];
for (const r of read) { p.documents.push(...(r.documents || [])); p.library.push(...(r.library || [])); }
const manifest = read.find(r => r.manifest)?.manifest;
if (manifest?.parameters) p.parameters = {...manifest.parameters};
AtriumImportLink.reconcile(p, p.documents);
A.validate(p);
const pcb = p.documents.find(d => d.kind === "pcb"), defs = new Map(p.library.map(d => [d.id, d]));
assert.equal(pcb.sourceSha256, "1ff7234670ec5e20092d23ecf0cd5e7380e842ef7efff2b5cb992f53f84c9c69", "the board Altium checked");
AtriumImportRules.apply(pcb, p, defs);
const rules = AtriumRules.stored(pcb, p);
const result = AtriumDRC.batch(pcb, defs, rules, {connections: () => AtriumConnectivity.inspect(pcb, defs, undefined, {project: p}), project: p, limit: 5000});
AtriumDRCFixes.augment(result, pcb, defs, {limit: 5000});

// ---------------------------------------------------------------- 1. map report rows to source records and Waffle rules
const KIND = {"Clearance Constraint": "Clearance", "Short-Circuit Constraint": "ShortCircuit", "Un-Routed Net Constraint": "UnRoutedNet",
  "Modified Polygon": "UnpouredPolygon", "Width Constraint": "Width", "Power Plane Connect Rule": "PlaneConnect", "Minimum Annular Ring": "MinimumAnnularRing",
  "Hole Size Constraint": "HoleSize", "Hole To Hole Clearance": "HoleToHoleClearance", "Minimum Solder Mask Sliver": "MinimumSolderMaskSliver",
  "Silk To Solder Mask": "SilkToSolderMaskClearance", "Silk to Silk": "SilkToSilkClearance", "Net Antennae": "NetAntennae",
  "Board Clearance Constraint": "BoardOutlineClearance", "Height Constraint": "Height"};
const fields = line => Object.fromEntries(line.split("|").filter(Boolean).map(kv => { const i = kv.indexOf("="); return [kv.slice(0, i).toUpperCase(), kv.slice(i + 1)]; }));
const records = pcb.sourceRules.map(fields).filter(r => r.ENABLED !== "FALSE");
const squash = s => String(s).replace(/\s+/g, "");
const rows = [...ref.drc.summary.rules.rows, ...ref.drc.summary.waived.rows.map(r => ({...r, waived: true}))];
assert.equal(ref.drc.summary.rules.rows.length, 18, "Altium's report lists 18 rules");
assert.equal(ref.drc.violations, 0); assert.equal(ref.drc.warnings, 0); assert.equal(ref.drc.waivedViolations, 15);
const mapped = rows.map(row => {
  const label = row.rule.split("(")[0].trim(), kind = KIND[label];
  assert.ok(kind, "report rule kind " + JSON.stringify(label) + " has a mapping");
  const same = records.filter(r => r.RULEKIND === kind);
  const scoped = same.length < 2 ? same : same.filter(r => squash(row.rule).includes(squash(r.SCOPE1EXPRESSION)))
    .sort((a, b) => squash(b.SCOPE1EXPRESSION).length - squash(a.SCOPE1EXPRESSION).length).slice(0, 1);
  assert.equal(scoped.length, 1, row.rule + ": one enabled source record (" + same.map(r => r.NAME).join(", ") + ")");
  const record = scoped[0], rule = rules.list.find(r => r.enabled && r.name === record.NAME), ran = result.rules.find(r => r.name === record.NAME);
  return {row, kind, record, rule, ran};
});
assert.equal(new Set(mapped.map(m => m.record.NAME)).size, mapped.length - ref.drc.summary.waived.rows.length, "each rule appears once (waived rows repeat a rule)");

// ---------------------------------------------------------------- 2. converted parameters equal Altium's printed ones
const PARAM = {Gap: "gap", Min: "min", Max: "max", Preferred: "preferred", Prefered: "preferred", Minimum: "min", Clearance: "gap"};
const paramDiffs = [];
for (const m of mapped) {
  if (!m.rule || m.row.waived) continue;
  for (const [, key, value] of m.row.rule.matchAll(/\((\w+)=(-?[\d.]+)mil\)/g)) {
    const field = PARAM[key];
    if (!field || m.rule[field] == null) continue;
    const altium = +value * MIL, waffle = m.rule[field];
    // Altium prints mils with three decimals: half a step is 0.0005 mil.
    if (Math.abs(altium - waffle) > .0006 * MIL) paramDiffs.push({id: m.record.NAME + "." + field, altium: +(altium).toFixed(6), waffle: +waffle.toFixed(6)});
  }
  if (/\(Allowed=No\)/.test(m.row.rule)) assert.equal(m.rule.allowed, false, m.row.rule);
}
assert.deepEqual(Object.fromEntries(paramDiffs.map(d => [d.id, {altium: d.altium, waffle: d.waffle}])), KNOWN.params,
  "converted rule parameters differ from Altium's report: " + JSON.stringify(paramDiffs));

// ---------------------------------------------------------------- 3. per-rule counts
const countDiffs = {}, notRun = [];
for (const m of mapped) {
  if (m.row.waived) continue;
  if (!m.ran) { notRun.push(m.kind); continue; }
  if (m.ran.count !== m.row.count) countDiffs[m.record.NAME] = {altium: m.row.count, waffle: m.ran.count};
}
assert.deepEqual(countDiffs, KNOWN.counts, "per-rule violation counts differ from Altium's report: " + JSON.stringify(countDiffs) +
  "\n  Waffle: " + JSON.stringify(result.violations.map(v => [v.ruleName, v.title])));
assert.deepEqual(notRun.sort(), Object.keys(KNOWN.notRun).sort(), "Altium rules Waffle's DRC does not run");
const antennae = result.rules.find(r => r.id === "atrium-netAntennae"), altiumAntennae = mapped.find(m => m.kind === "NetAntennae").row.count;
assert.equal(antennae?.count, altiumAntennae, "Net Antennae: Waffle's open-track-end warning finds what Altium's rule finds");

// ---------------------------------------------------------------- 4. Waffle runs nothing Altium's batch DRC did not
const matchedIds = new Set(mapped.filter(m => m.ran).map(m => m.ran.id).concat(antennae ? [antennae.id] : []));
const extra = result.rules.filter(r => !matchedIds.has(r.id));
assert.deepEqual(extra.map(r => r.id).sort(), Object.keys(KNOWN.waffleOnly).sort(),
  "Waffle ran rules Altium's DRC report does not list: " + JSON.stringify(extra.map(r => [r.type, r.name, r.count])));
for (const r of extra) assert.equal(r.count, 0, KNOWN.waffleOnly[r.id] + " finds nothing Altium would flag: " + r.count);
for (const [type, title] of Object.entries(KNOWN.optIn)) {
  const asked = {rules: [], violations: [], total: 0, stats: {ms: 0}};
  AtriumDRCFixes.augment(asked, pcb, defs, {types: [type], limit: 5000});
  assert.ok(asked.rules.some(r => r.id === "atrium-" + type), title + " runs when asked for");
  assert.equal(asked.violations.length, 0, title + " finds nothing Altium would flag: " + JSON.stringify(asked.violations.map(v => v.title)));
}
const knownExtra = Object.values(KNOWN.counts).reduce((n, k) => n + k.waffle - k.altium, 0);
assert.equal(result.violations.length - knownExtra, ref.drc.violations, "total violations, known differences aside");

// ---------------------------------------------------------------- 5. Minimum Solder Mask Sliver: DFM mask web
const sliverRow = mapped.find(m => m.kind === "MinimumSolderMaskSliver" && !m.row.waived).row;
const sliverGap = +/\(Gap=([\d.]+)mil\)/.exec(sliverRow.rule)[1];
const altiumSlivers = ref.drc.listed.filter(v => v.rule === "Minimum Solder Mask Sliver");
assert.equal(altiumSlivers.length, 15); assert.ok(altiumSlivers.every(v => v.waived && v.limitMil === sliverGap));
const pairKey = (a, b, side) => [a, b].sort().join(" ") + " " + side;
const want = new Map(altiumSlivers.map(v => [pairKey(v.objects[0].name, v.objects[1].name, /Bottom/.test(v.objects[0].layer) ? "bottom" : "top"), v.actualMil]));
const dfm = AtriumDFM.run(pcb, defs, {maskWeb: sliverGap * MIL}, {checks: ["maskWeb"], project: p});
const have = new Map(dfm.issues.map(i => {
  const m = /between Pad (\S+) and Pad (\S+) on the (top|bottom)/.exec(i.text);
  assert.ok(m, "mask web message names two pads: " + i.text);
  return [pairKey(m[1], m[2], m[3]), i.actual / MIL];
}));
const sliverDiffs = [];
for (const [k, mil] of want) if (!have.has(k)) sliverDiffs.push("missing " + k + " " + mil + " mil");
  else if (Math.abs(have.get(k) - mil) > .0006) sliverDiffs.push(k + ": Waffle " + have.get(k).toFixed(4) + " mil, Altium " + mil + " mil");
for (const k of have.keys()) if (!want.has(k)) sliverDiffs.push("extra " + k + " " + have.get(k).toFixed(4) + " mil");
assert.deepEqual(sliverDiffs, [], "mask slivers differ from Altium's report");
assert.equal((pcb.drcWaivers || []).length, KNOWN.waiversImported, "Altium's saved waivers on import");

// ---------------------------------------------------------------- 6. ERC
const erc = AtriumERC.run(p);
assert.deepEqual(ref.erc.messages, []); assert.ok(ref.erc.notes.some(n => /No Violations Found/.test(n)));
assert.equal(erc.counts.Fatal + erc.counts.Error + erc.counts.Warning, ref.erc.messages.length,
  "ERC: Altium found no violations; Waffle: " + JSON.stringify(erc.messages.filter(m => m.class !== "Info").map(m => [m.class, m.check, m.text])));

console.log("PASS drc-altium-report: " + mapped.filter(m => m.ran && !m.row.waived).length + " of " + ref.drc.summary.rules.rows.length +
  " Altium rules checked by Waffle with Altium's parameters and counts, " + want.size + " mask slivers equal, ERC clean" +
  (ref.verified ? "; extract verified against the release files" : "") + "; known: " + Object.keys(KNOWN.counts).concat(Object.keys(KNOWN.params)).join(", "));
