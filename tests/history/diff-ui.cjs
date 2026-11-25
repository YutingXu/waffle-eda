"use strict";
// Visual design diff: diff-model.js over the one engine (AtriumDiff, diff.js):
// the adapter, filters, grouping electrical-first, geometry, cross-probe, links and screen-reader
// text; diff-export.js text rows; the lazy registration. The DOM view runs
// in Chrome (scripts/perf-diff.sh, scripts/click-through.sh); here we check it never writes HTML.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const APP = path.join(__dirname, "../../app");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "diff", "diff-model", "diff-export"]) require(require("../support/app-source-paths.cjs").appFileFrom(APP, m + ".js"));
const M = AtriumDiffModel;
const clone = x => JSON.parse(JSON.stringify(x));
const {nativeCAD} = require("../support/native-cad.cjs");
const base = nativeCAD("design-diff");
const pcbOf = P => P.documents.find(d => d.kind === "pcb"), schOf = P => P.documents.find(d => d.kind === "schematic");
const part = (doc, ref) => doc.items.find(i => i.kind === "part" && i.ref === ref);

// ---- edits on the board and the sheet
const P1 = clone(base), pcb = pcbOf(P1), sch = schOf(P1);
part(pcb, "R1").x += 2.54;                                     // moved
part(pcb, "J1").angle = 90;                                    // rotated
const vin = pcb.items.findIndex(i => i.kind === "track" && i.net === "VIN"); pcb.items.splice(vin, 1);
pcb.items.push({id: "via-new", kind: "via", x: 14, y: 14.5, diameter: .7, drill: .35, net: "GND", layer: "Multi"});
part(pcb, "C1").pinNets = {...part(pcb, "C1").pinNets, 1: "GND"};          // one pin to another net
part(sch, "C1").value = "4.7 nF";                                           // electrical property
pcb.items.find(i => i.kind === "label").text = "REV B";                   // cosmetic

(async () => {
  // ---- identical designs: nothing
  const same = M.create(base, clone(base));
  await same.run({});
  assert.equal(same.changes.length, 0, "identical projects have no changes");
  assert.equal(same.summary().text, "No changes");

  const m = M.create(base, P1, {from: "c43bcfa", to: "Working design"});
  let parts = 0;
  await m.run({onPartial: () => parts++});
  assert.ok(m.done && m.engine && parts >= 1, "the engine result is handed over in batches");
  assert.ok(m.changes.every(c => M.SEVERITIES.includes(c.severity) && M.STATUSES.includes(c.status)), "the engine's vocabulary is mapped (mechanical → layout)");
  const s = m.summary();
  assert.match(s.text, /^\d+ electrical · \d+ layout · \d+ cosmetic changes$/);
  assert.equal(s.total, m.changes.length);
  const groups = m.groups();
  assert.equal(groups[0].severity, "electrical", "electrical first");
  assert.deepEqual(groups.map(g => g.severity), M.SEVERITIES.filter(x => groups.some(g => g.severity === x)));
  const pin = m.changes.find(c => c.objectKind === "pin");
  assert.ok(pin && pin.severity === "electrical" && /C1\.1 moved from FILTER to GND/.test(pin.sentence), "pin nets read like a review comment");
  const mv = m.changes.find(c => c.objectKind === "part" && c.ref === "R1" && c.status === "moved");
  assert.ok(mv && mv.ref === "R1" && mv.layer === "Top" && mv.severity === "electrical", "a move that opens a pad is escalated to electrical");
  assert.ok(m.changes.some(c => c.status === "added" && /Via/.test(c.sentence)));
  assert.ok(m.changes.some(c => c.status === "removed" && /Track/.test(c.sentence)));
  const val = m.changes.find(c => c.docKind === "schematic" && c.ref === "C1");
  assert.equal(val.severity, "electrical");
  assert.ok(val.fields.some(f => f.changed && /10 nF/.test(f.before) && /4\.7 nF/.test(f.after)), "before/after property rows");
  // routing delta per net from res.routing
  assert.ok(m.routing.some(x => x.net === "VIN" && x.lengthBefore - x.lengthAfter > 5.29 && x.docName === "Sensor board"));
  assert.ok(m.routing.some(x => x.net === "GND" && x.viasAfter - x.viasBefore === 1));
  // filters
  assert.ok(m.filter({hideCosmetic: true}).every(c => c.severity !== "cosmetic"));
  assert.ok(m.filter({query: "r1 moved"}).every(c => c.ref === "R1") && m.filter({query: "r1 moved"}).length >= 1);
  assert.ok(m.filter({nets: new Set(["GND"])}).length >= 2);
  assert.ok(m.filter({statuses: new Set(["added"])}).every(c => c.status === "added"));
  // geometry: a move keeps the old place for the ghost and a span over both
  const g = m.geometry(mv);
  assert.ok(g.before && g.after && g.span);
  assert.ok(Math.abs((g.after.box[0] - g.before.box[0]) - 2.54) < 1e-6);
  assert.ok(Math.abs(mv.move.dx - 2.54) < 1e-6 && Math.abs(mv.move.dy) < 1e-9);
  assert.ok(m.geometry(pin).box, "a pin change has a place on the canvas");
  assert.ok(m.layerCounts(pcbOf(P1).id).get("Top") >= 1, "per-layer counts for the layer bar");
  // cross-probe: C1 changed on the sheet and on the board
  assert.ok(m.linked(val).some(c => c.docKind === "pcb" && c.ref === "C1"), "a schematic change finds its footprint change");
  assert.ok(m.linked(m.linked(val).find(c => c.docKind === "pcb")).includes(val), "and back");
  // links and screen-reader text
  const link = m.link(mv);
  assert.match(link, /^waffle-diff:c43bcfa\.\.Working%20design#/);
  assert.equal(m.find(link), mv);
  assert.match(m.speak(mv, 2, 10), /^Change 3 of 10\. Electrical, moved\. R1 moved .*\. On Sensor board, layer Top\.$/);

  // ---- net merge (pin membership): every FILTER pin on GND
  const P2 = clone(base);
  for (const d of P2.documents) for (const i of d.items) if (i.pinNets) for (const k in i.pinNets) if (i.pinNets[k] === "FILTER") i.pinNets[k] = "GND";
  const mm = M.create(base, P2); await mm.run({});
  const merge = mm.changes.find(c => c.topology?.type === "merge");
  if (merge) {
    assert.ok(merge.topology.before.some(x => x.net === "FILTER") && merge.topology.after.some(x => x.net === "GND"), "the diagram has both nets");
    assert.ok(merge.topology.after[0].nodes.length >= 2, "pins listed for the connection diagram");
  }
  // ---- cancelled comparison
  const cancelled = M.create(base, P1); assert.equal(await cancelled.run({active: () => false}), null);

  // ---- review P0-1: documents are paired as the engine paired them (re-import with new ids)
  const fixture = revision => nativeCAD("design-diff", revision);
  const re = M.create(base, fixture("reimport-new-ids")); await re.run({});
  assert.equal(re.docs.length, 2, "two documents, not four");
  assert.ok(re.docs.every(d => d.side === "both" && d.before && d.after), "each pairs its before and after document");
  assert.ok(re.docs.every(d => re.sides(d.id).before && re.sides(d.id).after), "both panes have a document");
  // ---- review P1-1: the merge diagram comes from byNet, so the merged pins are on the after side
  const mg = M.create(base, fixture("merge-nets")); await mg.run({});
  const mrg = mg.changes.find(c => c.topology?.type === "merge");
  assert.ok(mrg, "a merge row");
  const afterPins = mrg.topology.after.flatMap(x => x.nodes);
  for (const pin of mrg.topology.before.flatMap(x => x.nodes)) assert.ok(afterPins.includes(pin), pin + " is on the merged net");
  assert.ok(mrg.topology.after[0].gained.length > 0, "gained pins are marked");
  assert.equal(mrg.topology.where, "Schematic");
  assert.ok(mrg.doc, "a schematic net row sits on its sheet");
  // ---- review P1-4: human labels; internal keys behind "More fields"
  const da = M.create(base, fixture("delete-add")); await da.run({});
  const rmC2 = da.changes.find(c => c.objectKind === "part" && c.status === "removed" && c.ref === "C2");
  const labels = rmC2.fields.filter(f => !f.hidden).map(f => f.label);
  for (const want of ["Designator", "Value", "Library part", "Pin 1 net"]) assert.ok(labels.includes(want), want);
  assert.ok(!labels.includes("link") && !labels.includes("pinNets") && !labels.includes("refAt"), "no raw keys in the main table");
  assert.ok(rmC2.fields.some(f => f.hidden && f.label === "Link"), "the link id is under More fields");
  assert.ok(!/^(PCB [^:]+|Schematic): /.test(da.changes.map(c => c.sentence).join("\n")), "no PCB …: prefixes in row sentences");
  // ---- review P2-1/P2-3: grouping by document; a whole added sheet is one row until expanded
  const byDoc = da.groups(da.changes, "document");
  assert.ok(byDoc.every(g => g.kinds.every(k => k.items.every(c => (c.doc ?? "~project") === g.doc))), "document groups hold their own rows");
  const added = clone(base), extra = clone(schOf(base));
  extra.id = "sheet-new"; extra.name = "Power"; extra.items = extra.items.filter(i => i.kind !== "part").map(i => ({...i, id: i.id + "-p"}));
  added.documents.push(extra);
  const ad = M.create(base, added); await ad.run({});
  const sheetRow = ad.changes.find(c => c.objectKind === "document" && c.status === "added");
  if (sheetRow) {
    assert.ok(ad.wholeCount(sheetRow.doc) > 0);
    assert.equal(ad.filter({}).filter(c => c.doc === sheetRow.doc).length, 1, "only the document row");
    assert.ok(ad.filter({expanded: new Set([sheetRow.doc])}).filter(c => c.doc === sheetRow.doc).length > 1, "expanded shows its objects");
  }
  assert.ok(Array.isArray(ad.warnings) && Array.isArray(ad.headline));

  // ---- adapter on unexpected engine rows
  const odd = M.fromEngine({changes: [null, {kind: "part.moved", severity: "mechanical", target: {doc: "d", id: "x", ref: "R9"}, text: "R9 moved",
    geometry: {doc: "d", box: [0, 0, 1, 1], before: {box: [0, 0, 1, 1]}, after: {box: [2, 0, 3, 1]}}}, {kind: "weird", severity: "?", target: null, before: [1], after: {a: 1}}]}, null, null);
  assert.equal(odd.length, 2);
  assert.deepEqual([odd[0].status, odd[0].severity, odd[0].move], ["moved", "layout", {dx: 2, dy: 0}]);
  assert.equal(odd[1].severity, "layout");

  // ---- kinds without geometry read as words (signals, tags, waivers, rules), never "NetClasss"
  for (const [k, want] of [["netTag", "Net tags"], ["netClass", "Net classes"], ["signal", "Signals"], ["waiver", "Waivers"], ["componentClass", "Component classes"],
    ["fooBox", "Foo boxes"], ["glass", "Glasses"]]) assert.equal(M.kindLabel(k), want, k);
  const kinds = M.fromEngine({changes: [
    {kind: "signal.added", severity: "electrical", target: {type: "signal", id: "s1", name: "USB", doc: "b"}, text: "Signal USB added"},
    {kind: "netTag.changed", severity: "electrical", target: {type: "net", id: "VBUS", net: "VBUS", doc: "b"}, text: "Net VBUS tags +power"},
    {kind: "library.resolved", severity: "electrical", target: {type: "part", id: "u9", ref: "U9", doc: "b"}, before: null, after: {family: "LDO", map: {1: "1"}}, text: "U9 LDO placeholder → TLV733"},
    {kind: "library.model3d", severity: "cosmetic", target: {type: "project", id: null, name: "body.step"}, before: null, after: {sha256: "ab", name: "body.step"}, text: "3D model body.step added"}]}, null, null);
  assert.deepEqual(kinds.map(c => c.objectKind), ["signal", "netTag", "library", "library"]);
  assert.deepEqual(kinds.map(c => c.nets), [[], ["VBUS"], [], []], "a net tag row filters by its net");
  assert.equal(kinds[2].item, "u9", "a resolved placeholder is the placed part (the view outlines it)");
  assert.equal(kinds[3].doc, null, "a 3D model row is project-wide");
  // ---- lookups the view makes per keystroke are indexed (a 5k-change list steps in a frame)
  assert.equal(m.byId(mv.id), mv);
  assert.equal(m.byId("nope"), null);
  const big = M.create(base, P1);
  const rows = Array.from({length: 5000}, (_, k) => ({id: "r" + k, key: "k" + k, ref: "R" + (k % 49), doc: k % 2 ? "sch" : "pcb", docKind: k % 2 ? "schematic" : "pcb", objectKind: "part", severity: "layout", status: "moved", nets: []}));
  big.add(rows, null);
  assert.equal(big.byId("r4999"), rows[4999]);
  const t0 = Date.now();
  for (let k = 0; k < 2000; k++) big.linked(rows[k]);
  assert.equal(big.linked(rows[0]).length, rows.filter(x => x.ref === "R0" && x.docKind === "schematic").length, "cross-probe by designator over the other document kind");
  assert.ok(big.linked(rows[0]).length > 40);
  assert.ok(Date.now() - t0 < 1500, "linked() uses the designator index");

  // ---- export rows (pure) and escaping
  const L = AtriumDiffExport.lines({model: m});
  assert.equal(L.rows.length, m.changes.length);
  assert.ok(M.SEVERITIES.includes(L.rows[0][0]) && L.rows[0][5] === 1, "numbered rows");
  assert.equal(AtriumDiffExport.esc("<img src=x onerror='a'>&\""), "&lt;img src=x onerror=&#39;a&#39;&gt;&amp;&quot;");

  // ---- the view and the report never build markup from design text
  for (const f of ["diff-view.js", "diff-export.js", "diff-model.js"]) {
    const src = fs.readFileSync(require("../support/app-source-paths.cjs").appFileFrom(APP, f), "utf8");
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write\(/.test(src), f + " writes no HTML into the page");
    assert.ok(!/\beval\(|new Function\(/.test(src), f + " evaluates no code");
  }

  // ---- Compare and Review Changes use the lazy comparison viewer.
  require(path.join(APP, "lazy.js"));
  assert.deepEqual(AtriumLazy.forAction("diff-compare", "pcb"), ["AtriumDiffView"]);
  assert.deepEqual(AtriumLazy.forAction("diff-compare-with", "schematic"), ["AtriumDiffView"]);
  assert.deepEqual(AtriumLazy.forAction("review-changes", "pcb"), ["AtriumGitPicker"]);
  const files = AtriumLazy.files();
  for (const f of ["history/diff-model.js", "history/diff-view.js", "formats/diff-export.js"]) assert.ok(files.includes(f), f + " is registered lazily");
  assert.ok(files.indexOf("history/diff.js") < files.indexOf("history/diff-model.js") && files.indexOf("history/diff-model.js") < files.indexOf("history/diff-view.js"), "the engine loads first");
  assert.ok(!fs.existsSync(path.join(APP, "diff-core.js")) && !files.includes("diff-core.js"), "one diff engine");
  // Signals compare as models in the page, the worker, MCP and VS Code alike (never as a raw project field in one of them).
  assert.ok(files.indexOf("core/signals.js") >= 0 && files.indexOf("core/signals.js") < files.indexOf("history/diff.js"), "signals.js loads with the engine");
  assert.match(fs.readFileSync(path.join(APP, "workers/diff-worker.js"), "utf8"), /importScripts\([^)]*"\.\.\/core\/signals\.js"[^)]*"\.\.\/history\/diff\.js"\)/, "the worker compares signals too");
  assert.match(fs.readFileSync(path.join(__dirname, "../../mcp/commands.py"), "utf8"), /"diff": _mod\("history\/diff",[^)]*"signals"\)/, "and MCP diff_designs");
  assert.equal(typeof AtriumDiff.warm, "function", "the view warms the worker while it paints");
  assert.equal(AtriumDiff.warm(base, P1), false, "small designs compare in slices: no worker");
  const html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  assert.ok(!/<script src="(?:history\/diff-(?:model|view)|formats\/diff-export)\.js">/.test(html), "no diff code loads at startup");
  assert.ok(html.includes('data-action="diff-compare"'), "Project › Compare…");
  console.log("diff-ui: ok");
})().catch(e => { console.error(e); throw e; });
