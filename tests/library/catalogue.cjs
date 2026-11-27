"use strict";
// Library catalogue v2 (app/library/catalogue.js, PARITY-3 task 6): one category scheme with a tree,
// hidden duplicates of the built-in parts, unique footprints in the picker, parametric facets,
// and Unicode-folded search that leaves stored names alone.
const assert = require("node:assert/strict");
for (const m of ["model", "connectivity", "parts", "component-families", "library-panel", "footprint-wizard", "starter-library", "catalogue"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const C = AtriumCatalogue, P = AtriumParts, L = AtriumLibrary;
const starter = AtriumStarterLibrary.defs(), lib = [...P.catalogue, ...starter], ids = new Set(lib.map(d => d.id));
const by = id => lib.find(d => d.id === id);

// ---- Folding: search only; stored names keep their Unicode.
assert.equal(P.fold("D−"), "d-");
assert.equal(P.fold("USB D– / D—"), "usb d- / d-");
assert.equal(P.fold("100 µF"), "100 uf");
assert.equal(P.fold("4.7 μH"), "4.7 uh", "Greek mu folds like the micro sign");
assert.equal(P.fold("10 kΩ"), "10 kohm");
assert.equal(P.fold("10 kΩ"), "10 kohm", "the ohm sign (U+2126) folds too");
assert.equal(P.fold("10k OHMS"), "10k ohm");
assert.equal(P.fold("Pin header 2×5"), "pin header 2x5");
assert.equal(P.fold("ＧＮＤ"), "gnd", "full-width letters");
const usb = by("starter-usbc-16");
assert.ok(usb.symbol.pins.some(p => p.name === "D−"), "stored pin names are unchanged");

// ---- Search: dialog (catalogue) and Library panel (AtriumLibrary.search) agree.
const names = defs => defs.map(d => d.name);
const find = q => names(C.pick(lib, q, {ids}));
assert.ok(find("D-").includes(usb.name), "D- finds the USB-C D− pins");
assert.ok(names(L.search(lib, "D-")).includes(usb.name), "Library panel too");
assert.deepEqual(find("uF").filter(n => /Electrolytic/.test(n)).length, 2, "uF finds µF parts");
assert.ok(find("µF").every(n => /Electrolytic/.test(n)));
assert.deepEqual(find("10k ohm"), ["Resistor 0402", "Resistor 0603", "Resistor 0805"]);
assert.deepEqual(find("10kΩ 0603"), ["Resistor 0603"], "spaces between number and unit don't matter");
assert.ok(names(L.search(lib, "10k")).includes("Resistor 0603"));
assert.ok(names(L.search(lib, "1 uH")).includes("Inductor 0603"));
// One matcher: with the catalogue loaded, AtriumLibrary.search gives the catalogue's answer for every field term.
{
  const fp = {name: "MCU_FP", pads: [{number: "1", x: 0, y: 0, w: .3, h: .8}], shapes: []};
  const extra = [{id: "x-qfn", name: "MCU", prefix: "U", value: "", package: "QFN-32", footprint: fp}, {id: "x-mirror", name: "MCU mirror", prefix: "U", value: "", package: "QFN-32", footprint: fp, mirrorOf: "x-qfn"}];
  const all = [...lib, ...extra];
  const qfn = L.search(all, "pkg:qfn").map(d => d.id);
  assert.ok(qfn.includes("x-qfn") && !qfn.includes("x-mirror"), "pkg: reads the package, not only the footprint name; mirrors stay out");
  for (const q of ["pkg:qfn", "package:0603", "fp:sot-23", "value:10k", "val:10k", "tol:1%", "v:50", "pins:3", "pins>8", "mount:smd", "cat:diode", "prefix:j", "id:starter", "has:footprint", "D-", "10k ohm"])
    assert.deepEqual(L.search(all, q).map(d => d.id), all.filter(d => !d.mirrorOf && C.matches(d, q)).map(d => d.id), q);
}
assert.ok(find("sot-23").length >= 6);
assert.deepEqual(find("nothing-like-this"), []);
for (const d of lib) assert.equal(C.matches(d, ""), true);

// ---- One category scheme and a two-level tree.
const leaves = new Set(C.GROUPS.flatMap(g => g[1]));
for (const d of starter) assert.ok(leaves.has(d.category), d.id + " has a catalogue category (" + d.category + ")");
for (const d of P.catalogue) assert.ok(leaves.has(C.category(d)), d.id + " -> " + C.category(d));
assert.equal(by("std-r").category, "Resistors"); assert.equal(by("std-c").category, "Capacitors"); assert.equal(by("std-tp").category, "Test points");
// Older spellings map onto the scheme without changing the stored category.
assert.equal(C.category({category: "Passives", prefix: "R"}), "Resistors");
assert.equal(C.category({category: "Passives", prefix: "C"}), "Capacitors");
assert.equal(C.category({category: "Mechanical", prefix: "H"}), "Mounting holes");
assert.equal(C.category({category: "Power", prefix: "U"}), "Regulators");
assert.equal(C.category({category: "Test", prefix: "TP"}), "Test points");
assert.equal(C.category({category: "Imported symbols", prefix: "U"}), "Imported symbols");
assert.equal(C.groupOf("Resistors"), "Passives"); assert.equal(C.groupOf("Net ties"), "Board features"); assert.equal(C.groupOf("Imported symbols"), "Other");

// ---- Duplicates: built-in parts are hidden while their starter twin is in the library.
const shown = C.pick(lib, "", {ids});
for (const id of Object.keys(C.SUPERSEDED)) {
  if (!by(id)) continue;
  assert.ok(!shown.some(d => d.id === id), id + " hidden");
  assert.ok(shown.some(d => d.id === C.SUPERSEDED[id]), C.SUPERSEDED[id] + " shown");
}
assert.ok(shown.some(d => d.id === "std-opamp"), "a built-in part without a twin stays");
const lower = s => P.fold(s).replace(/[^a-z0-9]+/g, " ").trim();
assert.equal(new Set(shown.map(d => lower(d.name))).size, shown.length, "no duplicate names");
assert.ok(!shown.some(d => /^test point$/i.test(d.name)), "one test point");
// Without the starter library nothing is hidden (the example design uses the built-in parts).
assert.equal(C.pick(P.catalogue, "").length, P.catalogue.length);
// Kept when asked (the Library panel keeps placed parts).
assert.ok(C.pick(lib, "", {ids, keep: d => d.id === "std-r"}).some(d => d.id === "std-r"));
// Ids stay valid: the defs are still in the library, only the lists hide them.
assert.ok(by("std-r") && by("std-tp"));

// ---- Footprint picker: one entry per footprint.
const fps = C.uniqueFootprints(shown);
const fpNames = fps.map(d => d.footprint.name);
assert.equal(new Set(fpNames).size, fpNames.length, "unique footprint names");
assert.ok(fps.length < shown.filter(d => d.footprint).length, "the four SOT-23 transistors share one footprint");
assert.equal(fps.filter(d => /SOT23|SOT-23-3|SOT95P/.test(d.footprint.name) && d.footprint.pads.length === 3).length, 1);
assert.equal(C.pick(lib, "", {ids, footprints: true}).length, fps.length);

// A physical shape shared by separately named options does not merge their exact placements.
const groupedOptions = ["bench-option-a", "bench-option-b"].map(id => ({...by("std-r"), id, name: id}));
const groupedProject = Atrium.project("Component families", groupedOptions);
const families = AtriumComponentFamilies;
const group = families.create(groupedProject, "Sample family", groupedOptions.map(d => ({defId: d.id, part: "Chip X"})));
const groupedIds = groupedOptions.map(d => d.id);
assert.deepEqual(C.query(groupedProject.library, "Sample Chip X pkg:0603", {footprints: true,
  members: families.memberships(groupedProject)}).items.map(d => d.id), groupedIds);
assert.deepEqual(C.find("Sample Chip", {project: groupedProject}).map(d => d.id), groupedIds);
families.rename(groupedProject, group, "Renamed family");
assert.deepEqual(C.find("Sample Chip", {project: groupedProject}), []);
assert.deepEqual(C.find("Renamed Chip", {project: groupedProject}).map(d => d.id), groupedIds);

// ---- Facets: value, package and voltage.
assert.deepEqual(C.facets(by("starter-r-0603")), {value: "10 kΩ", tolerance: "1%", voltage: "75 V", package: "0603", pins: "2", mounting: "SMD"});
assert.deepEqual(C.facets(by("starter-mcu-qfp48")).package, "LQFP-48");
assert.equal(C.facets(by("starter-hdr-2x5")).package, "2×5 2.54 mm");
assert.equal(C.facets(by("std-r")).package, "0603", "derived from the footprint name");
assert.equal(C.facets(by("std-opamp")).package, "SOT-23-5");
assert.equal(C.packageOf({footprint: {name: "RESC2012X65N"}}), "0805", "IPC chip names");
assert.equal(C.packageOf({parameters: {Package: "TO-220"}, footprint: {name: "x"}}), "TO-220", "a Package parameter wins");
assert.equal(C.subtitle(by("starter-r-0603"), "schematic"), "10 kΩ · 0603");
assert.match(C.subtitle(by("starter-r-0603"), "pcb"), /^RESC1608/);

// ---- Starter descriptions say the parts are generic and need sourcing.
for (const d of starter) assert.match(d.description, /^Generic .+ Not a specific part/, d.id);

// ================================================================== v2
// ---- U+2212 and friends normalise to "-" in search; terms ignore spaces between number and unit.
assert.equal(C.fold("V−"), "v-");
assert.ok(names(C.query(lib, "V−").items).includes("Dual op amp, SOIC-8"), "U+2212 in the query");
assert.ok(names(C.query(lib, "V-").items).includes("Dual op amp, SOIC-8"), "ASCII hyphen finds the U+2212 pin");

// ---- More facets: tolerance, pins and mounting (SMD / TH / both).
assert.equal(C.facets(by("starter-hdr-1x3")).mounting, "TH");
assert.equal(C.facets(by("starter-hdr-1x3")).pins, "3");
assert.equal(C.facets(by("starter-usbc-16")).mounting, "SMD + TH");
assert.equal(C.facets(by("starter-mh-m3")).mounting, "TH");
assert.equal(C.facets(by("starter-mcu-qfp48")).pins, "48");
assert.equal(C.facets(by("std-opamp")).pins, "5");
assert.equal(C.facets(by("starter-c-0805")).tolerance, "10%");

// ---- Facet filtering with counts. Each facet's counts apply the other facets only.
const st = {package: new Map([["0603", "0603"]])};
let q = C.query(lib, "", {ids, state: st});
assert.ok(q.items.length > 3 && q.items.every(d => C.facets(d).package === "0603"), "Package 0603 only");
assert.ok(q.counts.package.get("0805").n >= 3, "other packages keep their counts while 0603 is chosen");
assert.equal(q.counts.mounting.get("smd").n, q.items.length, "mounting counts follow the package choice");
st.mounting = new Map([["th", "TH"]]);
q = C.query(lib, "", {ids, state: st});
assert.equal(q.items.length, 0, "0603 and TH: nothing");
assert.ok(q.counts.mounting.get("th").n === 0 && q.counts.mounting.get("smd").n > 0, "a chosen value with no match stays, counted 0");
q = C.query(lib, "", {ids, state: {package: new Map([["0603", ""], ["0805", ""]])}});
assert.ok(q.items.some(d => C.facets(d).package === "0805") && q.items.some(d => C.facets(d).package === "0603"), "values in one facet are OR'd");

// ---- Field terms in the search box.
const hits = s => names(C.query(lib, s, {ids}).items);
assert.deepEqual(hits("value:10k pkg:0805"), ["Resistor 0805"]);
assert.ok(hits("mount:th").every(n => !/0603|0402|SOT/.test(n)) && hits("mount:th").length >= 8);
assert.ok(hits("pins>40").includes("Microcontroller, LQFP-48") && !hits("pins>40").includes("Resistor 0603"));
assert.deepEqual(hits("pins:5 cat:amplifier"), ["Operational amplifier"]);
assert.ok(hits("tol:1%").every(n => /^Resistor/.test(n)));
assert.ok(hits("v:16").length >= 2, "voltage term");
assert.ok(hits("has:footprint").length > hits("has:symbol").length, "mounting holes and fiducials have no symbol");
// Ranking: names that start with the first word come first.
assert.equal(C.query(lib, "res", {ids}).items[0].name, "Resistor 0402");

// ---- Categories: one scheme. Unknown categories keep their name, under their prefix's group.
assert.equal(C.category({category: "Project components", prefix: "U"}), "Other ICs");
assert.equal(C.category({category: "Device", prefix: "R"}), "Resistors");
assert.equal(C.category({category: "Fuses", prefix: "F"}), "Protection");
assert.equal(C.category({category: "", prefix: "K"}), "Relays");
assert.equal(C.record({id: "x", name: "Accelerometer", category: "Motion sensors", prefix: "U"}).group, "Integrated circuits");
assert.equal(C.record({id: "y", name: "Thing", category: "Widgets", prefix: "ZZ"}).group, "Other");
for (const d of lib) assert.notEqual(C.record(d).group, "Other", d.id + " lands in the scheme");

// ---- find(): the query API for MCP place_part (stable ids, hidden twins resolvable by id).
const fopt = {defs: lib};
assert.deepEqual(C.find("starter-r-0603", fopt).map(x => x.id), ["starter-r-0603"]);
const f0 = C.find("std-r", fopt)[0];
assert.equal(f0.id, "std-r"); assert.equal(f0.supersededBy, "starter-r-0603");
assert.ok(!C.find("resistor", fopt).some(x => x.id === "std-r"), "browsing hides the twin");
assert.ok(C.find("resistor", {...fopt, all: true}).some(x => x.id === "std-r"), "all:true shows it");
const r10 = C.find("10k 0603", fopt);
assert.equal(r10[0].id, "starter-r-0603");
for (const k of ["id", "name", "category", "group", "value", "package", "pins", "mounting", "footprint", "source"]) assert.ok(k in r10[0], k);
assert.equal(C.find("led", {...fopt, limit: 1}).length, 1);
assert.equal(C.get("std-tp", fopt).id, "std-tp");
// Without o.defs, find() searches AtriumParts.catalogue + the starter library + o.project.library.
assert.ok(C.find("starter-ldo-sot223").length === 1);
assert.ok(C.find("custom", {project: {library: [{id: "p1", name: "Custom sensor", prefix: "U", symbol: {pins: []}}]}}).some(x => x.id === "p1"));
assert.ok(!C.find("", {}).some(x => Object.keys(C.SUPERSEDED).includes(x.id)), "default pool hides twins");

// ---- Footprint picker: different pad geometry under one name stays as two entries.
const a = {id: "fa", name: "A", footprint: {name: "SOT-23", pads: [{number: "1", x: 0, y: 0, w: 1, h: 1}]}};
const b = {id: "fb", name: "B", footprint: {name: "SOT-23", pads: [{number: "1", x: 0, y: 0, w: 1.2, h: 1}]}};
const c = {id: "fc", name: "C", footprint: JSON.parse(JSON.stringify(a.footprint))};
assert.deepEqual(C.uniqueFootprints([a, b, c]).map(d => d.id), ["fa", "fb"]);

// ---- Index: records build lazily (once per def) and rebuild when the def changes.
const fresh = AtriumStarterLibrary.defs(), before = C.built();
C.query(fresh, "x"); assert.equal(C.built() - before, fresh.length, "one record per def on first search");
C.query(fresh, "xy"); C.query(fresh, "xyz"); assert.equal(C.built() - before, fresh.length, "reused on later keystrokes");
fresh[0].name = "Renamed resistor"; assert.ok(C.matches(fresh[0], "renamed"), "a renamed def is re-indexed");

// ---- Performance: search + facet counts over 5,000 defs per keystroke, under 16 ms.
const big = [];
for (let i = 0; big.length < 5000; i++) for (const d of starter) { if (big.length >= 5000) break;
  big.push({...d, id: d.id + "-" + i, name: d.name + " v" + i, value: d.value + (i % 7 ? "" : " (alt)"), parameters: {...d.parameters, Tolerance: ["1%", "5%", "10%"][i % 3]}}); }
const bigIds = new Set(big.map(d => d.id)), t0 = Date.now();
C.query(big, "", {ids: bigIds});
const indexMs = Date.now() - t0, times = [];
const stBig = {mounting: new Map([["smd", "SMD"]])};
for (const typed of ["r", "re", "res", "resi", "resis", "resist", "resisto", "resistor", "resistor 0", "resistor 06", "resistor 060", "resistor 0603", "c", "ca", "cap", "100n", "10k", "d−", "usb"]) {
  const t = Date.now(); C.query(big, typed, {ids: bigIds, state: stBig}); times.push(Date.now() - t);
}
times.sort((x, y) => x - y);
const median = times[times.length >> 1], worst = times[times.length - 1];
console.log("PERF catalogue 5000 defs: first index " + indexMs + " ms, per keystroke median " + median + " ms, worst " + worst + " ms");
assert.ok(median < 16, "median keystroke " + median + " ms");
console.log("SHIM-OK catalogue");
