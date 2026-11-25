"use strict";
// Search everything (app/editor/search-index.js + palette.js searchAll): golden ranking queries (typos,
// transpositions, acronyms, synonyms, designators, pins), Unicode normalisation, kind and usage
// ranking, incremental re-indexing after edits, and per-keystroke latency on the 25.6k-object
// board with a 50,000-part library.
const assert = require("node:assert/strict");
for (const f of ["model.js", "parts.js", "import-link.js", "connectivity.js", "keymap.js", "nav-common.js", "palette-words.js", "palette.js", "search-data.js", "search-index.js"]) require(require("../support/app-source-paths.cjs").appFile(f));
require("../pcb/dense-board.js");
const S = AtriumSearchIndex, P = AtriumPalette, KW = AtriumPaletteWords;
const now = () => globalThis.performance?.now?.() ?? Date.now();

// ------------------------------------------------------------ text
assert.equal(S.norm("10 kΩ"), "10 kohm");
assert.equal(S.norm("10 kΩ"), "10 kohm", "U+2126 ohm sign");
assert.equal(S.norm("4.7 µF"), "4.7 uf"); assert.equal(S.norm("4.7 μF"), "4.7 uf", "Greek mu");
assert.equal(S.norm("−5V"), "-5v", "U+2212 minus");
assert.equal(S.norm("±1%"), "+-1%"); assert.equal(S.norm("+/-1%"), "+-1%");
assert.equal(S.norm("Résistance"), "resistance", "accents dropped");
assert.deepEqual(S.tokens("RC0603FR-0710KL 4.7µF"), ["rc0603fr", "0710kl", "4.7uf"]);
assert.ok(S.tokens("netClass").includes("net") && S.tokens("netClass").includes("netclass"), "camelCase parts");
assert.equal(S.osa("teardorps", "teardrops", 2), 1, "a transposition is one edit");
assert.equal(S.osa("updte", "update", 1), 1);
assert.equal(S.osa("polgon", "polygon", 1), 1);
assert.equal(S.osa("xyzzy", "update", 1), 2, "bounded: k + 1 when over");
assert.equal(S.osa("upd", "update", 1, true), 0, "prefix distance"); assert.equal(S.osa("updt", "update", 1, true), 1, "typo in a prefix");

// ------------------------------------------------------------ fixture
const project = AtriumParts.example(), sch = project.documents.find(d => d.kind === "schematic"), pcb = project.documents.find(d => d.kind === "pcb");
// Values and nets with the symbols people type differently.
const r1 = pcb.items.find(i => i.kind === "part" && i.ref === "R1");
r1.value = "10 kΩ";
const cpart = pcb.items.find(i => i.kind === "part" && /^C/.test(i.ref));
cpart.value = "4.7 µF ±10%";
pcb.items.push({id: "t-neg", kind: "track", layer: "Top", width: .2, points: [[0, 0], [1, 0]], net: "-5V"});
pcb.items.push({id: "t-3v3", kind: "track", layer: "Top", width: .2, points: [[0, 1], [1, 1]], net: "+3V3"});
for (let n = 0; n < 130; n++) pcb.items.push({id: "rx" + n, kind: "part", def: "std-r", x: n, y: 40, ref: "R" + (100 + n), value: "1k"});
pcb.items.push({id: "r12", kind: "part", def: "std-r", x: 0, y: 50, ref: "R12", value: "1k"});
const lib = [];
for (let n = 0; n < 40; n++) lib.push({id: "lib-" + n, name: ["RC0603FR-07", "GRM188R71", "DRC-guard-", "LM317-"][n % 4] + n, description: ["Resistor", "Capacitor", "Test part", "Regulator"][n % 4], footprint: {name: "R_0603", pads: []}});
project.library.push(...lib);
const defs = new Map(project.library.map(d => [d.id, d]));
// Commands: the keymap's, plus menu-only actions with their menu wording and palette words.
const menu = [["teardrops", "Teardrops…", "Tools"], ["polygon-pour", "Polygon Pour", "Place"], ["eco", "Update PCB Document…", "Design"], ["fab", "Fabrication Outputs…", "File"],
  ["board-wizard", "Board Wizard…", "Design"], ["bom", "Bill of Materials…", "Reports"]];
const commands = [...P.entries(">").filter(e => !menu.some(m => e.key === "cmd:" + m[0])),
  ...menu.map(([a, label, m]) => ({key: "menu:" + a, kind: "command", label, detail: m + " › " + label, alias: a, keywords: KW[a] || "", run() {}}))];

// A minimal editor host, so palette.js searchAll() (pins, groups, catalogue merge) runs headless.
let current = pcb.id;
const host = {project: () => project, defs: () => defs, currentId: () => current, doc: () => project.documents.find(d => d.id === current), units: () => "mm",
  registerAction() {}, on(t, f) {(host.ls[t] ||= []).push(f);}, ls: {}, selectDocument(id) {current = id;}, select() {}, zoomTo() {}, info() {}, setHighlight() {}, act() {}, canvas() {}};
P.attach(host);
P.startIndex();
assert.ok(P.readyIndex(), "index built");
const IX = P.index();
IX.setGroup("golden-commands", commands);
const top = (q, mode = "") => P.searchAll(q, mode);
const first = (q, mode) => top(q, mode)[0];
const rank = (q, pred, mode) => top(q, mode).findIndex(pred);
const golden = [];
function expect(q, pred, within = 1, mode = "") {
  const at = rank(q, pred, mode), res = top(q, mode);
  golden.push({q, ok: at >= 0 && at < within, at, got: res.slice(0, 3).map(e => e.label).join(" | ")});
}
const label = l => e => e.label === l;
const starts = l => e => e.label.startsWith(l);

// ------------------------------------------------------------ golden queries
expect("ucb", starts("Update PCB"));                       // acronym / subsequence
expect("tdr", label("Teardrops…"));                        // acronym
expect("teardorps", label("Teardrops…"));                  // transposition
expect("teardrps", label("Teardrops…"));                   // deletion
expect("updte pcb", starts("Update PCB"));                 // typo + exact
expect("update pbc", starts("Update PCB"));                // three-letter transposition
expect("polygn pour", label("Polygon Pour"));              // typo
expect("plygon", label("Polygon Pour"));                   // typo as the word is typed
expect("zone", label("Polygon Pour"));                     // KiCad synonym
expect("copper pour", label("Polygon Pour"));              // synonym phrase
expect("gerber", label("Fabrication Outputs…"), 3);        // synonym
expect("gerbr", label("Fabrication Outputs…"), 3);         // synonym with a typo
expect("bom", label("Bill of Materials…"));                // initials
expect("r12", e => e.label === "R12" && e.kind === "component"); // designator first, before R120..R129
expect("R1", e => e.label === "R1" && e.kind === "component");
expect("u1", e => e.label === "U1" && e.kind === "component");
expect("U1.3", e => e.kind === "pin" && /^U1\.3\b/.test(e.label));  // pin
expect("U1-3", e => e.kind === "pin" && /^U1\.3\b/.test(e.label));  // pad, Altium/KiCad style
expect("10kΩ", e => e.label === "R1");                     // Unicode value
expect("10 kohm", e => e.label === "R1");
expect("10k", e => e.label === "R1");
expect("4.7µF", e => e.label === cpart.ref);
expect("4.7uf", e => e.label === cpart.ref);
expect("−5V", e => e.label === "-5V" && e.kind === "net"); // U+2212 typed or pasted
expect("+3v3", e => e.label === "+3V3");
expect("vin", e => e.label === "VIN" && e.kind === "net");
expect("rc0603", e => e.kind === "library" && e.label.startsWith("RC0603FR"));   // library part by MPN prefix
expect("lm317", e => e.kind === "library" && e.label.startsWith("LM317"));
expect("drc", e => e.kind === "command", 1);               // a command outranks a library part named DRC-…
expect("prefrences", e => e.kind === "command" || e.kind === "setting", 2); // typo
expect("autosave", e => e.kind === "setting");             // preference names
expect("getting started", e => e.kind === "help");          // help headings
for (const g of golden) console.log((g.ok ? "ok   " : "FAIL ") + JSON.stringify(g.q).padEnd(16) + " rank " + g.at + "  → " + g.got);
const failed = golden.filter(g => !g.ok);
console.log("golden ranking: " + (golden.length - failed.length) + "/" + golden.length);
assert.equal(failed.length, 0, "golden queries: " + failed.map(g => g.q).join(", "));

// Groups: every result carries a group in display order; the everything view caps each group.
const grouped = top("r");
assert.ok(grouped.groups.length >= 1 && grouped.groups.every(g => g.count <= 8), "groups capped");
assert.ok(grouped.groups.some(g => g.name === "Components"));
// > and @ restrict kinds.
assert.ok(top("drc", ">").every(e => e.kind === "command"), "> is commands only");
assert.ok(top("r1", "@").every(e => ["component", "net", "netclass", "port", "pin"].includes(e.kind)), "@ is objects only");
// Usage: frequency and recency lift a result.
const before = rank("design rul", e => e.kind === "command" && /Rules/.test(e.label));
const target = top("design rul").find(e => e.kind === "command" && /Rules/.test(e.label));
assert.ok(target, "design rules command");
for (let n = 0; n < 4; n++) P.remember(target.key);
assert.ok(P.usageBonus(target.key) > 40, "used four times just now");
assert.ok(rank("design rul", e => e.key === target.key) <= Math.max(0, before - 0) && rank("design rul", e => e.key === target.key) === 0, "frequently used result first");

// ------------------------------------------------------------ incremental updates
const fresh = S.create();
let st = S.runNow(fresh.sync(project, defs));
assert.ok(st.added > 100, "first sync indexes everything");
st = S.runNow(fresh.sync(project, defs));
assert.equal(st.added + st.removed, 0, "no change, nothing re-indexed");
const libraryPart = lib[0];
const libraryKey = "lib:" + libraryPart.id;
libraryPart.footprint.name = "PackageFixtureXM147";
S.runNow(fresh.sync(project, defs));
assert.ok(fresh.search("PackageFixtureXM147").some(h => h.rec.key === libraryKey), "an in-place footprint rename refreshes the library posting");
libraryPart.footprint.name = "R_0603";
S.runNow(fresh.sync(project, defs));
assert.ok(!fresh.search("PackageFixtureXM147").some(h => h.rec.key === libraryKey), "the stale footprint posting is removed");
const v0 = fresh.version();
r1.value = "47 kΩ";
st = S.runNow(fresh.sync(project, defs));
assert.equal(st.added, 1, "one edited part re-indexed"); assert.equal(st.removed, 0);
assert.ok(fresh.version() > v0);
assert.equal(fresh.search("47k")[0].rec.label, "R1", "new value found");
assert.ok(!fresh.search("10kohm").some(h => h.rec.key === "obj:" + pcb.id + ":" + r1.id), "old value gone");
pcb.items.push({id: "new1", kind: "part", def: "std-r", x: 0, y: 60, ref: "R999", value: "1k"});
st = S.runNow(fresh.sync(project, defs));
assert.equal(st.added, 1); assert.equal(fresh.search("r999")[0].rec.label, "R999", "added part found");
pcb.items.splice(pcb.items.findIndex(i => i.id === "new1"), 1);
st = S.runNow(fresh.sync(project, defs));
assert.equal(st.removed, 1); assert.ok(!fresh.search("r999").some(h => h.rec.label === "R999"), "deleted part gone");
pcb.items.splice(pcb.items.findIndex(i => i.id === "t-neg"), 1);
S.runNow(fresh.sync(project, defs));
assert.ok(!fresh.has("net:-5V"), "net with no objects left is removed");
const extra = Atrium.sheet("schematic", "Power supply");
extra.items.push({id: "pp1", kind: "port", x: 0, y: 0, text: "VBUS_SENSE"});
project.documents.push(extra);
S.runNow(fresh.sync(project, defs));
assert.ok(fresh.search("vbus sense").some(h => h.rec.kind === "port"), "port on a new sheet");
assert.ok(fresh.search("power supply").some(h => h.rec.kind === "document"), "new sheet");
const note = {id:"review-note",kind:"textframe",text:"Projection",richText:{blocks:[
  {style:"check",runs:[{text:"Verify "},{text:"brownout monitor "},{expression:"U1.threshold"}]}
]}};
extra.items.push(note);
S.runNow(fresh.sync(project, defs));
for (const term of ["brownout","threshold","todo","checklist"]) {
  assert.ok(fresh.search(term).some(h => h.rec.key === "note:" + extra.id + ":" + note.id), "rich note indexed by " + term);
}
note.richText.blocks[0].style = "paragraph";
S.runNow(fresh.sync(project, defs));
assert.ok(!fresh.search("checklist").some(h => h.rec.kind === "notebook"), "converting a checklist removes its type keyword");
const checklist = {id:"widget-list",kind:"textframe",text:"Superseded words",widget:{type:"todo",
  state:{rows:[{id:"task-a",text:"Verify transient",assignee:"Jasper",due:"2027-05-20",done:false}]},
  fallback:{type:"text",text:"Superseded words"}}};
extra.items.push(checklist,{id:"older-note",kind:"textframe",text:"Legacy annotation",richText:{blocks:[null,{runs:{}}]}});
S.runNow(fresh.sync(project,defs));
assert.ok(fresh.search("legacy annotation").some(h => h.rec.target?.id === "older-note"),"an unreadable rich body keeps its plain fallback");
const hasTask = term => fresh.search(term).some(h => h.rec.key === "note:" + extra.id + ":" + checklist.id);
for (const term of ["transient","Jasper","2027-05-20","checklist"]) assert.ok(hasTask(term),"stored widget task indexed by " + term);
assert.ok(!hasTask("superseded"),"stale print fallback does not resurrect a deleted task");
checklist.widget.state.rows[0].assignee = "Minerva";
S.runNow(fresh.sync(project,defs));
assert.ok(hasTask("Minerva") && !hasTask("Jasper"),"task edits update the shared index");
checklist.widget.state.rows.length = 0;
S.runNow(fresh.sync(project,defs));
assert.ok(!hasTask("transient") && hasTask("checklist"),"removing the last task keeps the widget searchable");
S.runNow(fresh.sync(project,defs,{notebook:false}));
assert.ok(!hasTask("checklist"),"turning off Notebook removes the checklist from search");
S.runNow(fresh.sync(project,defs));
extra.name = "Power input";
S.runNow(fresh.sync(project, defs));
assert.ok(fresh.search("power input").some(h => h.rec.kind === "document"), "renamed sheet");
assert.ok(fresh.search("vbus").some(h => /Power input/.test(h.rec.detail)), "items on a renamed sheet carry the new name");
extra.items.push({id:"extra-resistor",kind:"part",ref:"RXQ",def:"std-r",x:0,y:0});
S.runNow(fresh.sync(project, defs));
assert.ok(fresh.search("RXQ").some(h => h.rec.kind === "pin"), "pins appear on the added sheet");
project.documents.pop();
S.runNow(fresh.sync(project, defs));
assert.ok(!fresh.search("vbus sense").length, "removed sheet's ports gone");
assert.ok(!fresh.search("RXQ").some(h => h.rec.docId === extra.id), "removed sheet's pins gone");
// The palette's own index follows the host's change events.
r1.value = "68 kΩ";
for (const f of host.ls.change || []) f();
P.readyIndex();
assert.equal(first("68k").label, "R1", "palette index catches up after an edit");
// Stale postings are compacted.
const churn = S.create();
for (let n = 0; n < 5000; n++) churn.put({key: "k" + n, kind: "library", label: "Part " + n});
for (let n = 0; n < 4000; n++) churn.remove("k" + n);
assert.ok(churn.stats().stale < 2001, "compacted");
assert.equal(churn.search("part 4999")[0].rec.key, "k4999");

// Board net classes (signal model net tags, app/core/signals.js) have independent targets and follow rename,
// deletion and undo.
{
  require("../../app/checks/net-intent.js");require("../../app/core/signals.js");require("../../app/checks/rules.js");require("../../app/history/undo-store.js");
  const U = AtriumUndoStore, SG = AtriumSignals, name = "Review traces", renamed = "Review inputs";
  const left = Atrium.sheet("pcb", "Driver"), right = Atrium.sheet("pcb", "Receiver");
  const p = {documents: [left, right], library: []}, defs = new Map(), index = S.create();
  p.signals = {version: 1, signals: [], tags: [], nets: {VIN: {tags: [name], boards: [left.id]}, GND: {tags: [name], boards: [right.id]}}};
  const history = [], future = [], kinds = new Set(["netclass"]);
  const sync = ix => S.runNow(ix.sync(p, defs, {journal: U, library: []}));
  const apply = fn => {
    const before = U.mark(p); fn(); U.checkpoint(history, future, before); U.record(p);
  };
  const members = {[left.id]: ["VIN"], [right.id]: ["GND"]};
  const verify = (query, documents, currentDoc = right.id) => {
    sync(index); const fresh = S.create(); sync(fresh);
    const results = ix => ix.search(query, {kinds, currentDoc}).filter(h => h.rec.label === query)
      .map(({rec}) => ({detail: rec.detail, target: rec.target}));
    const expected = results(fresh), actual = results(index);
    assert.deepEqual(actual, expected, "warm and fresh net-class results match");
    assert.deepEqual(actual.map(row => row.target.docId), documents.map(d => d.id));
    for (let i = 0; i < actual.length; i++) assert.deepEqual(actual[i].target.nets, members[documents[i].id]);
  };
  const undo = () => U.jump(history, future, U.mark(p), -1);
  try {
    U.record(p);
    verify(name, [right, left]);
    verify(name, [left, right], left.id);
    apply(() => {right.name = "Receiver revision B"; SG.edit(p, st => { st.nets.GND = {tags: [renamed], boards: [right.id]}; });});
    verify(name, [left]); verify(renamed, [right]);
    apply(() => {SG.edit(p, st => { delete st.nets.VIN; });});
    verify(name, []); verify(renamed, [right]);
    undo(); verify(name, [left]);
    undo(); verify(name, [right, left]); verify(renamed, []);
    apply(() => {p.documents.pop();});
    verify(name, [left]);
    undo(); verify(name, [right, left]);
  } finally {U.reset();}
}

// ------------------------------------------------------------ latency: 25.6k objects + 50k library
const {d: dense} = makeAtriumBenchmarkBoard();
let k = 0;
for (const i of dense.items) if (i.kind === "track" || i.kind === "via") i.net = "SIG" + (k++ % 400);
const big = {documents: [dense], library: []};
const base = AtriumParts.catalogue.find(p => p.id === "std-r");
for (let n = 0; n < 50000; n++) big.library.push({...base, id: "bench-" + n, name: ["RC0603FR", "CRCW0805", "GRM188R7", "LM317", "STM32F4"][n % 5] + "-" + (1000 + n), description: ["Resistor", "Capacitor", "Regulator", "Microcontroller", "Diode"][n % 5]});
for (let i=0; i<big.library.length; i++) {
  if (i % 9 === 0) big.library[i].symbol = null;
  if (i % 7 === 0) big.library[i].footprint = null;
}
require("../../app/library/component-families.js");
AtriumComponentFamilies.create(big,"Receiver front ends",[{defId:"bench-3",part:"AD5940"},{defId:"bench-8",part:"AD5941"}]);
AtriumComponentFamilies.create(big,"Precision impedance",[{defId:"bench-13",part:"AD5941"}]);
const bigDefs = new Map(big.library.map(d => [d.id, d]));
const bix = S.create();
bix.setGroup("commands", commands);
let t0 = now();
S.runNow(bix.sync(big,bigDefs,{notebook:true}));
const buildMs = now() - t0, stats = bix.stats();
// Bounded library prefix results exactly match exhaustive scoring, including a
// frequently used part outside the initial top 160 and different editor geometries.
const recentlyUsed = ["lib:bench-49995","lib:bench-49800","lib:bench-48001"];
for (const mask of [1,2,3]) {
  const opts = {limit:24,recent:recentlyUsed,usage:key => recentlyUsed.includes(key) ? 149 : 0,
    group:r => r.kind === "library" ? "Parts" : "Other",
    filter:r => !r.def || mask === 3 || (r.libraryMask & mask)};
  for (const q of ["r","rc","c","st","1","10","le"]) {
    const warm = bix.search(q,{...opts,libraryView:mask}), full = bix.search(q,{...opts,libraryView:0});
    assert.deepEqual(warm.map(h => [h.rec.key,h.score]),full.map(h => [h.rec.key,h.score]),"exact ranked head for " + mask + "/" + q);
    assert.equal(warm.total,full.total);
  }
}
// The interactive palette knows all ordinary library rows share a group and
// only get exact-title and usage boosts. Compare its scoring path with full
// filter, bonus and usage callbacks, including a previously used deep result.
const libraryUsage = new Map(recentlyUsed.map(key => [key,149]));
bix.setGroup("local-insert",[{key:"fixture:resistor",kind:"insert",label:"Resistor for schematic",run() {}}]);
for (const view of [1,2]) {
  for (const q of ["r","rc","rc0","rc0603fr","rc0603fr-1005","res","resi","resisotr","capacitor","cermaic","ceramic cap","grid","teardorps","r12"]) {
    const exact = S.norm(q);
    let checked = 0;
    const opts = {limit:24,libraryView:view,
      group:r => r.kind === "library" || r.kind === "insert" ? "Parts" : r.kind,
      usage:key => libraryUsage.get(key) || 0,
      filter:r => {checked++; return !r.def || (r.libraryMask & view);},
      bonus:r => r.kind === "library" && r.ln === exact ? 35 : 0};
    const reference = bix.search(q,{...opts,recent:libraryUsage.keys()});
    const totalChecked = checked;
    checked = 0;
    const local = bix.search(q,{...opts,recent:libraryUsage.keys(),libraryRanking:{group:"Parts",exact,usage:libraryUsage}});
    assert.deepEqual(local.map(h=>[h.rec.key,h.score]),reference.map(h=>[h.rec.key,h.score]),"interactive order and score for "+q+"/"+view);
    assert.deepEqual(local.totalByGroup,reference.totalByGroup,"interactive totals for "+q+"/"+view);
    if (q === "res") assert.ok(totalChecked - checked > 4000,"exclude wide library postings from per-record ranking");
  }
}
{
  const words = S.create();
  const input = ["ba1a","b12a","ab1baba2","ab1ba2b3","foobar123"];
  for (const label of input) words.put({key:label,kind:"library",label});
  const hits = text => new Set(words.search(text).map(hit=>hit.rec.key));
  assert.ok(hits("baba").has("ba1a") && !hits("baba").has("b12a"),"each digit needs one edit");
  assert.ok(hits("abababab").has("ab1baba2") && !hits("abababab").has("ab1ba2b3"),"two-edit whole-word digit budget");
  assert.ok(hits("foobat").has("foobar123"),"suffix digits still allow fuzzy prefixes");
}

// Switching off family search selects the ordinary prepared results immediately,
// including when the same initial has family postings and thousands of other parts.
for (const q of ["c","r"]) for (const families of [true,false]) {
  const count = libraryView => {
    let checked = 0;
    const hits = bix.search(q,{kinds:new Set(["library"]),families,libraryView,limit:24,
      filter:()=>{checked++;return true;}});
    return {checked,total:hits.total,rows:hits.map(h=>[h.rec.key,h.score])};
  };
  const fast = count(3), exhaustive = count(0);
  assert.equal(fast.total,exhaustive.total);
  assert.deepEqual(fast.rows,exhaustive.rows);
  assert.ok(fast.checked < 160 && exhaustive.checked > 5000,q + " should use the prepared prefix in both profiles");
  console.log("50k family prefix",JSON.stringify({q,families,fast:fast.checked,exhaustive:exhaustive.checked,total:fast.total}));
}
const queries = ["resistor 10k", "update pcb d", "r1234", "sig123", "stm32f4-102", "teardrops", "polygon pour", "gerber drill", "rc0603fr-100", "updte pbc"];
const lat = [];
for (let rep = 0; rep < 3; rep++) for (const q of queries) for (let n = 1; n <= Math.min(12, q.length); n++) {
  bix.invalidate();
  const t = now(); bix.search(q.slice(0, n), {limit: 160}); lat.push(now() - t);
}
lat.sort((a, b) => a - b);
const p50 = lat[Math.ceil(lat.length * .50) - 1], p95 = lat[Math.ceil(lat.length * .95) - 1];
console.log("search index: " + stats.records + " records, " + stats.tokens + " tokens, build " + buildMs.toFixed(1) +
  " ms; invalidated exhaustive query p50/p95/max " + [p50, p95, lat.at(-1)].map(ms => ms.toFixed(2)).join("/") + " ms");
// This benchmark isolates exhaustive ranking outside the editor. The palette gate measures
// whole handler and DOM work per real input, as well as dispatch to presentation.
// A folder exposes the full title manifest while its renderer owns just one hydrated document.
{
  const refs = Array.from({length:1000},(_,i) => Object.freeze({id:"folder-"+i,kind:i%2 ? "pcb" : "schematic",
    name:i===998 ? "Quasar calibration" : i===999 ? "Aurora receiver" : "Engineering sheet " + i,
    get items() {throw Error("Searching a title tried to hydrate a document.");}}));
  const folder = {id:"lazy-folder",library:[],documents:[{id:refs[0].id,kind:refs[0].kind,name:refs[0].name,
    items:[{id:"only-loaded",kind:"port",text:"LOADED_ONLY"}]}]};
  const opened = [], events = new Map(); let manifestReads = 0;
  const lazyHost = {...host,project:() => folder,defs:() => new Map(),doc:() => folder.documents[0],currentId:() => folder.documents[0].id,
    documentRefs() {manifestReads++; return refs;},on:(name,fn) => events.set(name,fn),
    selectDocument(id) {const ref=refs.find(r=>r.id===id);opened.push(id);
      folder.documents = [{id,kind:ref.kind,name:ref.name,items:[]}];events.get("document")();return Promise.resolve();}};
  P.attach(lazyHost); events.get("change")({source:"open"});
  assert.equal(manifestReads,0,"a closed palette leaves manifest search cold");
  P.readyIndex();
  for (const [title,id] of [["Quasar calibration","folder-998"],["Aurora receiver","folder-999"]]) {
    for (const mode of ["","@"]) assert.equal(P.searchAll(title,mode)[0].key,"doc:"+id);
  }
  assert.equal(P.index().stats().kinds.document,1000);
  assert.deepEqual(opened,[],"reading both result lists hydrates zero owners");
  P.searchAll("Aurora receiver","@")[0].run();
  assert.deepEqual(opened,["folder-999"],"Enter hydrates only the selected board");
  P.readyIndex();
  assert.ok(P.index().has("doc:folder-0") && !P.index().has("lbl:folder-0:only-loaded"),"evicting an owner preserves its title only");
  refs[998] = Object.freeze({id:"folder-998",kind:"schematic",name:"Quasar thermal"});
  refs.splice(997,1); events.get("change")({source:"manifest"});
  const readsBefore = manifestReads; P.readyIndex();
  assert.equal(manifestReads,readsBefore+1);
  assert.equal(P.searchAll("Quasar thermal","@")[0].key,"doc:folder-998");
  assert.ok(!P.index().has("doc:folder-997"));
  assert.equal(P.index().stats().kinds.document,999);
  assert.deepEqual(opened,["folder-999"]);
}
// Reusing starter postings must still allow a project or linked library to shadow them.
{
  for (const f of ["library-panel","footprint-wizard","starter-library","catalogue"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
  const blank = {library:[],documents:[]}, ix = S.create(), map = new Map();
  const sync = () => S.runNow(ix.sync(blank,map));
  const id = "starter-r-0603", key = "lib:" + id;
  sync();
  const cold = ix.get(key), template = AtriumCatalogue.get(id);
  assert.equal(cold.def,template);
  assert.equal(template,AtriumStarterLibrary.templates().find(d=>d.id===id));
  sync();
  assert.equal(ix.get(key),cold,"warm starter postings remain in the palette index");

  const local = {...Atrium.clone(template),name:"Project's resistor"};
  const linked = {...Atrium.clone(template),name:"Linked library's resistor"};
  const external = {id:"overlay-lib",name:"Overlay library",defs:[linked]};
  const externalKey = "lib:overlay-lib:" + id;
  const sources = globalThis.AtriumLibrarySources;
  try {
    globalThis.AtriumLibrarySources = {libraries:()=>[external]};
    blank.library.push(local);map.set(id,local);sync();
    assert.equal(ix.get(key).def,local);
    assert.equal(ix.get(externalKey).def,linked);
    assert.equal(AtriumCatalogue.get(id,{project:blank}),local);

    blank.library.length=0;map.clear();
    globalThis.AtriumLibrarySources = {libraries:()=>[]};
    sync();
    assert.equal(ix.get(externalKey),null);
    assert.equal(ix.get(key).def,template);
  } finally {globalThis.AtriumLibrarySources=sources;}
}
// Enhanced family lookup follows the owner's canonical metadata and its undo journal.
{
  require("../../app/library/component-families.js");
  require("../../mcp/authoring.js");
  const A = Atrium, F = AtriumComponentFamilies, U = AtriumUndoStore;
  const family = "Precision impedance AFE", rename = "Measurement network";
  const source = AtriumStarterLibrary.defs()[0];
  const part = (id, name) => ({...A.clone(source),id,name});
  const q = part("afe40-qfn","Lab chip alpha"), l = part("afe41-lfcsp","Lab chip beta"), b = part("afe41-bga","Lab chip gamma");
  const p = {library:[q,l,b],documents:[]};
  const initial = F.create(p,family,[{defId:q.id,part:"AD5940"},{defId:l.id,part:"AD5941"},{defId:b.id,part:"AD5941"}]);
  const lib = {id:"scoped-parts",name:"Fixture source",defs:[part(l.id,"External chip beta")]};
  F.create(lib,"External calibrated range",[{defId:l.id,part:"External AD9142"}]);
  const ix = S.create(), old = S.create(), defs = new Map(p.library.map(d=>[d.id,d]));
  const kinds = new Set(["library"]), history = [], future = [], original = globalThis.AtriumLibrarySources;
  let enhanced = true;
  const sync = (target = ix, mode = enhanced) => S.runNow(target.sync(p,defs,{journal:U,notebook:mode}));
  const results = (query, families) => ix.search(query,{kinds,families}).map(h=>h.rec.key).sort();
  try {
    globalThis.AtriumLibrarySources = {libraries:()=>[lib]};
    U.record(p);sync();sync(old,false);
    const oracle = query => {
      const catalogue = AtriumCatalogue.find(query,{project:p}).map(row=>"lib:"+row.id).sort();
      const mcp = AtriumAuthorV2.headless("find_parts",{query},{project:()=>p,page:items=>({items})}).items.map(row=>"lib:"+row.def_id).sort();
      assert.deepEqual(results(query),catalogue);
      assert.deepEqual(mcp,catalogue);
    };
    oracle(family);
    oracle("AD5941");
    assert.deepEqual(results("AD5941"),["lib:afe41-bga","lib:afe41-lfcsp"]);
    assert.deepEqual(results("External AD9142"),["lib:scoped-parts:afe41-lfcsp"]);
    assert.deepEqual(results("AD5941",false),[],"opting out hides a previously indexed family immediately");
    const heads = (target, query) => target.search(query,{kinds}).map(h=>[h.rec.key,h.score]);
    for (const query of ["qfn","resistor","Lab chip","Impedanxe"]) assert.deepEqual(heads(ix,query),heads(old,query));

    const before=U.mark(p), revision=U.familyVersion(), ordinary=ix.get("lib:starter-r-0603");
    p.componentFamilies[0].name=rename;
    U.checkpoint(history,future,before);U.record(p);
    assert.equal(p.componentFamilies[0].id,initial);
    assert.notEqual(U.familyVersion(),revision);
    sync();
    assert.deepEqual(results(family),[]);
    oracle(rename);
    assert.equal(ix.get("lib:starter-r-0603"),ordinary);
    U.jump(history,future,U.mark(p),-1);sync();
    oracle(family);
    assert.deepEqual(results(rename),[]);

    F.rename(lib,lib.componentFamilies[0].id,"New supplier family");sync();
    assert.deepEqual(results("External calibrated range"),[]);
    assert.deepEqual(results("New supplier family"),["lib:scoped-parts:afe41-lfcsp"]);
    globalThis.AtriumLibrarySources = {libraries:()=>[]};sync();
    assert.deepEqual(results("New supplier family"),[]);
    oracle("AD5941");
    enhanced = false;sync();
    assert.deepEqual(results("AD5941"),[]);
  } finally {globalThis.AtriumLibrarySources=original;U.reset();}
}
console.log("PASS search-index");
