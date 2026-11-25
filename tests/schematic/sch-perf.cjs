"use strict";
// Schematic whole-project scale (tests/schematic/sch-bench-project.js, 30 and 100 sheets): the headless costs
// that every schematic edit or sheet switch can reach, with generous time limits (CI machines vary),
// and equivalence of the incremental paths with their full counterparts:
//   - the synthetic projects compile to the expected hierarchy (instances, channels, nets);
//   - Design Insights' net-name typo check (insights-sch.js) reports exactly what the full pairwise
//     scan reports, on a sheet with crafted typos, in a fraction of the time;
//   - per-sheet connectivity, hierarchy compile, ERC, annotate and serialisation stay within limits.
// The interactive budgets (frames, sheet switch, idle wake-ups) are scripts/perf-sch.sh.
// Run: scripts/test-jsc.sh sch-perf   (or node tests/schematic/sch-perf.cjs)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "connectivity", "sch-objects", "hierarchy", "multichannel", "rooms", "rules", "messages", "erc", "annotate",
  "eco", "insights", "insights-sch", "undo-store", "save-cache"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./sch-bench-project.js");
const A = Atrium, H = AtriumHierarchy, I = AtriumInsights, S2 = AtriumInsightsSch;
const now = () => globalThis.performance?.now?.() ?? Date.now();
const SLOW = Number(globalThis.process?.env?.ATRIUM_PERF_SLACK || 1);
const best = (f, n = 3) => { let b = Infinity, r; for (let k = 0; k < n; k++) { const t = now(); r = f(); b = Math.min(b, now() - t); } return [b, r]; };
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const timings = {};

// ------------------------------------------------------------ the synthetic projects
const P30 = makeAtriumSchBenchProject({sheets: 30}), P100 = makeAtriumSchBenchProject({sheets: 100});
test("bench projects: deterministic, valid, hierarchical with an 8-channel sheet", () => {
  assert.ok(JSON.stringify(makeAtriumSchBenchProject({sheets: 30}).project) === JSON.stringify(P30.project), "same options, same project");
  for (const {project, stats} of [P30, P100]) {
    A.validate(project);
    const h = H.compile(project);
    assert.equal(h.effective, "hierarchical");
    assert.equal(h.issues.length, 0, h.issues.map(i => i.text).join("; "));
    assert.equal(h.instances.length, stats.sheets + stats.channels - 1, "one instance per sheet, eight for the channel sheet");
    assert.ok(h.nets.length > stats.parts / 2, "nets: " + h.nets.length);
    assert.ok(h.instances.some(i => i.channel?.label === "CH8"));
  }
  assert.deepEqual([P30.stats.sheets, P30.stats.parts, P100.stats.sheets, P100.stats.parts], [30, 3044, 100, 10984]);
});

// ------------------------------------------------------------ net-name typos: bucketed scan == pairwise scan
// The reference is the full pairwise scan the check used before (insights-sch.js typoCheck), on the
// same names and counts.
function referenceTypos(project, doc, defs) {
  const names = new Map(), nets = new Map();
  const bus = t => AtriumSchObjects.isBus(t);
  for (const d of project.documents) {
    if (d.kind !== "schematic") continue;
    const conn = A.connectivity(d, defs);
    for (const i of d.items) {
      let name = null;
      if (i.kind === "part") { for (const p of A.pins(i, defs.get(i.def), "schematic")) { const n = conn.byPin.get(i.id + "/" + p.number); if (n) nets.set(n, (nets.get(n) || 0) + 1); } continue; }
      if ((i.kind === "netlabel" || i.kind === "power" || i.kind === "port" || i.kind === "offsheet") && i.text && !bus(i.text)) name = i.text;
      else if (i.kind === "wire" && i.net) name = i.net;
      if (name == null) continue;
      if (!names.has(name)) names.set(name, []);
      names.get(name).push(d);
    }
  }
  // (The check also swaps a tie in favour of a known supply name; the crafted names below have no ties.)
  const list = [...names.keys()], uses = n => (names.get(n)?.length || 0) + (nets.get(n) || 0), out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    if (!S2.typoKind(list[i], list[j])) continue;
    const [rare, common] = uses(list[i]) <= uses(list[j]) ? [list[i], list[j]] : [list[j], list[i]];
    if ((names.get(rare) || []).includes(doc)) out.push(rare + "|" + common);
  }
  return out;
}
test("insights: net-name typo check matches the pairwise scan and is fast on 30 sheets", () => {
  const {project} = makeAtriumSchBenchProject({sheets: 30}), defs = new Map(project.library.map(d => [d.id, d]));
  const doc = project.documents.find(d => d.id === "sheet-s3"), other = project.documents.find(d => d.id === "sheet-s7");
  // Crafted typos: a swap, a doubled letter, separators, a one-letter change of a known supply; and
  // look-alikes that are not typos (digits, P/N suffixes).
  const lab = (d, text, x, y) => d.items.push({id: "typo-" + text + "-" + d.id, kind: "netlabel", text, x, y});
  lab(doc, "GDN", 500, 500); lab(doc, "S3_OUT__4", 510, 500); lab(doc, "VCCC", 520, 500); lab(doc, "VCX", 530, 500);
  lab(doc, "USB_DP", 540, 500); lab(other, "USB_DM", 540, 500); lab(other, "M2_OTU3", 550, 500); lab(doc, "M2_OUT3", 560, 500);
  const sig = x => x.message;
  const [ms, r] = best(() => I.analyze(project, doc, defs, {checks: ["netTypo"]}).insights, 2);
  const got = r.map(sig).sort(), want = referenceTypos(project, doc, defs);
  assert.ok(want.length >= 4, "the crafted typos are found by the reference: " + want.join(", "));
  assert.equal(got.length, want.length, "same number of typo findings: " + JSON.stringify(got) + " vs " + JSON.stringify(want));
  for (const w of want) { const [rare, common] = w.split("|"); assert.ok(got.some(m => m.includes(rare) && m.includes(common)), "reported: " + w); }
  // The other sheet sees its own rare names only.
  const there = I.analyze(project, other, defs, {checks: ["netTypo"]}).insights;
  assert.equal(there.length, referenceTypos(project, other, defs).length);
  timings.typoCheck30 = +ms.toFixed(1);
  assert.ok(ms < 400 * SLOW, "typo check on 30 sheets took " + ms.toFixed(1) + " ms");
});

// ------------------------------------------------------------ cached sheet graphs == fresh compile
// eco.js cachedLocal keeps a sheet's own graph while the undo journal certifies the sheet
// unchanged (the ECO status and Update PCB compile the project after every edit).
test("hierarchy: compile with journal-cached sheet graphs equals a fresh compile through edits", () => {
  const U = AtriumUndoStore, {project} = makeAtriumSchBenchProject({sheets: 30, name: "Cached"});
  const summary = h => JSON.stringify(h.nets.map(n => [n.name, n.pins.map(p => p.ref + "." + p.pin.number).sort()]).sort((a, b) => a[0] < b[0] ? -1 : 1));
  const history = [], future = [];
  U.mark(project, {}); U.record(project);
  const cached = AtriumECO.cachedLocal(project), sheet = id => project.documents.find(d => d.id === id);
  let builds = 0;
  const counting = (doc, build) => cached(doc, () => { builds++; return build(); });
  const check = label => assert.equal(summary(H.compile(project, {local: counting})), summary(H.compile(project)), label);
  check("first compile");
  builds = 0; check("unchanged project"); assert.equal(builds, 0, "every sheet graph is reused");
  const edit = (fn, commit = true) => { const before = U.mark(project, {}); fn(); U.checkpoint(history, future, before); if (commit) U.record(project); else U.touch(project); };
  const s3 = sheet("sheet-s3"), s5 = sheet("sheet-s5"), m2 = sheet("sheet-m2");
  builds = 0; edit(() => { s3.items.find(i => i.kind === "part").y += 2.54; }); check("part moved off its wires"); assert.equal(builds, 1, "only the edited sheet is rebuilt");
  edit(() => { s5.items.find(i => i.kind === "netlabel" && /OUT/.test(i.text)).text = "RENAMED"; }); check("label renamed");
  edit(() => { const w = m2.items.findIndex(i => i.kind === "wire"); m2.items.splice(w, 1); }); check("wire deleted");
  edit(() => { s3.items.push({id: "probe-wire", kind: "wire", points: [[0, 0], [400, 0]]}); }); check("wire added");
  edit(() => { project.library.find(d => d.id === "std-r").symbol.pins[0].x -= 1.27; }); check("library pin moved");
  edit(() => { s5.items.find(i => i.kind === "part").y -= 2.54; }, false); check("an edit not yet recorded");
  U.record(project);
  assert.ok(U.jump(history, future, U.mark(project, {}), -2)); check("undo two steps");
  assert.ok(U.jump(history, future, U.mark(project, {}), 1)); check("redo");
});

// ------------------------------------------------------------ autosave: journal-certified sheets == full serialisation
// save-cache.js job(p, {journal: true}) takes the cached text of every item on a sheet the undo journal
// reports unchanged since the last pass, without stringifying it; the bytes must stay identical.
test("save-cache: autosave passes certified by the undo journal are byte-identical and read only edited sheets", () => {
  const U = AtriumUndoStore, SC = AtriumSaveCache, {project} = makeAtriumSchBenchProject({sheets: 30, name: "Autosave"});
  const history = [], future = [], items = project.documents.reduce((n, d) => n + d.items.length, 0);
  U.mark(project, {}); U.record(project);
  const pass = () => { const j = SC.job(project, {journal: true}); while (!j.step(2)); return j.result(); };
  const same = label => { const st = pass(); assert.ok(SC.text(st) === AtriumECO.serialize(project), label + ": identical to a full serialisation"); return SC.stats().certified; };
  same("first pass");
  assert.equal(same("unchanged"), items, "every item certified");
  const edit = (fn, commit = true) => { const before = U.mark(project, {}); fn(); U.checkpoint(history, future, before); if (commit) U.record(project); else U.touch(project); };
  const s4 = project.documents.find(d => d.id === "sheet-s4"), m1 = project.documents.find(d => d.id === "sheet-m1");
  edit(() => { s4.items.find(i => i.kind === "part").x += 2.54; });
  assert.equal(same("part moved"), items - s4.items.length, "only the edited sheet is read");
  edit(() => { m1.items.find(i => i.kind === "netlabel").text = "RENAMED"; m1.items.push({id: "added", kind: "junction", x: 1, y: 1}); });
  same("label renamed, junction added");
  edit(() => { s4.items.find(i => i.kind === "part").value = "22k"; }, false);
  assert.equal(same("an unrecorded edit"), 0, "nothing is certified while the journal is behind");
  U.record(project);
  assert.ok(U.jump(history, future, U.mark(project, {}), -2)); same("undo");
  // A full pass (explicit save) never relies on the journal.
  const st = SC.state(project); assert.equal(SC.stats().certified, 0); assert.ok(SC.text(st) === AtriumECO.serialize(project));
});

// ------------------------------------------------------------ ECO status plan: the same changes without layout
test("ECO: a plan without layout (the status bar's) lists the same changes as a full plan", () => {
  const {project} = makeAtriumSchBenchProject({sheets: 30, name: "Status"}), o = {board: "board", scope: "*", direction: "pcb"};
  const [full, a] = best(() => AtriumECO.plan(project, o), 1), [quick, b] = best(() => AtriumECO.plan(project, {...o, layout: false}), 1);
  const ids = p => p.changes.map(c => c.id + ":" + c.action + ":" + !!c.selected + ":" + !!c.conflict).join(",");
  assert.ok(a.changes.length > 3000, "every part is new on the empty board: " + a.changes.length);
  assert.equal(ids(b), ids(a));
  assert.equal(b.clusters.length, 0); assert.ok(a.clusters.length > 0);
  timings.ecoPlan30 = +full.toFixed(1); timings.ecoPlanNoLayout30 = +quick.toFixed(1);
});

// ------------------------------------------------------------ whole-project passes
test("whole-project passes stay within generous limits (30 and 100 sheets)", () => {
  for (const [tag, {project}, k] of [["30", P30, 1], ["100", P100, 3.5]]) {
    const defs = new Map(project.library.map(d => [d.id, d])), dense = project.documents.find(d => d.id === "sheet-s2");
    const [sheet] = best(() => A.connectivity(dense, defs), 5);
    const [local] = best(() => H.local(dense, defs), 5);
    const [compile] = best(() => H.compile(project, {defs}), 3);
    // Compile with every sheet's own graph cached (what live ERC and the Navigator keep per sheet).
    const cache = new Map(), opt = {defs, local: (doc, build) => { if (!cache.has(doc)) cache.set(doc, build()); return cache.get(doc); }};
    H.compile(project, opt);
    const [cached] = best(() => H.compile(project, opt), 3);
    const [erc] = best(() => AtriumERC.run(project), 1);
    const [annotate] = best(() => AtriumAnnotate.plan(project, {action: "annotate"}), 2);
    const [serialize] = best(() => AtriumECO.serialize(project), 2);
    Object.assign(timings, {["sheet" + tag]: +sheet.toFixed(2), ["local" + tag]: +local.toFixed(2), ["compile" + tag]: +compile.toFixed(1), ["compileCached" + tag]: +cached.toFixed(1),
      ["erc" + tag]: +erc.toFixed(1), ["annotate" + tag]: +annotate.toFixed(1), ["serialize" + tag]: +serialize.toFixed(1)});
    assert.ok(sheet < 25 * SLOW, "one 510-item sheet's connectivity " + sheet.toFixed(1) + " ms");
    assert.ok(compile < 300 * k * SLOW, tag + " sheets: hierarchy compile " + compile.toFixed(0) + " ms");
    assert.ok(cached <= compile * 1.5 + 5, tag + " sheets: compile with cached sheets " + cached.toFixed(0) + " ms is not slower");
    assert.ok(erc < 1000 * k * SLOW, tag + " sheets: ERC " + erc.toFixed(0) + " ms");
    assert.ok(annotate < 300 * k * SLOW, tag + " sheets: annotate plan " + annotate.toFixed(0) + " ms");
    assert.ok(serialize < 400 * k * SLOW, tag + " sheets: serialise " + serialize.toFixed(0) + " ms");
  }
});

console.log("timings (ms) " + JSON.stringify(timings));
console.log("PASS sch-perf: " + passed + " tests");
