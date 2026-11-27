"use strict";
// The design-diff engine (app/history/diff.js, AtriumDiff): the paired-design corpus with golden change
// sets (tests/fixtures/diff/corpus.json, built by make-corpus.py), matching when ids differ
// (re-import, a KiCad round trip), connectivity semantics, noise rules, rules / DRC deltas,
// reports with hostile design text, the incremental session, the adapters that call the engine
// (revision-review.js remap and the VS Code summary) and the 25.6k-object board.
// Runs under Node and the JSC shim. `--print-golden` prints the corpus results for make-corpus.py.
const assert = require("node:assert/strict");
const fs = require("node:fs");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "altium-rules", "pcb-draw", "component-classes", "rules", "project-rules", "revision-review", "diff"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const D = AtriumDiff;
const {nativeCAD} = require("../support/native-cad.cjs");
const design = revision => nativeCAD("design-diff", revision);
const clone = v => JSON.parse(JSON.stringify(v));
const base = () => design();
const kinds = r => r.changes.map(c => c.kind);
const find = (r, kind, pred = () => true) => r.changes.find(c => c.kind === kind && pred(c));
const golden = r => ({total: r.summary.total, bySeverity: r.summary.bySeverity,
  changes: r.changes.map(c => [c.severity, c.kind, c.text].concat(c.match && c.match.by !== "id" ? [c.match.by] : []))});

// ------------------------------------------------------------------ corpus and goldens
const corpus = JSON.parse(fs.readFileSync(__dirname + "/../fixtures/diff/corpus.json", "utf8")).cases;
const results = {};
for (const c of corpus) results[c.name] = D.compare(design(c.before), design(c.after), c.options);
if (process.argv.includes("--print-golden")) {
  console.log("GOLDEN " + JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, golden(r)]))));
} else {
  for (const c of corpus) {
    assert.ok(c.expected, c.name + " has no golden: run python3 tests/fixtures/diff/make-corpus.py --golden");
    assert.deepEqual(golden(results[c.name]), c.expected, "golden change set of " + c.name);
  }
}

// ------------------------------------------------------------------ determinism: object order never changes a report
for (const c of corpus) {
  const before = design(c.before), after = design(c.after);
  for (const d of before.documents) d.items.reverse();
  for (const d of after.documents) d.items.reverse();
  after.library.reverse();
  assert.deepEqual(golden(D.compare(before, after, c.options)), golden(results[c.name]), "order-independent report for " + c.name);
}

// ------------------------------------------------------------------ semantics per corpus case
{
  const R = results;
  // Re-serialisation noise: reordered keys and objects, 1e-7 float noise.
  assert.equal(R.reserialised.summary.identical, true, JSON.stringify(R.reserialised.changes.slice(0, 3).map(c => c.text)));
  // Re-import with new ids everywhere: documents by kind/name, library by name, parts by designator, the rest by net + geometry.
  assert.equal(R["reimport-new-ids"].summary.identical, true, JSON.stringify(R["reimport-new-ids"].changes.slice(0, 5).map(c => c.text)));
  const m = R["reimport-new-ids"].stats.matched;
  assert.equal(m.id, 0);
  // Exact signatures (same definition, place, net) pair everything before designators are tried.
  assert.ok(m["net-geometry"] === 64 && m.designator === 0, JSON.stringify(m));
  // Parts that also moved fall back to their designators (R? is unannotated: it stays unmatched).
  const moved = design("reimport-new-ids");
  for (const d of moved.documents) for (const i of d.items) if (i.kind === "part") i.x += 1;
  const rm = D.compare(base(), moved).stats.matched;
  assert.ok(rm.designator >= 13, JSON.stringify(rm));
  assert.equal(R["reimport-new-ids"].stats.unmatched.before, 0);
  assert.ok(R["reimport-new-ids"].stats.confidence.min >= 0.6 && R["reimport-new-ids"].stats.confidence.min < 1);
  // Placement: board moves are mechanical; a 0.1 µm sheet nudge is under the tolerance.
  const mv = R["move-rotate-flip"];
  assert.deepEqual(mv.changes.filter(c => c.category === "pcb").map(c => c.kind).sort(), ["part.flipped", "part.moved", "part.rotated"]);
  // Moving U1 and rotating R2 pulls their pads off the copper: opens and shorts, so those edits are electrical.
  assert.ok(mv.changes.some(c => c.kind === "pad.shorted" && c.target.ref === "U1") && mv.changes.some(c => c.kind === "pad.opened" && c.target.ref === "R2"));
  const moving = corpus.find(c => c.name === "move-rotate-flip" || c.id === "move-rotate-flip");
  const restored = D.compare(design(moving.after),design(moving.before),{geometry:false});
  assert.ok(restored.changes.some(c => c.kind === "pad.shortCleared" && c.target.ref === "U1" && !c.geometry));
  assert.ok(restored.changes.some(c => c.kind === "pad.reconnected" && c.target.ref === "R2"));
  assert.equal(find(mv, "part.moved").severity, "electrical");
  assert.equal(find(mv, "part.flipped").severity, "mechanical", "C1 keeps its copper on the bottom");
  assert.equal(find(mv, "part.rotated").status, "modified", "a rotation in place is a modification");
  assert.equal(find(mv, "part.moved").target.ref, "U1");
  assert.ok(find(mv, "part.moved").geometry.before.box[0] < find(mv, "part.moved").geometry.after.box[0], "a moved part has both places");
  // Re-route: per-net routing with length and via deltas, and the objects behind them.
  const rr = R.reroute;
  const vin = find(rr, "routing.changed", c => c.target.net === "VIN");
  assert.ok(vin && vin.viaDelta === 1 && vin.lengthDelta > 0, JSON.stringify(vin));
  assert.ok(find(rr, "track.reshaped") && find(rr, "via.added") && find(rr, "track.removed"));
  assert.ok(find(rr, "routing.changed", c => c.target.net === "GND" && c.lengthDelta < 0));
  assert.ok(rr.byNet.VIN.boards["amwmqqymcb98cj7osact"].routing.viaDelta === 1);
  assert.ok(rr.routing.some(x => x.net === "VIN" && x.viasAfter === x.viasBefore + 1));
  // Pin swap: one change, both pins, electrical.
  const ps = R["pin-swap"];
  const swap = find(ps, "pin.swapped");
  assert.ok(swap && swap.severity === "electrical" && /U1 pins 1 and 3 swapped/.test(swap.text), swap?.text);
  assert.ok(!find(ps, "pin.moved"), "a swap is not reported as two moves");
  // Rename: one rename per domain; tracks and labels on the renamed net are not net changes.
  const rn = R["rename-net"];
  assert.deepEqual(rn.changes.filter(c => c.kind === "net.renamed").map(c => [c.target.domain.split(":")[0], c.before, c.after]).sort(), [["pcb", "VOUT", "VOUT_BUF"], ["schematic", "VOUT", "VOUT_BUF"]]);
  assert.ok(!find(rn, "track.net") && !find(rn, "pin.moved"), kinds(rn).join());
  assert.equal(rn.byNet.VOUT_BUF.renamedFrom, "VOUT");
  // Re-annotation: designators only; no net or pin noise even though the names of auto nets follow designators.
  const ra = R.reannotate;
  assert.ok(ra.changes.length >= 4 && ra.changes.every(c => c.kind === "part.reannotated" && c.severity === "cosmetic"), kinds(ra).join());
  // Library: pad edits are electrical and list the affected instances.
  const lf = find(R["library-footprint"], "library.footprint");
  assert.ok(lf.severity === "electrical" && lf.target.affected.includes("R2") && /pad 1 height\/width/.test(lf.text), lf.text);
  // Values, footprints and parameters.
  const vf = R["values-footprints"];
  assert.equal(vf.changes.filter(c => c.kind === "part.value").length, 2);
  assert.ok(find(vf, "part.footprint", c => /R2 footprint R_0603 → TestPoint/.test(c.text)));
  assert.ok(find(vf, "part.parameter", c => c.text === "U1 MPN: none → OPA350AIDBVR" && c.severity === "electrical"));
  assert.ok(find(vf, "pin.disconnected", c => c.target.pin === "R2.2"), "R2 lost pad 2 with its footprint");
  // Merge.
  const mg = find(R["merge-nets"], "net.merged");
  assert.ok(mg && mg.after === "BUF" && mg.before.includes("FILTER"), mg?.text);
  // Outline and variants.
  const ov = R["outline-rules-variants"];
  assert.ok(find(ov, "board.outline", c => /36 × 22 mm → 40 × 22 mm \(area \+88 mm²\)/.test(c.text)), kinds(ov).join());
  assert.ok(find(ov, "variant.added", c => c.severity === "electrical"));
  // Delete and add: part and copper; nets gained and lost; a new net.
  const da = R["delete-add"];
  assert.ok(find(da, "part.removed", c => c.target.ref === "C2") && find(da, "part.added", c => c.target.ref === "R9"));
  assert.ok(find(da, "net.added", c => c.target.net === "SENSE"));
  assert.ok(da.byNet.VOUT.boards["amwmqqymcb98cj7osact"].gained.includes("R9.1"));
  assert.ok(find(da, "part.added", c => c.target.doc === "amwmqqymcb98cj7osact" && /pins 1: VOUT, 2: SENSE/.test(c.text)));
  // Every change carries the contract fields.
  for (const r of Object.values(R)) for (const c of r.changes) {
    for (const k of ["id", "kind", "status", "category", "severity", "target", "text"]) assert.ok(c[k] != null, k + " on " + c.kind);
    assert.ok(["electrical", "mechanical", "cosmetic"].includes(c.severity) && ["added", "removed", "moved", "modified", "properties"].includes(c.status), c.kind);
    assert.ok(!c.geometry || (c.geometry.doc && c.geometry.box.length === 4), c.kind);
  }
  // Ordering: electrical first; ids unique.
  for (const r of Object.values(R)) {
    const ranks = r.changes.map(c => ({electrical: 0, mechanical: 1, cosmetic: 2})[c.severity]);
    assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b));
    assert.equal(new Set(r.changes.map(c => c.id)).size, r.changes.length);
  }
}

// ------------------------------------------------------------------ connectivity from wires, not from drawing
{
  const a = base(), b = clone(a), s = b.documents[0];
  // Redraw a wire as two segments with the same ends: cosmetic only, no net change.
  const w = s.items.find(i => i.id === "amwmqqymceeb52uxhzan");
  s.items.push({...w, id: "w-split", points: [[119.38, 78.74], [134.62, 78.74]]});
  w.points = [[109.22, 78.74], [119.38, 78.74]];
  const r = D.compare(a, b);
  assert.ok(r.changes.length && r.changes.every(c => c.severity === "cosmetic" && c.category === "schematic"), r.changes.map(c => c.text).join(" | "));
  // Moving a part off its wires disconnects it (compiled from the sheet), whatever its pinNets say.
  const c = clone(a); c.documents[0].items.find(i => i.id === "s-R2").x += 2.54;
  const r2 = D.compare(a, c);
  assert.ok(find(r2, "pin.disconnected", x => x.target.pin === "R2.1"), r2.changes.map(x => x.text).join(" | "));
  // schematicNets "pinNets" reads the annotation instead: then only the move remains.
  assert.deepEqual(kinds(D.compare(a, c, {schematicNets: "pinNets"})), ["part.moved"]);
}

// ------------------------------------------------------------------ noise rules are configurable
{
  const a = base(), b = clone(a);
  b.documents[1].items.find(i => i.id === "b-U1").x += 0.01;
  assert.equal(D.compare(a, b).changes.length, 1);
  assert.equal(D.compare(a, b, {tolerance: 0.02}).changes.length, 0, "tolerance");
  const o = clone(a); o.documents[1].items.reverse();
  assert.equal(D.compare(a, o).summary.identical, true);
  assert.ok(D.compare(a, o).stats.suppressed.order > 0);
  assert.deepEqual(kinds(D.compare(a, o, {ignoreOrder: false})), ["order.changed"], "ignoreOrder false");
  const k = clone(a); k.documents[1].items.find(i => i.kind === "label").text = "REV B";
  assert.equal(D.compare(a, k, {ignoreKinds: ["label"]}).changes.length, 0, "ignoreKinds");
  assert.equal(D.compare(a, k, {ignoreFields: ["text"]}).changes.length, 0, "ignoreFields");
  // Auto-generated net names that follow a re-annotation are not renames unless asked.
  const p = clone(a), q = clone(a);
  for (const x of [p, q]) for (const i of x.documents[0].items) if (i.kind === "netlabel" && i.text === "BUF") i.text = "Net-U1-1";
  for (const i of q.documents[0].items) if (i.kind === "netlabel" && i.text === "Net-U1-1") i.text = "Net-U2-1";
  assert.equal(find(D.compare(p, q), "net.renamed"), undefined);
  assert.ok(D.compare(p, q).stats.suppressed.autoNetNames >= 1);
  assert.ok(find(D.compare(p, q, {ignoreAutoNetNames: false}), "net.renamed"));
  // Only a whole generated name is one: a named net that starts with "Net-" is still renamed.
  for (const [from, to, hidden] of [["Net-3V3", "Net-5V", false], ["SENSE", "NET5", false], ["Net-USB-DP", "Net-USB-DM", false],
    ["Net-(R1-Pad2)", "Net-(R2-Pad2)", true], ["NetR1_2", "NetR2_2", true], ["Net-U$1-3", "Net-U$2-3", true]]) {
    for (const i of p.documents[0].items) if (i.kind === "netlabel" && /^Net|^SENSE$/.test(i.text)) i.text = from;
    for (const i of q.documents[0].items) if (i.kind === "netlabel" && /^Net|^SENSE$|^NET5$/.test(i.text)) i.text = to;
    assert.equal(!find(D.compare(p, q), "net.renamed"), hidden, from + " -> " + to + (hidden ? " is not a rename" : " is a rename"));
  }
  for (const name of ["Net-R1-1", "Net-U1A-B3", "Net-R?-2", "Net-7", "NetC1_2", "NetU3_A14", "Net-(R1-Pad2)", "unconnected-(U1-PA3)", "N$12", "N00012", "N_4", "$$$1234", "$1N5"])
    assert.ok(Atrium.isAutoNetName(name), name + " is generated");
  for (const name of ["Net-3V3", "Net-5V", "Net-USB-DP", "NetCLK_IN", "NET5", "SENSE", "Net-", "unconnected-", "N$", "VCC", "", null, 5])
    assert.ok(!Atrium.isAutoNetName(name), String(name) + " is named");
  // Every name Waffle generates: designators without a number (J, TP) or none, pins with hyphens, the
  // hierarchy's suffix for a name two nets share; and a name spelled as one of the net's own pins.
  for (const name of ["Net-J-1", "Net-TP-1", "Net--1", "Net-R1-PAD-1", "Net-U1_CH1-1", "Net-U1-~RESET", "Net-Q1-S/D", "Net-Ω1-1", "NetJ_1", "NetU1_CH1_1", "Net-R1-2_Sheet_2", "Net-J-1_2", "Net-7_2"])
    assert.ok(Atrium.isAutoNetName(name), name + " is generated");
  for (const name of ["Net-VCC-3V3", "Net-LED", "Net-USB-DP_N", "NetVCC_IN"]) assert.ok(!Atrium.isAutoNetName(name), name + " is named");
  assert.ok(!Atrium.isAutoNetName("Net-U1-1 2") && Atrium.isAutoNetName("Net-U1-1 2", [["U1", "1 2"]]) && Atrium.isAutoNetName("Net-USB-DP", [["R1", "1"], ["USB", "DP"]]));
  assert.ok(!Atrium.isAutoNetName("Net-USB-DP", [["R1", "1"]]) && !Atrium.isAutoNetName("Net-USB-DP", {autoNames: new Set(["Net-USB-DM"])}));
  {
    // The unlabelled example sheet under odd designators and pin numbers: connectivity names every net, and every name counts as generated.
    const ex = AtriumParts.example(), sheet = ex.documents.find(d => d.kind === "schematic"), defs = new Map(ex.library.map(d => [d.id, d]));
    sheet.items = sheet.items.filter(i => i.kind !== "netlabel");
    const refs = sheet.items.filter(i => i.kind === "part"), numbers = ex.library.flatMap(d => d.symbol?.pins || []);
    for (const [ref, pin] of [[(r, k) => r.ref.replace(/\d+$/, ""), n => n], [() => "", n => n], [r => r.ref, n => "PAD-" + n], [r => r.ref, n => n + " B"], [r => r.ref.replace(/\d+$/, ""), n => "P" + n]]) {
      const P = clone({refs: refs.map(r => r.ref), numbers: numbers.map(p => p.number)});
      refs.forEach((r, k) => { r.ref = ref(r, k); }); numbers.forEach(p => { p.number = pin(String(p.number)); });
      const conn = Atrium.connectivity(sheet, defs);
      assert.ok(conn.nets.length > 2 && conn.nets.every(n => Atrium.isAutoNetName(n.name, conn)), conn.nets.map(n => n.name).join());
      refs.forEach((r, k) => { r.ref = P.refs[k]; }); numbers.forEach((p, k) => { p.number = P.numbers[k]; });
    }
    sheet.items.push({id: "named", kind: "netlabel", text: "Net-USB-DP", x: 0, y: 0});
    const named = Atrium.connectivity(sheet, defs);
    assert.ok(!named.autoNames.has("Net-USB-DP") && !Atrium.isAutoNetName("Net-USB-DP", named), "a label nowhere near a pin's name stays named");
  }
  // Regenerated pour fill and imported caches are ignored by default.
  const f = clone(a); f.documents[1].items.find(i => i.id === "gndpour").pourIndex = 3;
  assert.equal(D.compare(a, f).changes.length, 0);
  assert.equal(D.compare(a, f).stats.suppressed.pourFill, 1);
  // Matching stages can be limited: without designator/geometry, a re-import is remove + add.
  const re = design("reimport-new-ids");
  assert.ok(D.compare(a, re, {match: ["id"]}).summary.parts.added >= 14);
}

// ------------------------------------------------------------------ rules, stack-up and the DRC delta
{
  // The project rule book (project.rules, app/checks/project-rules.js): a rule edit and a book setting.
  const a = base(); a.rules = clone(AtriumProjectRules.book(a));
  const b = clone(a);
  b.rules.list.find(x => x.type === "clearance").gap = 0.25;
  b.rules.keys = {...(b.rules.keys || {}), netCurrents: {VIN: 2}};
  const r = D.compare(a, b);
  assert.ok(find(r, "rule.changed", c => c.text === "Rule Clearance: gap 0.2 → 0.25" && c.severity === "mechanical"), r.changes.map(c => c.text).join());
  assert.ok(find(r, "rules.setting", c => c.text === "Rule keys.netCurrents.VIN none → 2"), r.changes.map(c => c.text).join());
  // DRC: a GND track pushed into the VIN track is a new violation; moving it back fixes it.
  const near = clone(a), board = near.documents[1];
  board.items.find(i => i.id === "thin").points = [[3.8, 11.12], [9.1, 11.12]];
  const d = D.compare(a, near, {drc: true});
  assert.ok(find(d, "drc.new") && find(d, "drc.new").geometry, kinds(d).join());
  assert.ok(find(D.compare(near, a, {drc: true}), "drc.fixed"));
  assert.equal(find(D.compare(a, near), "drc.new"), undefined, "the DRC delta is opt-in");
  // Stack-up.
  const s1 = clone(a), s2 = clone(a);
  s1.documents[1].stackup = {version: 1, layers: [{name: "Top", type: "copper", thickness: .035}, {name: "Core", type: "dielectric", thickness: 1.5}, {name: "Bottom", type: "copper", thickness: .035}]};
  s2.documents[1].stackup = {version: 1, layers: [{name: "Top", type: "copper", thickness: .035}, {name: "Core", type: "dielectric", thickness: 1.2}, {name: "Bottom", type: "copper", thickness: .035}]};
  assert.ok(find(D.compare(s1, s2, {validate: false}), "board.stackup", c => /thickness 1\.57 → 1\.27 mm/.test(c.text)));
}

// ------------------------------------------------------------------ reports: design text stays text
{
  const a = base(), b = clone(a);
  const hostile = "[x](https://evil.example)<img src=x onerror=alert(1)>*v*";
  b.documents[0].items.find(i => i.id === "s-R2").value = hostile;
  const r = D.compare(a, b);
  const md = D.toMarkdown(r, {title: "T <b>"});
  assert.ok(md.includes("\\[x\\](https:\u200b//evil.example)\\<img src=x onerror=alert(1)\\>\\*v\\*"), md);
  assert.ok(!/https:\/\//.test(md.replace(/^.*$/m, "")), "bare URLs are not auto-linked");
  assert.ok(!/(^|[^\\])<(img|b)/.test(md), "no unescaped HTML in Markdown");
  const html = D.toHTML(r, {title: "<script>x</script>"});
  assert.ok(!/<img|<script>x/.test(html) && html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("Content-Security-Policy"));
  const json = D.toJSON(r);
  assert.equal(json.format, "atrium-diff");
  assert.equal(JSON.parse(JSON.stringify(json)).changes[0].after, hostile);
  assert.match(D.toMarkdown(D.compare(a, a)), /No design changes/);
  const full = D.toMarkdown(results.reroute, {from: "HEAD", to: "working"});
  assert.ok(full.includes("## Routing by net") && full.includes("| VIN |"), full);
}

// Independent foreign reads allocate fresh document and item IDs. A hierarchy target follows the
// matched child sheet, and stacked same-net zones retain their distinct fabrication priorities.
{
  const old = Atrium.project("Reimport");
  const root = Atrium.sheet("schematic", "Root"), child = Atrium.sheet("schematic", "Power"), other = Atrium.sheet("schematic", "Inputs");
  const board = Atrium.sheet("pcb", "Board");
  old.documents = [root, child, other, board]; old.library = [];
  root.items.push({id: "symbol-old", kind: "sheetsymbol", x: 5, y: 8, w: 12, h: 6, name: "Power", sheet: child.id, entries: []});
  const zone = (id, rank) => ({id, kind: "polygon", layer: "Top", net: "GND", points: [[0,0],[5,0],[5,5]], closed: true, pourIndex: rank});
  board.items = [zone("z-first", -5), zone("a-second", -1)];
  const track = (id, points) => ({id, kind: "track", layer: "Top", net: "VCC", width: .5, points});
  board.items.push(track("z-track", [[1, 1], [2, 1]]), track("a-track", [[2, 1], [.999996, 1]]));
  const current = clone(old);
  for (const doc of current.documents) doc.id += "-new";
  const symbol = current.documents[0].items[0]; symbol.id = "symbol-new"; symbol.sheet = current.documents[1].id;
  const [first, second, forward, reversed] = current.documents[3].items; first.id = "a-first"; second.id = "z-second";
  forward.id = "a-forward"; reversed.id = "z-reversed";
  const rows = () => AtriumRevisionReview.compare(old, current, {match: true}).rows;
  assert.equal(rows().length, 0, "matched sheet and zone references survive re-import");
  assert.equal(D.compare(old, current).summary.total, 0);
  symbol.sheet = current.documents[2].id; first.pourIndex = -3;
  assert.equal(rows().length, 2, "actual hierarchy and priority edits stay visible");
  forward.points[1][0] += .01;
  assert.equal(rows().length, 3, "a genuine source track edit stays visible");
  assert.ok(find(D.compare(old, current), "sheetsymbol.sheet"));
}

// ------------------------------------------------------------------ API: session, async, match, remap and the callers
async function api() {
  const a = base(), b = design("reroute");
  const s = D.session(a);
  assert.deepEqual(golden(s.compare(b)), golden(D.compare(a, b)));
  assert.deepEqual(golden(s.compare(b)), golden(D.compare(a, b)), "the cached baseline gives the same answer twice");
  const r = await D.compareAsync(a, b);
  assert.deepEqual(golden(r), golden(D.compare(a, b)));
  let stop = false;
  const cancelled = D.compareAsync(a, b, {}, () => !stop); stop = true;
  assert.equal(await cancelled, null);
  // match() and remap(): the record view (Compare Revisions) lines up a re-import row by row.
  const re = design("reimport-new-ids");
  const M = D.match(a, re);
  assert.equal(M.items.size, a.documents.reduce((n, d) => n + d.items.length, 0));
  assert.throws(() => AtriumRevisionReview.compare(a, re), /share no document IDs/);
  const rows = AtriumRevisionReview.compare(a, re, {match: true}).rows;
  assert.ok(rows.every(row => row.status === "Changed"), rows.map(x => x.status + " " + x.name).slice(0, 5).join());
  // The VS Code summary is computed by the engine.
  const V = require("../../integrations/vscode/lib/diff.js");
  assert.equal(V.engine(), D);
  assert.match(V.report(a, b, {title: "Board.waffle"}), /## Routing by net/);
}

// ------------------------------------------------------------------ a KiCad round trip: files from another tool
function kicad() {
  for (const f of ["board-shape", "board-shape-sources", "stackup", "query", "viastack", "rooms", "pcb-pours", "polygon-pour", "pcb-text-rich", "pcb-text", "teardrops", "zip", "kicad-export", "import-link", "sexpr", "import-kicad"]) {
    try { require(require("../support/app-source-paths.cjs").appFile(f + ".js")); } catch { return console.log("SKIP kicad round trip: " + f + ".js did not load"); }
  }
  const a = base(), pcbOnly = p => ({...p, documents: p.documents.filter(d => d.kind === "pcb")});
  const out = AtriumKiCad.exportBoard(a, "amwmqqymcb98cj7osact");
  const results = AtriumImportFormats.readSet([{name: out.name, bytes: new TextEncoder().encode(out.content)}]);
  const b = Atrium.project("Imported"); b.documents = results.flatMap(r => r.documents); b.library = results.flatMap(r => r.library);
  const r = D.compare(pcbOnly(a), pcbOnly(b), {validate: false});
  const parts = a.documents[1].items.filter(i => i.kind === "part").length;
  assert.ok(r.stats.matched.designator >= parts, JSON.stringify(r.stats.matched));
  assert.equal(r.changes.filter(c => c.category === "connectivity").length, 0, r.changes.filter(c => c.category === "connectivity").map(c => c.text).join(" | "));
  console.log("kicad round trip: " + r.summary.text + "; matched " + JSON.stringify(r.stats.matched));
}

// ------------------------------------------------------------------ the 25.6k-object board
function dense() {
  require("../pcb/dense-board.js");
  const {d} = makeAtriumBenchmarkBoard(160); d.id = "pcb-perf";
  const P = Atrium.project("Dense", AtriumParts.catalogue); P.documents = [d];
  const before = clone(P), after = clone(P), items = after.documents[0].items;
  for (let k = 0; k < items.length; k += 97) { const i = items[k]; if (i.kind === "track") i.width = .3; else if (i.kind === "part") i.x += 1; else if (i.kind === "via") i.drill = .25; }
  const times = [];
  let r;
  for (let n = 0; n < 4; n++) { const t = Date.now(); r = D.compare(before, after, {validate: false}); times.push(Date.now() - t); }
  const all = clone(P); for (const i of all.documents[0].items) i.net = "EDITED_RAIL";
  const t2 = Date.now(), r2 = D.compare(before, all, {validate: false}), every = Date.now() - t2;
  const s = D.session(before), t3 = Date.now(); s.compare(after, {validate: false}); s.compare(after, {validate: false}); const sess = (Date.now() - t3) / 2;
  console.log("25.6k board: " + d.items.length + " objects, " + r.changes.length + " changes in " + times.join("/") + " ms (best " + Math.min(...times) + "); every object changed: " + r2.changes.length + " in " + every + " ms; session " + sess + " ms");
  assert.equal(d.items.length, 25600);
  assert.ok(Math.min(...times) < 1000, "the 25.6k board compares well inside a second (" + times + ")");
}

// ------------------------------------------------------------------ re-imported source files
// Re-saving an Altium design renumbers every record (track #598 → #518) and its pour names'
// index; a re-import pairs the objects by geometry. None of that is a change (counted as metadata).
function reimportNoise() {
  const a = base(), b = clone(a);
  let n = 0;
  for (const d of a.documents) for (const i of d.items) { if (d.kind === "pcb") i.sourceRecord = "tracks6/data#" + n++; else i.schSource = n++; }
  for (const d of b.documents) for (const i of d.items) { if (d.kind === "pcb") i.sourceRecord = "tracks6/data#" + (n++ * 7); else i.schSource = n++ * 7; i.id += "-reimported"; }
  const pa = a.documents.find(d => d.kind === "pcb").items.find(i => i.kind === "polygon"), pb = b.documents.find(d => d.kind === "pcb").items.find(i => i.kind === "polygon");
  if (pa) { pa.name = "GND_L02_P039"; pb.name = "GND_L02_P045"; }
  let r = D.compare(a, b);
  assert.equal(r.summary.total, 0, r.changes.map(c => c.text).slice(0, 5).join(" | "));
  assert.ok(r.summary.suppressed.metadata >= 10, JSON.stringify(r.summary.suppressed));
  // A real pour rename, or the provenance with metadata switched on, is still reported.
  if (pa) { pb.name = "AGND_L02_P045"; assert.ok(find(D.compare(a, b), "pour.property", c => /name/.test(c.text)), "a renamed pour"); pb.name = "GND_L02_P045"; }
  r = D.compare(a, b, {ignoreMetadata: false});
  assert.ok(r.changes.some(c => /sourceRecord|schSource/.test(c.text)), "provenance shows when asked for");
  // "Ignored noise" counts each metadata field once, whether or not the object also has a real change
  // (two merged mechanisms once counted it twice when it did).
  const x = base(), y = clone(x), pcb = x.documents.findIndex(d => d.kind === "pcb");
  const partX = x.documents[pcb].items.find(i => i.kind === "part"), partY = y.documents[pcb].items.find(i => i.id === partX.id);
  partX.sourceRecord = "components6/data#1"; partY.sourceRecord = "components6/data#2";
  r = D.compare(x, y);
  assert.equal(r.summary.suppressed.metadata, 1, "a metadata-only change: " + JSON.stringify(r.summary.suppressed));
  assert.equal(r.changes.length, 0);
  partY.value = (partY.value || "") + "x";
  r = D.compare(x, y);
  assert.equal(r.summary.suppressed.metadata, 1, "metadata and a real change: still one: " + JSON.stringify(r.summary.suppressed));
  assert.ok(r.changes.length >= 1 && !r.changes.some(c => /sourceRecord/.test(c.text)), "the real change is reported, the metadata is not");
  partX.schSource = 4; partY.schSource = 5;
  assert.equal(D.compare(x, y).summary.suppressed.metadata, 2, "two metadata fields: two");
}

globalThis.__testDone = (async () => { await api(); kicad(); reimportNoise(); dense(); })();
